const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const sharp = require("sharp");
const { Readable } = require("node:stream");
const { pipeline } = require("node:stream/promises");
const {
  translateScene: localTranslateScene,
  hasChinese,
} = require("./video-scene");
const {
  videoQualities,
  videoRatios,
  videoDimensions,
  videoDurations,
  videoFrames,
} = require("../shared/video.mjs");
const template = JSON.parse(
  fs.readFileSync(path.join(__dirname, "../workflows/minimax-h3.json"), "utf8"),
);
const pending = (job) => ["queued", "running"].includes(job?.status);

function validateVideo(value) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("请提交有效的视频参数");
  if (!Object.hasOwn(videoQualities, value.quality))
    throw new Error("请选择 480P 或 720P");
  const ratio = value.ratio === undefined ? "16:9" : value.ratio;
  if (!Object.hasOwn(videoRatios, ratio))
    throw new Error("请选择 9:16、16:9 或 1:1");
  if (!videoDurations.includes(value.seconds))
    throw new Error("请选择 4、6、8 或 10 秒");
  if (typeof value.prompt !== "string" || value.prompt.length > 4000)
    throw new Error("画面描述不能超过 4000 字");
  if (typeof value.dialogue !== "string" || value.dialogue.length > 200)
    throw new Error("口播不能超过 200 字");
  if (!value.prompt.trim() && !value.dialogue.trim())
    throw new Error("请填写画面描述或口播内容");
  if (!["contain", "cover", "front"].includes(value.framing))
    throw new Error("参考图构图选项无效");
  if (
    value.seed !== undefined &&
    (!Number.isSafeInteger(value.seed) ||
      value.seed < 0 ||
      value.seed > 2147483647)
  )
    throw new Error("种子必须是 0–2147483647 的整数");
  return {
    prompt: value.prompt.trim(),
    dialogue: value.dialogue.trim(),
    quality: value.quality,
    ratio,
    seconds: value.seconds,
    framing: value.framing,
    seed: value.seed ?? crypto.randomInt(0, 2147483647),
  };
}

function createVideoWorkflow(parameters, image) {
  const { quality, seconds, prompt, dialogue, seed } = parameters;
  const dimensions = videoDimensions(quality, parameters.ratio);
  const frames = videoFrames(seconds);
  const duration = frames / 24;
  const workflow = structuredClone(template);
  const reference = image
    ? "For the target video, at 0.00 seconds into the target video, <Picture 1> (from [Shot 1]) is fully referenced.\n\n"
    : "";
  const audio = videoPromptAudio(prompt, dialogue);
  const vocal = [];
  if (audio.spoken) {
    const delivery = audio.voiceover
      ? "says in an off-screen voiceover"
      : "says with the delivery described in the scene";
    vocal.push(
      audio.speechLines.length
        ? audio.speechLines
            .map(
              (line) =>
                `The voice (S1) ${delivery}${hasChinese(line) ? " in Mandarin Chinese, pronouncing the following original Chinese words exactly" : ""}: <d>[CN]${line}</d>. ${audio.voiceover ? "The on-screen character's lips remain closed." : "The speaking character's lips synchronize with the spoken words."}`,
            )
            .join(" ")
        : "The character speaks only as explicitly directed in the scene brief, with matching lip movements.",
    );
  }
  if (audio.singing) {
    const singer = audio.spoken ? "S2" : "S1";
    vocal.push(
      audio.lyrics.length
        ? audio.lyrics
            .map(
              (line) =>
                `The singer (${singer}) sings melodically${hasChinese(line) ? " in Mandarin Chinese, using the following original Chinese lyrics" : ""} in rhythm with the described performance: <d>[CN]${line}</d>. The melody and lip movements follow the sung lyrics.`,
            )
            .join(" ")
        : `The singer (${singer}) performs melodic singing in rhythm with the actions described in the scene.`,
    );
  }
  if (audio.music)
    vocal.push(
      "Music plays with the source, genre, rhythm and mood specified in the scene brief; the character's movements follow that rhythm.",
    );
  const scene =
    parameters.sceneEnglish ||
    audio.scene ||
    "The subject performs the actions described for this shot.";
  if (hasChinese(scene))
    throw new Error("中文画面描述必须先转换为英文场景说明");
  const soundtrack =
    audio.spoken || audio.singing || audio.music
      ? "Environmental ambience and physical action sounds appropriate to the location, kept beneath the explicitly described performance."
      : "The complete soundtrack consists of environmental ambience and physical action sounds appropriate to the scene. The character's mouth follows only the described physical expressions.";
  workflow["5"].inputs = {
    clip: ["2", 0],
    vae: ["3", 0],
    width: dimensions.renderWidth,
    height: dimensions.renderHeight,
    length: frames,
    prompt: `${reference}integrated_multimodal_description: [Shot 1] Follow this visual scene and action brief: ${scene}\n${image ? "Preserve the identity, face, hair and clothing of the person in <Picture 1>. " : ""}The brief describes what the camera shows. Match its subject, setting, motion, emotion and camera direction. ${vocal.join(" ")}\noverall_soundscape: ${soundtrack}\nnon_diegetic_music: ${audio.backgroundMusic ? "Musical accompaniment with the genre, rhythm and mood specified in the scene brief." : "N/A"}`,
  };
  if (image) {
    workflow["16"] = { class_type: "LoadImage", inputs: { image } };
    workflow["5"].inputs.first_frame = ["16", 0];
  } else delete workflow["16"];
  workflow["10"].inputs.noise_seed = seed;
  workflow["21"] = {
    class_type: "ImageScale",
    inputs: {
      image: ["12", 0],
      upscale_method: "lanczos",
      width: dimensions.width,
      height: dimensions.height,
      crop: "center",
    },
  };
  workflow["14"].inputs.images = ["21", 0];
  workflow["15"].inputs.filename_prefix =
    `video/qwen-workbench/${crypto.randomUUID()}`;
  return {
    workflow,
    dimensions: {
      width: dimensions.renderWidth,
      height: dimensions.renderHeight,
      finalWidth: dimensions.width,
      finalHeight: dimensions.height,
    },
    frames,
    duration,
  };
}

function videoPromptAudio(prompt = "", dialogue = "") {
  // Only explicit vocal directions become utterances; the scene itself is never a script.
  const speaking =
    "口播(?:内容|台词)?|旁白(?:内容|台词)?|台词|说(?:道|出|着)?|讲述|问(?:道|出|着)?|询问|质问|回答|答(?:道|复)?|回应|喊(?:道|出|着)?|叫(?:道|喊)?|says?|speaks?|asks?|answers?|replies|shouts?|voiceover|narration";
  const singing = "演唱|歌词|唱(?:歌|出|着|道)?|sings?|lyrics";
  const negation =
    /(?:不要|不需要|无需|禁止|没有|不会|不能|避免|别|不|without|\bno|\bnot)\s*(?:任何|进行|添加|加上|any\s+)?\s*$/i;
  const sanitize = (line) => line.replace(/<\/?d>|\[CN\]/g, "").trim();
  const speechLines = dialogue.trim() ? [sanitize(dialogue)] : [];
  const lyrics = [];
  let scene = prompt;
  const extract = (markers, lines) => {
    const pattern = new RegExp(
      `(${markers})\\s*(?:[:：]\\s*|(?=[“\"「『]))(?:[“\"「『]([^”\"」』\\n]+)[”\"」』]|([^\\n。！？!?；;]+[。！？!?]*))`,
      "gi",
    );
    scene = scene.replace(
      pattern,
      (match, marker, quoted, plain, offset, source) => {
        if (negation.test(source.slice(Math.max(0, offset - 24), offset)))
          return match;
        const line = sanitize(quoted || plain || "");
        if (line) lines.push(line);
        // Preserve asking, shouting, singing, etc. as scene directions, but never translate their words.
        return marker;
      },
    );
  };
  extract(singing, lyrics);
  extract(speaking, speechLines);
  scene = scene.replace(/^\s*场景描述\s*[:：]\s*/, "");
  const requests = prompt.replace(
    /(?:不要|不需要|无需|禁止|没有|不|\bwithout\s+|\bno\s+|\bnot\s+)(?:任何|进行|添加|加上|any\s+)?(?:口播|旁白|台词|说话|演唱|唱歌|唱|音乐|配乐|伴奏|speech|voiceover|narration|speaking|singing|music)/gi,
    "",
  );
  return {
    scene,
    speechLines,
    lyrics,
    spoken:
      speechLines.length > 0 ||
      /口播|旁白|说话|讲述|说台词|(?:开口|面对镜头)说|\b(?:speaks?|says?|speech|voiceover|narration)\b/i.test(
        requests,
      ),
    voiceover: /旁白|\bvoiceover\b/i.test(requests),
    singing:
      lyrics.length > 0 ||
      /演唱|唱歌|边.{0,12}边唱|跟唱|歌唱|哼唱|\bsing(?:s|ing)?\b/i.test(
        requests,
      ),
    music: /音乐|配乐|伴奏|\b(?:DJ|music|soundtrack|score)\b/i.test(requests),
    backgroundMusic:
      /背景音乐|配乐|伴奏|\b(?:background music|soundtrack|score|accompaniment)\b/i.test(
        requests,
      ),
  };
}

function historyVideo(entry) {
  const error = entry.status?.messages?.find(([type]) =>
    ["execution_error", "execution_interrupted"].includes(type),
  );
  if (error)
    return {
      status: error[0] === "execution_interrupted" ? "cancelled" : "failed",
      error:
        error[1]?.exception_message || error[1]?.message || "视频生成已中断",
    };
  for (const output of Object.values(entry.outputs || {})) {
    for (const file of [
      ...(output.images || []),
      ...(output.gifs || []),
      ...(output.videos || []),
    ]) {
      const subfolder = String(file.subfolder || "").replaceAll("\\", "/");
      if (
        /\.mp4$/i.test(file.filename || "") &&
        !/[\\/]/.test(file.filename) &&
        !file.filename.includes("..") &&
        !subfolder.includes("..") &&
        !subfolder.startsWith("/") &&
        !subfolder.includes(":") &&
        file.type === "output"
      )
        return { status: "completed", video: { ...file, subfolder } };
    }
  }
  return entry.status?.completed
    ? { status: "failed", error: "任务已结束，但没有输出 MP4 视频" }
    : { status: "running" };
}

function createVideos({
  app,
  storage,
  comfyJson,
  withComfy,
  apiImages,
  validSourceImage,
  isBusy,
  getComfyUrl,
  translateScene = localTranslateScene,
}) {
  let readyCache,
    readyAt = 0;
  let socket,
    socketUrl,
    closed = false,
    reconnectTimer;
  function connectProgress() {
    if (!getComfyUrl || closed) return;
    const url =
      getComfyUrl().replace(/^http/, "ws").replace(/\/$/, "") +
      "/ws?clientId=qwen-workbench-video";
    if (
      socketUrl === url &&
      socket &&
      [WebSocket.CONNECTING, WebSocket.OPEN].includes(socket.readyState)
    )
      return;
    clearTimeout(reconnectTimer);
    socket?.close();
    socketUrl = url;
    const current = (socket = new WebSocket(url));
    current.addEventListener("message", (event) => {
      if (socket !== current || typeof event.data !== "string") return;
      try {
        const { type, data } = JSON.parse(event.data);
        const job = storage.get(data?.prompt_id);
        if (job?.mediaType !== "video" || !pending(job)) return;
        if (type === "progress" && data.node === "11") {
          storage.put(job.id, {
            ...job,
            status: "running",
            sampleStep: data.value,
            sampleTotal: data.max,
            stage: "sampling",
          });
        } else if (type === "executing" && data.node) {
          const stage = {
            5: "preparing",
            11: "sampling",
            12: "decoding",
            13: "decoding",
            21: "encoding",
            14: "encoding",
            15: "encoding",
          }[data.node];
          if (stage) storage.put(job.id, { ...job, status: "running", stage });
        }
      } catch {
        /* Binary previews and unrelated engine events do not affect jobs. */
      }
    });
    current.addEventListener("error", () => {});
    current.addEventListener("close", () => {
      if (socket === current && !closed)
        reconnectTimer = setTimeout(connectProgress, 3000).unref();
    });
  }
  async function readiness() {
    connectProgress();
    if (readyCache && Date.now() - readyAt < 15000) return readyCache;
    const classes = [
      "UNETLoader",
      "CLIPLoader",
      "VAELoader",
      "MiniMaxH3ImageToVideo",
    ];
    const infos = await Promise.all(
      classes.map((name) => comfyJson("/object_info/" + name)),
    );
    const missing = [];
    for (const [index, node, field] of [
      [0, "1", "unet_name"],
      [1, "2", "clip_name"],
      [2, "3", "vae_name"],
      [2, "4", "vae_name"],
    ]) {
      const available =
        infos[index][classes[index]]?.input?.required?.[field]?.[0] || [];
      if (!available.includes(template[node].inputs[field]))
        missing.push(template[node].inputs[field]);
    }
    if (!infos[3].MiniMaxH3ImageToVideo) missing.push("MiniMax H3 视频节点");
    readyAt = Date.now();
    return (readyCache = { ready: !missing.length, missing });
  }
  async function refresh(id) {
    const job = storage.get(id);
    if (!job || job.mediaType !== "video") return null;
    const recoveringOutput =
      job.status === "failed" &&
      job.error === "任务已结束，但没有输出 MP4 视频";
    if (!pending(job) && !recoveringOutput) return job;
    const history = await comfyJson("/history/" + encodeURIComponent(id));
    let result;
    if (history[id]) result = historyVideo(history[id]);
    else {
      const queue = await comfyJson("/queue");
      if ((queue.queue_running || []).some((item) => item[1] === id))
        result = { status: "running" };
      else if (
        (queue.queue_pending || []).some((item) => item[1] === id) ||
        Date.now() - job.createdAt < 30000
      )
        result = { status: "queued" };
      else
        result = {
          status: "failed",
          error: "任务已不存在，可能引擎已重启，请重新生成",
        };
    }
    const latest = storage.get(id);
    if (!pending(latest) && !(recoveringOutput && latest?.status === "failed"))
      return latest;
    const updated = { ...latest, ...result };
    if (result.status === "completed") {
      delete updated.error;
      updated.videoUrl = `/api/videos/media/${id}`;
      updated.downloadUrl = updated.videoUrl + "?download=1";
      updated.completedAt = Date.now();
    }
    storage.put(id, updated);
    return updated;
  }
  app.get("/api/videos/config", async (_req, res) => {
    try {
      res.json({
        ...(await readiness()),
        qualities: videoQualities,
        ratios: videoRatios,
        durations: videoDurations,
        fps: 24,
      });
    } catch (error) {
      res.json({
        ready: false,
        error: "视频引擎未连接：" + error.message,
        qualities: videoQualities,
        ratios: videoRatios,
        durations: videoDurations,
        fps: 24,
      });
    }
  });
  app.get("/api/videos/jobs", (_req, res) =>
    res.json({
      jobs: storage.list().filter((job) => job.mediaType === "video"),
    }),
  );
  app.post("/api/videos/generate", async (req, res) => {
    let parameters;
    try {
      parameters = validateVideo(req.body);
      if (
        req.body.sourceImage &&
        !apiImages.validSource(req.body.sourceImage) &&
        !validSourceImage(req.body.sourceImage)
      )
        throw new Error("参考图无效，请重新上传");
    } catch (error) {
      return res.status(400).json({ error: error.message });
    }
    if (isBusy())
      return res
        .status(409)
        .json({ error: "环境配置正在执行，请稍后生成视频" });
    try {
      const ready = await readiness();
      if (!ready.ready)
        return res
          .status(409)
          .json({ error: "缺少视频模型或节点：" + ready.missing.join("、") });
      const audio = videoPromptAudio(parameters.prompt, parameters.dialogue);
      parameters.sceneEnglish = await translateScene(
        audio.scene.trim() ||
          "The character performs the specified vocal line.",
      );
      if (
        typeof parameters.sceneEnglish !== "string" ||
        !parameters.sceneEnglish.trim() ||
        hasChinese(parameters.sceneEnglish)
      )
        throw new Error("场景转换失败，任务未提交");
      let image;
      if (req.body.sourceImage) {
        const buffer = await apiImages.sourceBuffer(req.body.sourceImage);
        const dims = videoDimensions(parameters.quality, parameters.ratio);
        let processor = sharp(buffer, { limitInputPixels: 24000000 }).rotate();
        if (parameters.framing === "front") {
          const metadata = await sharp(buffer).metadata();
          processor = processor.extract({
            left: 0,
            top: Math.round(metadata.height * 0.02),
            width: Math.round(metadata.width * 0.34),
            height: Math.round(metadata.height * 0.4),
          });
        }
        const fitted = await processor
          .resize({
            width: dims.renderWidth,
            height: dims.renderHeight,
            fit: parameters.framing === "cover" ? "cover" : "contain",
            position: "centre",
            background: { r: 202, g: 200, b: 198, alpha: 1 },
          })
          .png()
          .toBuffer();
        const form = new FormData();
        form.append(
          "image",
          new Blob([fitted], { type: "image/png" }),
          crypto.randomUUID() + ".png",
        );
        form.append("subfolder", "qwen-workbench");
        form.append("type", "input");
        const uploaded = await comfyJson("/upload/image", {
          method: "POST",
          body: form,
        });
        if (!validSourceImage(uploaded)) throw new Error("视频参考图保存失败");
        image = uploaded.subfolder + "/" + uploaded.name;
      }
      const { workflow, ...details } = createVideoWorkflow(parameters, image);
      const result = await comfyJson("/prompt", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: workflow,
          client_id: "qwen-workbench-video",
        }),
      });
      if (!result.prompt_id || Object.keys(result.node_errors || {}).length)
        throw new Error(
          result.error?.message ||
            "视频工作流提交失败：" + JSON.stringify(result.node_errors || {}),
        );
      const job = {
        id: result.prompt_id,
        promptId: result.prompt_id,
        mediaType: "video",
        provider: "local",
        model: "MiniMax H3",
        status: "queued",
        createdAt: Date.now(),
        ...parameters,
        ...details,
        sourceImage: req.body.sourceImage,
      };
      storage.put(job.id, job);
      res.status(202).json(job);
    } catch (error) {
      res.status(502).json({
        error:
          error.name === "AbortError"
            ? "视频服务响应超时，请检查本地引擎"
            : error.message,
      });
    }
  });
  app.get("/api/videos/jobs/:id", async (req, res) => {
    try {
      const job = await refresh(req.params.id);
      if (!job) return res.status(404).json({ error: "视频任务不存在" });
      res.json(job);
    } catch (error) {
      res.status(502).json({ error: error.message, recoverable: true });
    }
  });
  app.post("/api/videos/jobs/:id/cancel", async (req, res) => {
    const job = storage.get(req.params.id);
    if (job?.mediaType !== "video")
      return res.status(404).json({ error: "视频任务不存在" });
    try {
      const latest = await refresh(job.id);
      if (!pending(latest)) return res.json(latest);
      const post = (body) => ({
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      await comfyJson("/queue", post({ delete: [job.id] }));
      await comfyJson("/interrupt", post({ prompt_id: job.id }));
      const cancelled = { ...latest, status: "cancelled", error: "任务已取消" };
      storage.put(job.id, cancelled);
      res.json(cancelled);
    } catch (error) {
      res.status(502).json({ error: error.message });
    }
  });
  app.get("/api/videos/media/:id", async (req, res) => {
    const job = storage.get(req.params.id);
    if (job?.mediaType !== "video" || job.status !== "completed" || !job.video)
      return res.status(404).json({ error: "视频尚未生成或文件不存在" });
    const controller = new AbortController();
    res.on("close", () => {
      if (!res.writableFinished) controller.abort();
    });
    try {
      const query = new URLSearchParams({
        filename: job.video.filename,
        subfolder: job.video.subfolder || "",
        type: "output",
      });
      await withComfy(
        "/view?" + query,
        {
          timeout: 120000,
          signal: controller.signal,
          headers: req.headers.range ? { Range: req.headers.range } : {},
        },
        async (response, signal) => {
          res.status(response.status);
          for (const key of [
            "content-length",
            "content-range",
            "accept-ranges",
            "etag",
            "last-modified",
          ])
            if (response.headers.has(key))
              res.set(key, response.headers.get(key));
          res.set("Content-Type", "video/mp4");
          res.set("Cache-Control", "private, max-age=86400");
          if (req.query.download === "1")
            res.set(
              "Content-Disposition",
              `attachment; filename="MiniMax-H3-${job.quality}-${job.id}.mp4"`,
            );
          await pipeline(Readable.fromWeb(response.body), res, { signal });
        },
      );
    } catch (error) {
      if (res.headersSent || res.destroyed) return res.destroy();
      res.status(502).json({ error: "读取视频失败：" + error.message });
    }
  });
  return {
    refresh,
    restoreJobs: (jobs) => {
      for (const job of jobs || []) {
        if (
          storage.get(job.id) ||
          !/^[a-f0-9-]{36}$/.test(job.id) ||
          job.mediaType !== "video" ||
          !Object.hasOwn(videoQualities, job.quality) ||
          (job.ratio !== undefined && !Object.hasOwn(videoRatios, job.ratio)) ||
          typeof job.prompt !== "string" ||
          !Number.isFinite(job.createdAt)
        )
          continue;
        if (job.status === "completed") {
          const result = historyVideo({
            status: { completed: true },
            outputs: { saved: { images: [job.video || {}] } },
          });
          if (
            result.status !== "completed" ||
            result.video.subfolder !== "video/qwen-workbench"
          )
            continue;
          storage.put(job.id, {
            ...job,
            ...result,
            videoUrl: `/api/videos/media/${job.id}`,
            downloadUrl: `/api/videos/media/${job.id}?download=1`,
          });
        } else if (
          ["queued", "running", "failed", "cancelled"].includes(job.status)
        )
          storage.put(job.id, job);
      }
    },
    close: () => {
      closed = true;
      clearTimeout(reconnectTimer);
      socket?.close();
    },
  };
}
module.exports = {
  createVideos,
  validateVideo,
  createVideoWorkflow,
  historyVideo,
  videoPromptAudio,
};
