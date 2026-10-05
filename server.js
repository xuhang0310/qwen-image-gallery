const express = require("express");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const multer = require("multer");
const sharp = require("sharp");
const { Readable } = require("node:stream");
const { pipeline } = require("node:stream/promises");
const { createStorage } = require("./lib/storage");
const { createSetup, loadRuntime } = require("./lib/setup");
const { configureNetwork } = require("./lib/network");
const { createApiImages } = require("./lib/api-images");
const { createVideos } = require("./lib/videos");
const {
  videoQualities,
  videoRatios,
  safeVideoUrl,
} = require("./shared/video.mjs");
const { imageProfile } = require("./shared/image-models.mjs");
const defaults = require("./shared/config.json");
const overrides = process.env.WORKBENCH_CONFIG
  ? JSON.parse(fs.readFileSync(process.env.WORKBENCH_CONFIG, "utf8"))
  : {};
const config = {
  ...defaults,
  ...overrides,
  models: { ...defaults.models, ...overrides.models },
  sampler: { ...defaults.sampler, ...overrides.sampler },
};

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 1, fields: 0, parts: 1 },
});

const app = express();
const PORT = Number(process.env.PORT || config.port);
const WORKFLOW = JSON.parse(
  fs.readFileSync(path.join(__dirname, "workflows", "qwen-image.json"), "utf8"),
);
const DATA_DIR = path.resolve(
  process.env.DATA_DIR || path.join(__dirname, ".data"),
);
const runtime = loadRuntime(DATA_DIR, {
  ...config,
  comfyUrl: process.env.COMFYUI_BASE_URL || config.comfyUrl,
});
let COMFYUI_BASE_URL = runtime.comfyUrl.replace(/\/$/, "");
configureNetwork(runtime.proxyUrl);
const storage = createStorage(DATA_DIR);
const thumbnailDir = path.join(DATA_DIR, "thumbnails");
fs.mkdirSync(thumbnailDir, { recursive: true });
const thumbnailTasks = new Map();
const REQUEST_TIMEOUT = Number(
  process.env.COMFY_TIMEOUT_MS || config.requestTimeoutMs,
);

const PRESETS = config.ratios;

app.disable("x-powered-by");
app.use(express.json({ limit: "16mb" }));
app.use("/api", (req, res, next) => {
  if (!["127.0.0.1", "localhost", "[::1]"].includes(req.hostname))
    return res.status(403).json({ error: "仅允许通过本机地址访问工作台" });
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
  const origin = req.get("origin");
  if (
    req.get("sec-fetch-site") === "cross-site" ||
    (origin && origin !== `http://${req.get("host")}`)
  )
    return res.status(403).json({ error: "仅允许从本机工作台操作" });
  next();
});
app.use(
  express.static(path.join(__dirname, "dist"), { maxAge: "1h", index: false }),
);

function align(value) {
  return Math.max(64, Math.round(value / 8) * 8);
}

function getDimensions(ratio, quality) {
  const preset = PRESETS[ratio];
  if (!preset || !["1K", "2K", "4K"].includes(quality)) {
    throw new Error("不支持的比例或清晰度");
  }
  const [width, height] = quality === "1K" ? preset["1K"] : preset["2K"];
  const [finalWidth, finalHeight] =
    quality === "4K" ? preset["4K"] : [width, height];
  return {
    width: align(width),
    height: align(height),
    finalWidth: align(finalWidth),
    finalHeight: align(finalHeight),
    isUpscaled: quality === "4K",
  };
}

function cleanText(value, maxLength) {
  return String(value ?? "")
    .trim()
    .slice(0, maxLength);
}

function validSourceImage(image) {
  return (
    image?.type === "input" &&
    image.subfolder === "qwen-workbench" &&
    typeof image.name === "string" &&
    /^[a-zA-Z0-9_-]+(?: \(\d+\))?\.(png|jpg|webp)$/.test(image.name)
  );
}

const apiImages = createApiImages({
  app,
  dataDir: DATA_DIR,
  storage,
  readComfySource: async (source, signal) => {
    if (!validSourceImage(source)) throw new Error("参考图无效，请重新上传");
    return withComfy(
      "/view?" + imageQuery({ filename: source.name, ...source }),
      { signal },
      async (response) => {
        if (!response.ok)
          throw new Error("参考图无法读取，请重新上传或启动本地引擎");
        const buffer = Buffer.from(await response.arrayBuffer());
        if (buffer.length > 50 * 1024 * 1024)
          throw new Error("参考图过大，请缩小后重新上传");
        return buffer;
      },
    );
  },
});

function createWorkflow({
  prompt,
  negativePrompt,
  ratio,
  quality,
  seed,
  mode,
  sourceImage,
}) {
  const dimensions = getDimensions(ratio, quality);
  const workflow = structuredClone(WORKFLOW);
  workflow["3"].inputs.text = prompt;
  workflow["4"].inputs.text = negativePrompt || "";
  workflow["1"].inputs.unet_name = config.models.unet;
  workflow["2"].inputs.clip_name = config.models.clip;
  workflow["7"].inputs.vae_name = config.models.vae;
  workflow["10"].inputs.model_name = config.models.upscale;
  Object.assign(workflow["6"].inputs, {
    steps: config.sampler.steps,
    cfg: negativePrompt
      ? Math.max(1.01, config.sampler.negativeCfg)
      : config.sampler.cfg,
    sampler_name: config.sampler.name,
    scheduler: config.sampler.scheduler,
  });
  workflow["5"].inputs.width = dimensions.width;
  workflow["5"].inputs.height = dimensions.height;
  workflow["6"].inputs.seed = Number.isSafeInteger(seed)
    ? seed
    : crypto.randomInt(0, 2147483647);
  workflow["9"].inputs.filename_prefix =
    `qwen-workbench/${crypto.randomUUID()}`;

  if (mode === "img2img") {
    workflow["13"] = {
      class_type: "LoadImage",
      inputs: { image: `${sourceImage.subfolder}/${sourceImage.name}` },
    };
    workflow["14"] = {
      class_type: "ImageScale",
      inputs: {
        image: ["13", 0],
        upscale_method: "lanczos",
        width: dimensions.width,
        height: dimensions.height,
        crop: "center",
      },
    };
    workflow["15"] = {
      class_type: "TextEncodeQwenImage21",
      inputs: {
        clip: ["2", 0],
        prompt,
        negative_prompt: negativePrompt,
        vae: ["7", 0],
        resolution: 0,
        "images.image_1": ["14", 0],
      },
    };
    workflow["6"].inputs.positive = ["15", 0];
    workflow["6"].inputs.negative = ["15", 1];
    workflow["6"].inputs.latent_image = ["15", 2];
    workflow["6"].inputs.denoise = 1;
    // Native editing rounds reference dimensions to multiples of 32.
    if (
      !dimensions.isUpscaled &&
      (dimensions.width % 32 || dimensions.height % 32)
    ) {
      workflow["16"] = {
        class_type: "ImageScale",
        inputs: {
          image: ["8", 0],
          upscale_method: "lanczos",
          width: dimensions.finalWidth,
          height: dimensions.finalHeight,
          crop: "disabled",
        },
      };
      workflow["9"].inputs.images = ["16", 0];
    }
  }

  if (dimensions.isUpscaled) {
    workflow["12"].inputs.width = dimensions.finalWidth;
    workflow["12"].inputs.height = dimensions.finalHeight;
    workflow["9"].inputs.images = ["12", 0];
  } else {
    delete workflow["10"];
    delete workflow["11"];
    delete workflow["12"];
  }

  return { workflow, dimensions, seed: workflow["6"].inputs.seed };
}

function errorText(body) {
  const error = body?.error;
  const message =
    typeof error === "string"
      ? error
      : error?.message || body?.message || "ComfyUI 请求失败";
  const details = [
    error?.details,
    ...Object.entries(body?.node_errors || {}).flatMap(([id, node]) =>
      (node.errors || []).map(
        (e) =>
          "节点 " +
          id +
          "：" +
          e.message +
          (e.details ? " · " + e.details : ""),
      ),
    ),
  ];
  return [message, ...details.filter(Boolean)].join("；").slice(0, 4000);
}

async function withComfy(endpoint, options, consume) {
  const controller = new AbortController();
  const { timeout = REQUEST_TIMEOUT, ...fetchOptions } = options || {};
  const timer = setTimeout(() => controller.abort(), timeout);
  const signal = fetchOptions.signal
    ? AbortSignal.any([controller.signal, fetchOptions.signal])
    : controller.signal;
  try {
    const response = await fetch(COMFYUI_BASE_URL + endpoint, {
      ...fetchOptions,
      signal,
      headers: { Accept: "application/json", ...fetchOptions.headers },
    });
    return await consume(response, signal);
  } finally {
    clearTimeout(timer);
  }
}

async function comfyJson(endpoint, options = {}) {
  return withComfy(endpoint, options, async (response) => {
    const text = await response.text();
    let body;
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      throw new Error("ComfyUI 返回了无效的 JSON：" + text.slice(0, 200));
    }
    if (!response.ok) throw new Error(errorText(body));
    return body;
  });
}

function findImages(historyEntry) {
  const images = [];
  for (const output of Object.values(historyEntry?.outputs || {})) {
    for (const image of output?.images || []) {
      if (image?.filename) images.push(image);
    }
  }
  return images;
}

function normalizeHistory(promptId, historyEntry) {
  if (!historyEntry) return { promptId, status: "queued", images: [] };
  const status = historyEntry.status || {};
  const errorMessage = (status.messages || []).find((message) =>
    ["execution_error", "execution_interrupted"].includes(message?.[0]),
  );
  if (errorMessage) {
    const details = errorMessage[1] || {};
    return {
      promptId,
      status:
        errorMessage[0] === "execution_interrupted" ? "cancelled" : "failed",
      error:
        details.exception_message ||
        details.message ||
        (errorMessage[0] === "execution_interrupted"
          ? "任务已取消"
          : "ComfyUI 执行失败"),
      images: [],
    };
  }
  const images = findImages(historyEntry);
  if (status.completed && !images.length) {
    return {
      promptId,
      status: "failed",
      images: [],
      error: "任务已结束，但没有输出图片，请检查保存节点",
    };
  }
  if (status.completed || images.length > 0) {
    return { promptId, status: "completed", images };
  }
  return { promptId, status: "running", images: [] };
}

function imageQuery(image) {
  const params = new URLSearchParams({
    filename: image.filename,
    subfolder: image.subfolder || "",
    type: image.type || "output",
  });
  return params.toString();
}

const setupService = createSetup({
  app,
  config,
  dataDir: DATA_DIR,
  runtime,
  applyRuntime: (value) => {
    COMFYUI_BASE_URL = value.comfyUrl;
    configureNetwork(value.proxyUrl);
  },
  comfyJson,
  busy: () => false,
  verify: async (signal, log) => {
    const prompt =
      "一只红色陶瓷马克杯放在浅灰色桌面上，背景干净，柔和自然光，产品摄影，不要文字";
    const parameters = {
      prompt,
      negativePrompt: "",
      ratio: "1:1",
      quality: "1K",
      mode: "txt2img",
    };
    const { workflow, dimensions, seed } = createWorkflow(parameters);
    const startedAt = Date.now();
    const submitted = await comfyJson("/prompt", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt: workflow,
        client_id: "qwen-workbench-setup",
      }),
    });
    const id = submitted.prompt_id;
    if (!id) throw new Error(errorText(submitted));
    const metadata = {
      id,
      promptId: id,
      ...parameters,
      seed,
      dimensions,
      createdAt: startedAt,
      purpose: "setup-verification",
    };
    storage.put(id, { ...metadata, status: "queued" });
    log("已提交验证任务，正在加载模型与生成图片…");
    let finished = false;
    try {
      for (let attempt = 0; attempt < 600; attempt++) {
        signal.throwIfAborted();
        const history = await comfyJson("/history/" + encodeURIComponent(id));
        if (history[id]) {
          const result = normalizeHistory(id, history[id]);
          if (["failed", "cancelled"].includes(result.status))
            throw new Error(result.error);
          if (result.status === "completed") {
            finished = true;
            const image = result.images[0];
            const query = imageQuery(image);
            const imageUrls = result.images.map((value) => ({
              ...value,
              url: "/api/images/view?" + imageQuery(value),
              thumbnailUrl:
                "/api/images/view?" + imageQuery(value) + "&thumbnail=1",
              downloadUrl: "/api/images/download?" + imageQuery(value),
            }));
            storage.put(id, { ...metadata, ...result, imageUrls });
            const info = await withComfy(
              "/view?" + query,
              {},
              async (response) => {
                if (!response.ok) throw new Error("生成图片无法读取");
                const chunks = [];
                let bytes = 0;
                for await (const chunk of response.body) {
                  signal.throwIfAborted();
                  bytes += chunk.length;
                  if (bytes > 20 * 1024 * 1024)
                    throw new Error("验证图片文件异常过大");
                  chunks.push(chunk);
                }
                const buffer = Buffer.concat(chunks);
                const decoder = sharp(buffer, {
                  limitInputPixels: 4 * 1024 * 1024,
                  failOn: "warning",
                });
                const metadata = await decoder.metadata();
                await decoder.raw().toBuffer();
                if (metadata.width !== 1024 || metadata.height !== 1024)
                  throw new Error("生成图片的尺寸与验证参数不一致");
                return metadata;
              },
            );
            return {
              promptId: id,
              imageUrl: "/api/images/view?" + query,
              prompt,
              width: info.width,
              height: info.height,
              elapsedMs: Date.now() - startedAt,
            };
          }
        }
        await new Promise((resolve, reject) => {
          const abort = () => {
            clearTimeout(timer);
            reject(signal.reason);
          };
          const timer = setTimeout(() => {
            signal.removeEventListener("abort", abort);
            resolve();
          }, 2000);
          signal.addEventListener("abort", abort, { once: true });
          if (signal.aborted) abort();
        });
      }
      throw new Error(
        "试生成超过 20 分钟，已请求取消本次验证任务。请检查显存、驱动与引擎日志。",
      );
    } catch (error) {
      storage.put(id, {
        ...metadata,
        status: signal.aborted ? "cancelled" : "failed",
        error: error.message || "验证已取消",
      });
      throw error;
    } finally {
      if (!finished) {
        const body = (value) => ({
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(value),
        });
        await comfyJson("/queue", body({ delete: [id] })).catch(() => {});
        await comfyJson("/interrupt", body({ prompt_id: id })).catch(() => {});
      }
    }
  },
});

app.get("/api/health", async (_req, res) => {
  if (_req.query.provider === "api")
    return res.json({ ...(await apiImages.connection()), provider: "api" });
  try {
    const [stats, queue] = await Promise.all([
      comfyJson("/system_stats"),
      comfyJson("/queue").catch(() => ({
        queue_running: [],
        queue_pending: [],
      })),
    ]);
    res.json({
      connected: true,
      version: stats.system?.comfyui_version || "unknown",
      device: stats.devices?.[0]?.name || "NVIDIA GPU",
      vramFree: stats.devices?.[0]?.vram_free || null,
      queue:
        (queue.queue_running || []).length + (queue.queue_pending || []).length,
    });
  } catch (error) {
    res.json({
      connected: false,
      error: error.name === "AbortError" ? "ComfyUI 响应超时" : error.message,
    });
  }
});

app.post("/api/upload", (req, res) => {
  upload.single("image")(req, res, async (error) => {
    if (error)
      return res.status(error.code === "LIMIT_FILE_SIZE" ? 413 : 400).json({
        error:
          error.code === "LIMIT_FILE_SIZE"
            ? "图片不能超过 10MB"
            : "请上传单张图片，不要附带其他字段",
      });
    if (!req.file) return res.status(400).json({ error: "请选择一张图片" });
    let buffer;
    let metadata;
    try {
      const image = sharp(req.file.buffer, {
        limitInputPixels: 24000000,
        failOn: "warning",
      });
      metadata = await image.metadata();
      if (
        !["png", "jpeg", "webp"].includes(metadata.format) ||
        (metadata.pages || 1) > 1
      ) {
        return res
          .status(400)
          .json({ error: "仅支持静态 PNG、JPEG 或 WebP 图片" });
      }
      const normalized = await image
        .rotate()
        .png()
        .toBuffer({ resolveWithObject: true });
      buffer = normalized.data;
      metadata = normalized.info;
    } catch {
      return res
        .status(400)
        .json({ error: "图片损坏或超过 2400 万像素，请换一张图片" });
    }
    try {
      const sourceImage = await apiImages.saveInput(buffer, metadata);
      res.status(201).json({
        sourceImage,
        previewUrl: `/api/images/view?${imageQuery({ filename: sourceImage.name, ...sourceImage })}&provider=api`,
      });
    } catch (error) {
      res.status(500).json({ error: `保存参考图失败：${error.message}` });
    }
  });
});

app.post("/api/generate", async (req, res) => {
  const provider = req.body?.provider ?? apiImages.publicSettings().provider;
  if (!["local", "api"].includes(provider))
    return res.status(400).json({ error: "生成引擎无效" });
  if (provider === "local" && setupService.isBusy())
    return res
      .status(409)
      .json({ error: "环境配置操作正在执行，请等待完成后再生成" });
  if (
    !req.body ||
    typeof req.body !== "object" ||
    Array.isArray(req.body) ||
    typeof req.body.prompt !== "string"
  )
    return res.status(400).json({ error: "请提交有效的生成参数" });
  if (
    req.body.negativePrompt !== undefined &&
    typeof req.body.negativePrompt !== "string"
  )
    return res.status(400).json({ error: "反向提示词必须是文本" });
  if (
    req.body.seed !== undefined &&
    (typeof req.body.seed !== "number" ||
      !Number.isSafeInteger(req.body.seed) ||
      req.body.seed < 0 ||
      req.body.seed > 2147483647)
  )
    return res.status(400).json({ error: "种子必须是 0–2147483647 的整数" });
  const prompt = cleanText(req.body.prompt, 4000);
  const negativePrompt = cleanText(req.body.negativePrompt, 2000);
  const ratio = cleanText(req.body.ratio, 10);
  const quality = cleanText(req.body.quality, 4);
  const requestedSeed = Number(req.body.seed);
  const mode = req.body.mode ?? "txt2img";
  const sourceImage = mode === "img2img" ? req.body.sourceImage : undefined;
  if (!prompt) return res.status(400).json({ error: "请先写下正向提示词" });
  if (!["txt2img", "img2img"].includes(mode))
    return res.status(400).json({ error: "生成模式无效" });
  if (
    provider === "local" &&
    (!Object.hasOwn(PRESETS, ratio) || !["1K", "2K", "4K"].includes(quality))
  )
    return res.status(400).json({ error: "不支持的比例或清晰度" });
  if (
    mode === "img2img" &&
    !validSourceImage(sourceImage) &&
    !apiImages.validSource(sourceImage)
  ) {
    return res.status(400).json({ error: "请先上传原图" });
  }

  if (provider === "api") {
    try {
      return res.status(202).json(
        apiImages.submit({
          prompt,
          negativePrompt,
          ratio,
          quality,
          mode,
          sourceImage,
          model: req.body.model,
        }),
      );
    } catch (error) {
      return res.status(400).json({ error: error.message });
    }
  }

  try {
    let comfySource = sourceImage;
    if (mode === "img2img" && apiImages.validSource(sourceImage)) {
      const buffer = await apiImages.sourceBuffer(sourceImage);
      const form = new FormData();
      form.append(
        "image",
        new Blob([buffer], { type: "image/png" }),
        sourceImage.name,
      );
      form.append("subfolder", "qwen-workbench");
      form.append("type", "input");
      form.append("overwrite", "false");
      comfySource = await comfyJson("/upload/image", {
        method: "POST",
        body: form,
      });
      if (!validSourceImage(comfySource))
        throw new Error("ComfyUI 返回了无效的参考图信息");
    }
    const seed =
      Number.isSafeInteger(requestedSeed) && requestedSeed >= 0
        ? requestedSeed
        : undefined;
    const {
      workflow,
      dimensions,
      seed: finalSeed,
    } = createWorkflow({
      prompt,
      negativePrompt,
      ratio,
      quality,
      seed,
      mode,
      sourceImage: comfySource,
    });
    const body = await comfyJson("/prompt", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt: workflow,
        client_id: "qwen-image-gallery",
      }),
    });
    if (!body.prompt_id) throw new Error("ComfyUI 没有返回任务编号");
    if (body.node_errors && Object.keys(body.node_errors).length) {
      throw new Error(`工作流节点错误：${JSON.stringify(body.node_errors)}`);
    }
    const metadata = {
      provider: "local",
      model: config.models.unet,
      prompt,
      negativePrompt,
      ratio,
      quality,
      mode,
      sourceImage,
      dimensions,
      seed: finalSeed,
      createdAt: Date.now(),
    };
    storage.put(body.prompt_id, {
      id: body.prompt_id,
      status: "queued",
      ...metadata,
    });
    res.status(202).json({ promptId: body.prompt_id, ...metadata });
  } catch (error) {
    const message =
      error.name === "AbortError"
        ? "ComfyUI 响应超时，请检查服务是否运行"
        : error.message;
    res.status(502).json({ error: message });
  }
});

app.get("/api/config", (_req, res) =>
  res.json({
    ratios: config.ratios,
    qualities: config.qualities,
    sampler: config.sampler,
    models: config.models,
    engine: apiImages.publicSettings(),
  }),
);
app.get("/api/jobs", (_req, res) =>
  res.json({ jobs: storage.list().filter((job) => job.mediaType !== "video") }),
);

app.get("/api/jobs/:promptId", async (req, res) => {
  const promptId = cleanText(req.params.promptId, 100);
  const metadata = storage.get(promptId);
  if (metadata?.mediaType === "video")
    return res.status(400).json({ error: "请使用视频任务接口" });
  if (metadata?.provider === "api") return res.json({ promptId, ...metadata });
  if (metadata?.status === "cancelled")
    return res.json({ promptId, ...metadata, images: [] });
  try {
    const history = await comfyJson("/history/" + encodeURIComponent(promptId));
    let result;
    if (history[promptId])
      result = normalizeHistory(promptId, history[promptId]);
    else {
      const queue = await comfyJson("/queue");
      if ((queue.queue_running || []).some((item) => item[1] === promptId))
        result = { promptId, status: "running", images: [] };
      else if ((queue.queue_pending || []).some((item) => item[1] === promptId))
        result = { promptId, status: "queued", images: [] };
      else if (metadata && ["completed", "failed"].includes(metadata.status))
        result = { ...metadata, promptId };
      else if (
        metadata &&
        Date.now() - metadata.createdAt < config.missingGraceMs
      )
        result = { promptId, status: "queued", images: [], syncing: true };
      else
        result = {
          promptId,
          status: "failed",
          images: [],
          error: "任务已不存在，可能已被清除或引擎已重启",
          code: "JOB_MISSING",
        };
    }
    // A status request may finish after cancellation; never overwrite that terminal state.
    const latest = storage.get(promptId);
    if (latest?.status === "cancelled") return res.json(latest);
    result = { ...metadata, ...result };
    if (result.images?.length)
      result.imageUrls = result.images.map((image) => ({
        ...image,
        url: "/api/images/view?" + imageQuery(image),
        thumbnailUrl: "/api/images/view?" + imageQuery(image) + "&thumbnail=1",
        downloadUrl: "/api/images/download?" + imageQuery(image),
      }));
    if (metadata && JSON.stringify(result) !== JSON.stringify(metadata))
      storage.put(promptId, { ...result, id: promptId });
    res.json(result);
  } catch (error) {
    res.status(502).json({
      promptId,
      error:
        error.name === "AbortError"
          ? "读取状态超时，正在等待重试"
          : error.message,
      recoverable: true,
    });
  }
});

app.post("/api/jobs/:promptId/cancel", async (req, res) => {
  const id = cleanText(req.params.promptId, 100);
  const job = storage.get(id);
  if (!job) return res.status(404).json({ error: "任务不存在" });
  if (job.mediaType === "video")
    return res.status(400).json({ error: "请使用视频任务接口" });
  if (["completed", "failed", "cancelled"].includes(job.status))
    return res.status(409).json({ error: "任务已经结束" });
  if (job.provider === "api") return res.json(apiImages.cancel(job));
  try {
    // Targeted interruption never stops a task belonging to another application.
    await comfyJson("/queue", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ delete: [id] }),
    });
    await comfyJson("/interrupt", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt_id: id }),
    });
    storage.put(id, { ...job, status: "cancelled", error: "任务已取消" });
    res.json({ status: "cancelled" });
  } catch (error) {
    res.status(502).json({ error: error.message });
  }
});

app.get("/api/project", (_req, res) => res.json(storage.project()));
app.put("/api/project", (req, res) => {
  try {
    const project = validateProject(req.body);
    const revision = storage.saveProject(project, req.body.revision);
    if (revision === null)
      return res.status(409).json({
        error: "项目已在另一个窗口更新，请导出当前项目后重新载入",
        code: "REVISION_CONFLICT",
      });
    videos.restoreJobs(project.videoJobs);
    res.json({ revision });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

function validateProject(value) {
  if (
    !value ||
    !Number.isInteger(value.revision) ||
    !value.board ||
    !Array.isArray(value.jobs) ||
    !Array.isArray(value.board.nodes) ||
    !Array.isArray(value.board.edges)
  )
    throw new Error("项目格式不正确");
  if (
    value.jobs.length > 10000 ||
    value.board.nodes.length > 10000 ||
    value.board.edges.length > 20000
  )
    throw new Error("项目超过容量限制");
  const board = value.board;
  if (
    !Number.isFinite(board.zoom) ||
    board.zoom < 0.1 ||
    board.zoom > 4 ||
    !Number.isFinite(board.pan?.x) ||
    !Number.isFinite(board.pan?.y)
  )
    throw new Error("画布位置无效");
  const ids = new Set();
  for (const node of board.nodes) {
    if (
      typeof node.id !== "string" ||
      node.id.length > 100 ||
      ids.has(node.id) ||
      !Number.isFinite(node.x) ||
      !Number.isFinite(node.y) ||
      !["done", "loading", "failed", "empty", "text"].includes(node.status)
    )
      throw new Error("节点格式不正确");
    if (
      node.url &&
      !(node.kind === "video" ? safeVideoUrl(node.url) : safeImageUrl(node.url))
    )
      throw new Error("媒体地址不正确");
    if (
      node.kind === "video" &&
      node.downloadUrl &&
      !safeVideoUrl(node.downloadUrl)
    )
      throw new Error("视频下载地址不正确");
    if (
      node.kind === "video-generator" &&
      (!Object.hasOwn(videoQualities, node.quality) ||
        !Object.hasOwn(videoRatios, node.ratio) ||
        typeof node.dialogue !== "string" ||
        node.dialogue.length > 200)
    )
      throw new Error("视频节点参数不正确");
    if (
      node.prompt != null &&
      (typeof node.prompt !== "string" || node.prompt.length > 4000)
    )
      throw new Error("节点提示词过长");
    ids.add(node.id);
  }
  if (
    board.edges.some(
      (e) =>
        typeof e.id !== "string" ||
        !ids.has(e.from) ||
        !ids.has(e.to) ||
        e.from === e.to ||
        !["left", "right"].includes(e.fromSide) ||
        !["left", "right"].includes(e.toSide),
    )
  )
    throw new Error("连线格式不正确");
  for (const job of value.jobs) {
    const jobConfig =
      job.provider === "api"
        ? imageProfile(job.model || "gpt-image-2")
        : config;
    if (
      typeof job.id !== "string" ||
      typeof job.prompt !== "string" ||
      !Number.isFinite(job.createdAt) ||
      !jobConfig ||
      !Object.hasOwn(jobConfig.ratios, job.ratio) ||
      !Object.hasOwn(jobConfig.qualities, job.quality) ||
      !["queued", "running", "completed", "failed", "cancelled"].includes(
        job.status,
      )
    )
      throw new Error("历史记录格式不正确");
    if (
      [job.imageUrl, job.thumbnailUrl, job.downloadUrl].some(
        (url) => url && !safeImageUrl(url),
      )
    )
      throw new Error("历史图片地址不正确");
  }
  return {
    jobs: value.jobs,
    videoJobs: Array.isArray(value.videoJobs)
      ? value.videoJobs
          .filter(
            (job) =>
              job?.mediaType === "video" &&
              typeof job.id === "string" &&
              Object.hasOwn(videoQualities, job.quality) &&
              (job.ratio === undefined ||
                Object.hasOwn(videoRatios, job.ratio)) &&
              (!job.videoUrl || safeVideoUrl(job.videoUrl)) &&
              (!job.downloadUrl || safeVideoUrl(job.downloadUrl)),
          )
          .slice(0, 10000)
      : [],
    board,
    hiddenJobIds: Array.isArray(value.hiddenJobIds)
      ? value.hiddenJobIds.filter((id) => typeof id === "string")
      : [],
  };
}
function safeImageUrl(url) {
  return (
    typeof url === "string" &&
    /^\/api\/images\/(view|download)\?/.test(url) &&
    !/[\r\n]/.test(url)
  );
}

async function proxyImage(req, res, download) {
  if (req.query.provider === "api")
    return apiImages.serveImage(req, res, download);
  if (req.query.provider && req.query.provider !== "local")
    return res.status(400).json({ error: "图片引擎无效" });
  const filename = cleanText(req.query.filename, 255);
  const subfolder = cleanText(req.query.subfolder, 255);
  const type = cleanText(req.query.type || "output", 20);
  if (
    !filename ||
    /[\/\\]/.test(filename) ||
    filename.includes("..") ||
    subfolder.includes("..") ||
    subfolder.includes("\\") ||
    !["output", "temp", "input"].includes(type)
  )
    return res.status(400).json({ error: "图片参数无效" });
  const params = new URLSearchParams({ filename, subfolder, type });
  try {
    if (!download && req.query.thumbnail === "1") {
      const key = crypto
        .createHash("sha256")
        .update(COMFYUI_BASE_URL + params.toString())
        .digest("hex");
      const target = path.join(thumbnailDir, key + ".webp");
      if (!fs.existsSync(target)) {
        if (!thumbnailTasks.has(key))
          thumbnailTasks.set(
            key,
            withComfy("/view?" + params, {}, async (response, signal) => {
              if (!response.ok) throw new Error("图片不存在");
              const temp = target + ".tmp";
              try {
                await pipeline(
                  Readable.fromWeb(response.body),
                  sharp({ limitInputPixels: 64000000 })
                    .resize({
                      width: 440,
                      height: 440,
                      fit: "inside",
                      withoutEnlargement: true,
                    })
                    .webp({ quality: 80 }),
                  fs.createWriteStream(temp),
                  { signal },
                );
                fs.renameSync(temp, target);
              } finally {
                if (fs.existsSync(temp)) fs.unlinkSync(temp);
              }
            }).finally(() => thumbnailTasks.delete(key)),
          );
        await thumbnailTasks.get(key);
      }
      res.set("Cache-Control", "private, max-age=86400");
      // The private cache lives in .data; Express otherwise hides dot directories.
      return res.sendFile(target, { dotfiles: "allow" });
    }
    await withComfy("/view?" + params, {}, async (response, signal) => {
      if (!response.ok) {
        await response.body?.cancel();
        return res.status(response.status).send("图片不存在");
      }
      res.set(
        "Content-Type",
        response.headers.get("content-type") || "image/png",
      );
      res.set("Cache-Control", "private, max-age=86400");
      if (download)
        res.set(
          "Content-Disposition",
          "attachment; filename*=UTF-8''" + encodeURIComponent(filename),
        );
      await pipeline(Readable.fromWeb(response.body), res, { signal });
    });
  } catch (error) {
    if (res.headersSent || res.destroyed) return res.destroy();
    res.status(502).json({ error: error.message });
  }
}

app.get("/api/images/view", (req, res) => proxyImage(req, res, false));
app.get("/api/images/download", (req, res) => proxyImage(req, res, true));

const videos = createVideos({
  app,
  storage,
  comfyJson,
  withComfy,
  apiImages,
  validSourceImage,
  isBusy: () => setupService.isBusy(),
  getComfyUrl: () => COMFYUI_BASE_URL,
});

app.use((req, res, next) => {
  if (req.method !== "GET" || req.path.startsWith("/api/")) return next();
  res.sendFile(path.join(__dirname, "dist", "index.html"));
});

app.use((error, _req, res, _next) => {
  res.status(error.status || 500).json({
    error:
      error.type === "entity.parse.failed"
        ? "请求 JSON 格式不正确"
        : error.type === "entity.too.large"
          ? "项目文件过大"
          : "请求处理失败",
  });
});
app.closeStorage = () => {
  videos.close();
  storage.close();
};

if (require.main === module) {
  app.listen(PORT, "127.0.0.1", () => {
    console.log(`Qwen Image 工作台：http://127.0.0.1:${PORT}`);
    console.log(`ComfyUI：${COMFYUI_BASE_URL}`);
  });
}

module.exports = app;
