const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const sharp = require("sharp");
const profile = require("../shared/api-image.json");
const {
  imageModel,
  imageModels,
  imageProfile,
  apiQualityValues,
} = require("../shared/image-models.mjs");

const active = (job) => ["queued", "running"].includes(job.status);
const filePattern =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.png$/;

function validateBaseUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("请输入完整的 API 地址，例如 https://api.openai.com/v1");
  }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (
    (url.protocol !== "https:" && !(loopback && url.protocol === "http:")) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error(
      "API 地址需使用 HTTPS；本机服务可使用 HTTP。请勿在地址中放入密钥或查询参数",
    );
  return url.href.replace(/\/+$/, "");
}

async function readJson(response, limit = 96 * 1024 * 1024) {
  if (Number(response.headers.get("content-length")) > limit) {
    await response.body?.cancel();
    throw new Error("API 返回内容超过大小限制");
  }
  let size = 0;
  const chunks = [];
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > limit) throw new Error("API 返回内容超过大小限制");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error(
      `API 返回了无法读取的内容（HTTP ${response.status}），请检查地址是否为 Images API`,
    );
  }
}

function createApiImages({ app, dataDir, storage, readComfySource }) {
  const configFile = path.join(dataDir, "api-engine.json");
  const imageDir = path.join(dataDir, "api-images");
  for (const dir of ["input", "output", "thumbnails"])
    fs.mkdirSync(path.join(imageDir, dir), { recursive: true });
  let settings = {
    provider: "local",
    model: "gpt-image-2",
    baseUrl: process.env.OPENAI_BASE_URL || "https://api.openai.com/v1",
    apiKey: "",
  };
  if (fs.existsSync(configFile)) {
    const saved = JSON.parse(fs.readFileSync(configFile, "utf8"));
    settings = { ...settings, ...saved };
  }
  settings.baseUrl = validateBaseUrl(settings.baseUrl);
  settings.model = imageModel(settings.model)?.id || "gpt-image-2";
  settings.discoveredModels = Array.isArray(settings.discoveredModels)
    ? settings.discoveredModels.filter((id) => imageModel(id)).slice(0, 100)
    : [];
  if (!["local", "api"].includes(settings.provider))
    settings.provider = "local";
  const environmentBaseUrl = validateBaseUrl(
    process.env.OPENAI_BASE_URL || "https://api.openai.com/v1",
  );
  const keyFor = (value) =>
    value.apiKey ||
    (value.baseUrl === environmentBaseUrl
      ? process.env.OPENAI_API_KEY || ""
      : "");
  const publicSettings = () => ({
    provider: settings.provider,
    model: settings.model,
    baseUrl: settings.baseUrl,
    keyConfigured: !!keyFor(settings),
    keySource: settings.apiKey
      ? "saved"
      : keyFor(settings)
        ? "environment"
        : "none",
    models: imageModels([...settings.discoveredModels, settings.model]),
    profile,
  });
  const redact = (message, key) => {
    let value = String(message || "API 请求失败");
    for (const secret of [key, keyFor(settings)])
      if (secret) value = value.split(secret).join("[已隐藏]");
    return value.replace(/sk-[\w-]+/g, "[已隐藏]").slice(0, 1000);
  };
  const update = (body) => {
    if (!body || typeof body !== "object" || Array.isArray(body))
      throw new Error("配置格式不正确");
    const next = { ...settings };
    if (body.provider !== undefined) {
      if (!["local", "api"].includes(body.provider))
        throw new Error("生成引擎无效");
      next.provider = body.provider;
    }
    if (body.model !== undefined) {
      if (!imageModel(body.model))
        throw new Error("仅支持 GPT Image 2 和 2.5 系列生图模型");
      next.model = imageModel(body.model).id;
    }
    if (body.baseUrl !== undefined) {
      if (typeof body.baseUrl !== "string")
        throw new Error("API 地址格式不正确");
      next.baseUrl = validateBaseUrl(body.baseUrl.trim());
      if (next.baseUrl !== settings.baseUrl) next.discoveredModels = [];
      if (
        next.baseUrl !== settings.baseUrl &&
        keyFor(settings) &&
        !body.apiKey &&
        !body.removeKey
      )
        throw new Error(
          "更换 API 地址时，请重新填写该服务的密钥或清除已保存的密钥",
        );
    }
    if (body.apiKey !== undefined) {
      if (
        typeof body.apiKey !== "string" ||
        /[\s\x00-\x1f\x7f]/.test(body.apiKey) ||
        body.apiKey.length > 4096
      )
        throw new Error("密钥格式不正确");
      if (body.apiKey) next.apiKey = body.apiKey;
    }
    if (body.removeKey === true) next.apiKey = "";
    const temp = configFile + ".tmp";
    fs.writeFileSync(temp, JSON.stringify(next, null, 2), { mode: 0o600 });
    fs.renameSync(temp, configFile);
    settings = next;
    return publicSettings();
  };

  async function call(snapshot, endpoint, options, signal) {
    if (!snapshot.apiKey) throw new Error("请在 API 配置中填写密钥");
    let response;
    try {
      response = await fetch(snapshot.baseUrl + endpoint, {
        ...options,
        redirect: "error",
        signal,
        headers: {
          ...options?.headers,
          Authorization: `Bearer ${snapshot.apiKey}`,
        },
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new Error("无法连接 API 服务，请检查地址、网络或本机代理设置");
    }
    const body = await readJson(response);
    if (!response.ok) {
      const hint =
        {
          401: "密钥无效或已过期",
          403: "该账户没有模型权限，请检查组织验证或服务授权",
          429: "请求限流或额度不足",
        }[response.status] || "服务请求失败";
      throw new Error(
        `${hint}（HTTP ${response.status}）${body.error?.message ? "：" + redact(body.error.message, snapshot.apiKey) : ""}`,
      );
    }
    return body;
  }
  const capture = (model) => ({
    baseUrl: settings.baseUrl,
    apiKey: keyFor(settings),
    model: imageModel(model || settings.model)?.id || model || settings.model,
  });
  async function connection() {
    const snapshot = capture();
    if (!snapshot.apiKey)
      return { connected: false, error: "请先填写 API 密钥" };
    try {
      const body = await call(
        snapshot,
        "/models",
        { method: "GET" },
        AbortSignal.timeout(20000),
      );
      const available = (Array.isArray(body.data) ? body.data : [])
        .map((model) => model.id)
        .filter((id) => imageModel(id));
      if (
        settings.baseUrl === snapshot.baseUrl &&
        keyFor(settings) === snapshot.apiKey
      ) {
        settings.discoveredModels = [...new Set(available)].slice(0, 100);
      }
      return {
        connected: available.includes(snapshot.model),
        model: snapshot.model,
        models: publicSettings().models,
        availableModels: available,
        error: available.includes(snapshot.model)
          ? undefined
          : "服务模型列表未包含所选模型，请检查权限或切换模型",
        message: "模型列表检查不产生图片；实际生图权限和额度以生成结果为准",
      };
    } catch (error) {
      return {
        connected: false,
        error: redact(
          error.name === "TimeoutError"
            ? "API 连接超时，请检查网络或代理"
            : error.message,
          snapshot.apiKey,
        ),
      };
    }
  }
  app.get("/api/engine", (_req, res) => {
    res.set("Cache-Control", "no-store");
    res.json(publicSettings());
  });
  app.post("/api/engine", (req, res) => {
    try {
      res.json(update(req.body));
    } catch (error) {
      res.status(400).json({ error: redact(error.message) });
    }
  });
  app.post("/api/engine/check", async (_req, res) =>
    res.json(await connection()),
  );

  const imageQuery = (image) =>
    new URLSearchParams({
      filename: image.name || image.filename,
      type: image.type,
      subfolder: "workbench-managed",
      provider: "api",
    });
  const validSource = (image) =>
    image?.provider === "api" &&
    image.type === "input" &&
    image.subfolder === "workbench-managed" &&
    filePattern.test(image.name);
  async function saveInput(buffer, metadata) {
    const name = crypto.randomUUID() + ".png";
    await fs.promises.writeFile(path.join(imageDir, "input", name), buffer);
    return {
      name,
      provider: "api",
      subfolder: "workbench-managed",
      type: "input",
      width: metadata.width,
      height: metadata.height,
    };
  }
  async function sourceBuffer(source, signal) {
    if (validSource(source)) {
      try {
        return await fs.promises.readFile(
          path.join(imageDir, "input", source.name),
          { signal },
        );
      } catch (error) {
        if (error.code === "ENOENT")
          throw new Error("参考图已不存在，请重新上传");
        throw error;
      }
    }
    return readComfySource(source, signal);
  }
  const thumbnails = new Map();
  async function serveImage(req, res, download) {
    const filename = req.query.filename;
    const type = req.query.type;
    if (
      req.query.subfolder !== "workbench-managed" ||
      !["input", "output"].includes(type) ||
      typeof filename !== "string" ||
      !filePattern.test(filename)
    )
      return res.status(400).json({ error: "图片参数无效" });
    const source = path.join(imageDir, type, filename);
    if (!fs.existsSync(source))
      return res.status(404).json({ error: "图片已不存在" });
    try {
      let target = source;
      if (!download && req.query.thumbnail === "1") {
        target = path.join(
          imageDir,
          "thumbnails",
          type + "-" + filename + ".webp",
        );
        if (!fs.existsSync(target)) {
          if (!thumbnails.has(target))
            thumbnails.set(
              target,
              sharp(source, { limitInputPixels: 64000000 })
                .resize({
                  width: 440,
                  height: 440,
                  fit: "inside",
                  withoutEnlargement: true,
                })
                .webp({ quality: 80 })
                .toBuffer()
                .then(async (buffer) => {
                  const temp = target + ".tmp";
                  try {
                    await fs.promises.writeFile(temp, buffer);
                    await fs.promises.rename(temp, target);
                  } finally {
                    if (fs.existsSync(temp)) await fs.promises.unlink(temp);
                  }
                })
                .finally(() => thumbnails.delete(target)),
            );
          await thumbnails.get(target);
        }
      }
      res.set("Cache-Control", "private, max-age=86400");
      if (download) res.attachment(filename);
      res.sendFile(target, { dotfiles: "allow" });
    } catch {
      if (!res.headersSent)
        res.status(500).json({ error: "图片读取失败，请重试" });
    }
  }

  for (const job of storage.list())
    if (job.provider === "api" && active(job))
      storage.put(job.id, {
        ...job,
        status: "failed",
        code: "API_INTERRUPTED",
        error:
          "工作台重启，API 请求已中断。为避免重复计费，未自动重新提交；请检查服务记录后再重试",
        completedAt: Date.now(),
      });
  const controllers = new Map();
  const queue = [];
  let running = 0;
  async function execute(job, snapshot, controller) {
    const timeout = setTimeout(
      () =>
        controller.abort(
          new Error(
            "API 生图等待超时，服务可能仍在处理；请检查服务记录后再重试",
          ),
        ),
      Number(process.env.GPT_IMAGE_TIMEOUT_MS) || 900000,
    );
    try {
      if (controller.signal.aborted) return;
      storage.put(job.id, { ...job, status: "running" });
      const params = {
        model: snapshot.model,
        prompt:
          job.prompt +
          (job.negativePrompt
            ? "\n\n请避免以下内容：" + job.negativePrompt
            : ""),
        n: 1,
        size: `${job.dimensions.width}x${job.dimensions.height}`,
        quality: job.apiQuality,
        output_format: "png",
      };
      if (new URL(snapshot.baseUrl).hostname !== "api.openai.com")
        params.response_format = "b64_json";
      let options;
      if (job.mode === "img2img") {
        const buffer = await sourceBuffer(job.sourceImage, controller.signal);
        const normalized = await sharp(buffer, { limitInputPixels: 24000000 })
          .rotate()
          .png()
          .toBuffer();
        if (normalized.length >= 50 * 1024 * 1024)
          throw new Error("参考图超过 API 的 50MB 限制，请缩小后重新上传");
        const form = new FormData();
        for (const [key, value] of Object.entries(params))
          form.append(key, String(value));
        form.append(
          "image[]",
          new Blob([normalized], { type: "image/png" }),
          "reference.png",
        );
        options = { method: "POST", body: form };
      } else
        options = {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(params),
        };
      const body = await call(
        snapshot,
        job.mode === "img2img" ? "/images/edits" : "/images/generations",
        options,
        controller.signal,
      );
      const encoded = body.data?.[0]?.b64_json;
      if (
        typeof encoded !== "string" ||
        !encoded.length ||
        encoded.length > 90 * 1024 * 1024 ||
        !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)
      )
        throw new Error(
          "API 未返回有效的 base64 图片，请确认服务兼容 Images API 并支持所选模型",
        );
      const image = await sharp(Buffer.from(encoded, "base64"), {
        limitInputPixels: 64000000,
        failOn: "warning",
      })
        .png()
        .toBuffer({ resolveWithObject: true });
      if (
        controller.signal.aborted ||
        storage.get(job.id)?.status === "cancelled"
      )
        return;
      const filename = crypto.randomUUID() + ".png";
      await fs.promises.writeFile(
        path.join(imageDir, "output", filename),
        image.data,
      );
      if (
        controller.signal.aborted ||
        storage.get(job.id)?.status === "cancelled"
      )
        return;
      const query = imageQuery({ filename, type: "output" }).toString();
      storage.put(job.id, {
        ...job,
        status: "completed",
        completedAt: Date.now(),
        dimensions: {
          ...job.dimensions,
          finalWidth: image.info.width,
          finalHeight: image.info.height,
        },
        apiResult: {
          size: /^\d{3,4}x\d{3,4}$|^auto$/.test(
            body.data[0].size || body.size || "",
          )
            ? body.data[0].size || body.size
            : undefined,
          quality: apiQualityValues.includes(
            body.data[0].quality || body.quality,
          )
            ? body.data[0].quality || body.quality
            : undefined,
        },
        imageUrls: [
          {
            url: "/api/images/view?" + query,
            thumbnailUrl: "/api/images/view?" + query + "&thumbnail=1",
            downloadUrl: "/api/images/download?" + query,
          },
        ],
        usage:
          body.usage && typeof body.usage === "object"
            ? {
                input_tokens: body.usage.input_tokens,
                output_tokens: body.usage.output_tokens,
                total_tokens: body.usage.total_tokens,
              }
            : undefined,
      });
    } catch (error) {
      if (storage.get(job.id)?.status !== "cancelled")
        storage.put(job.id, {
          ...job,
          status: "failed",
          completedAt: Date.now(),
          error: redact(
            controller.signal.aborted
              ? controller.signal.reason?.message
              : error.message,
            snapshot.apiKey,
          ),
        });
    } finally {
      clearTimeout(timeout);
      controllers.delete(job.id);
      running--;
      drain();
    }
  }
  function drain() {
    while (running < 3 && queue.length) {
      const next = queue.shift();
      if (next.controller.signal.aborted) {
        controllers.delete(next.job.id);
        continue;
      }
      running++;
      void execute(next.job, next.snapshot, next.controller);
    }
  }
  function submit(parameters) {
    const snapshot = capture(parameters.model);
    const selectedProfile = imageProfile(snapshot.model);
    if (!selectedProfile) throw new Error("不支持的生图模型");
    if (!snapshot.apiKey) throw new Error("请先在 API 配置中填写密钥");
    if (queue.length >= 50)
      throw new Error("等待中的 API 任务较多，请稍后再提交");
    if (
      !Object.hasOwn(selectedProfile.ratios, parameters.ratio) ||
      !Object.hasOwn(selectedProfile.qualities, parameters.quality)
    )
      throw new Error("所选模型不支持这个比例或质量，请重新选择");
    const [width, height] =
      selectedProfile.ratios[parameters.ratio][parameters.quality];
    if (
      width % 16 ||
      height % 16 ||
      Math.max(width, height) > 3840 ||
      Math.max(width, height) / Math.min(width, height) > 3 ||
      width * height < 655360 ||
      width * height > 8294400
    )
      throw new Error("尺寸不符合生图 API 的像素限制");
    const job = {
      ...parameters,
      id: crypto.randomUUID(),
      provider: "api",
      model: snapshot.model,
      apiQuality: selectedProfile.qualities[parameters.quality].apiQuality,
      dimensions: {
        width,
        height,
        finalWidth: width,
        finalHeight: height,
        isUpscaled: false,
      },
      createdAt: Date.now(),
      status: "queued",
    };
    delete job.seed;
    storage.put(job.id, job);
    const controller = new AbortController();
    controllers.set(job.id, controller);
    queue.push({ job, snapshot, controller });
    setImmediate(drain);
    return { promptId: job.id, ...job };
  }
  function cancel(job) {
    const message =
      job.status === "running"
        ? "已停止等待；API 服务可能继续处理并计费，请查看服务记录"
        : "任务已取消，未向 API 提交";
    storage.put(job.id, { ...job, status: "cancelled", error: message });
    controllers.get(job.id)?.abort();
    const queuedIndex = queue.findIndex((item) => item.job.id === job.id);
    if (queuedIndex !== -1) {
      queue.splice(queuedIndex, 1);
      controllers.delete(job.id);
    }
    drain();
    return { status: "cancelled", error: message };
  }
  return {
    publicSettings,
    connection,
    submit,
    cancel,
    validSource,
    saveInput,
    sourceBuffer,
    serveImage,
  };
}

module.exports = { createApiImages };
