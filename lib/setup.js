const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { spawn, execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { setTimeout: delay } = require("node:timers/promises");
const { Transform, Readable } = require("node:stream");
const { pipeline } = require("node:stream/promises");
const manifest = require("../shared/setup-manifest.json");
const execute = promisify(execFile);
const GiB = 1024 ** 3;

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}
function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file + ".tmp", JSON.stringify(value, null, 2));
  fs.renameSync(file + ".tmp", file);
}
function runtimeDefaults(config) {
  const legacyBase = "D:\\comfyui";
  const legacyMain = "D:\\Program Files\\comfyui\\resources\\ComfyUI\\main.py";
  const legacy =
    process.platform === "win32" &&
    fs.existsSync(legacyMain) &&
    fs.existsSync(legacyBase);
  const base =
    config.comfyBase ||
    (legacy
      ? legacyBase
      : path.join(
          os.homedir(),
          "QwenWorkbench",
          "ComfyUI_windows_portable",
          "ComfyUI",
        ));
  return {
    comfyBase: base,
    comfyMain:
      config.comfyMain || (legacy ? legacyMain : path.join(base, "main.py")),
    pythonPath:
      config.pythonPath ||
      (legacy
        ? path.join(base, ".venv", "Scripts", "python.exe")
        : path.join(path.dirname(base), "python_embeded", "python.exe")),
    comfyUrl: config.comfyUrl,
    lowVram: false,
    proxyUrl: "",
  };
}
function loadRuntime(dataDir, config) {
  return {
    ...runtimeDefaults(config),
    ...readJson(path.join(dataDir, "runtime.json"), {}),
  };
}
function localUrl(value) {
  const url = new URL(value);
  if (
    url.protocol !== "http:" ||
    !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  )
    throw new Error("服务地址应为本机 HTTP 地址，例如 http://127.0.0.1:8000");
  return url.origin;
}
function absolute(value, label) {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > 1000 ||
    /[\r\n\0]/.test(value) ||
    !path.isAbsolute(value)
  )
    throw new Error(`${label}需要完整的绝对路径`);
  const result = path.resolve(value);
  if (result === path.parse(result).root)
    throw new Error(`${label}不能使用磁盘根目录`);
  return result;
}
async function digest(file, signal, progress) {
  const hash = crypto.createHash("sha256");
  let bytes = 0;
  const stream = fs.createReadStream(file, { signal });
  for await (const chunk of stream) {
    hash.update(chunk);
    bytes += chunk.length;
    progress?.(bytes);
  }
  return hash.digest("hex");
}
async function freeDisk(directory) {
  let existing = directory;
  while (!fs.existsSync(existing) && path.dirname(existing) !== existing)
    existing = path.dirname(existing);
  const stat = await fs.promises.statfs(existing);
  return Number(stat.bavail) * Number(stat.bsize);
}

function createSetup({
  app,
  config,
  dataDir,
  runtime,
  applyRuntime,
  comfyJson,
  verify,
  busy,
}) {
  const stateFile = path.join(dataDir, "setup-state.json");
  const cache = path.join(dataDir, "downloads");
  const state = readJson(stateFile, {
    task: null,
    verification: null,
    checksums: {},
  });
  state.checksums ||= {};
  if (state.task?.status === "running")
    Object.assign(state.task, {
      status: "interrupted",
      message: "工作台重启，操作已中断。下载可继续，安装可重试。",
    });
  if (state.verification?.status === "running")
    Object.assign(state.verification, {
      status: "interrupted",
      error: "工作台已重启，请检查引擎队列后重新试生成",
    });
  let active = null;
  let managedChild = null;
  let hardwareCache = null;
  let report = null;
  let torchReport = null;
  let logSaveAt = 0;
  const fingerprint = () => {
    const { proxyUrl, ...engine } = runtime;
    return crypto
      .createHash("sha256")
      .update(JSON.stringify({ ...engine, models: config.models }))
      .digest("hex");
  };
  const persist = () => writeJson(stateFile, state);
  function patch(update, force = false) {
    Object.assign(state.task, update);
    if (force || Date.now() - logSaveAt > 1000) {
      persist();
      logSaveAt = Date.now();
    }
  }
  function log(message) {
    const text = String(message).trim();
    if (!text) return;
    state.task.logs.push({ time: Date.now(), text: text.slice(-3000) });
    state.task.logs = state.task.logs.slice(-80);
    patch({ message: text.slice(-500) });
  }
  function task(kind, work) {
    if (active) throw new Error("已有配置操作正在执行，请等待或取消后再操作");
    const controller = new AbortController();
    active = controller;
    state.task = {
      id: crypto.randomUUID(),
      kind,
      status: "running",
      startedAt: Date.now(),
      message: "准备中…",
      progress: null,
      logs: [],
    };
    persist();
    Promise.resolve()
      .then(() => work(controller.signal))
      .then(() => {
        controller.signal.throwIfAborted();
        patch(
          {
            status: "completed",
            message: "操作完成",
            endedAt: Date.now(),
            progress: 1,
          },
          true,
        );
      })
      .catch((error) => {
        patch(
          {
            status: controller.signal.aborted ? "cancelled" : "failed",
            message: controller.signal.aborted
              ? "已取消，可重新开始或继续下载"
              : explain(error),
            endedAt: Date.now(),
          },
          true,
        );
        log(state.task.message);
      })
      .finally(() => {
        active = null;
        report = null;
        persist();
      });
    return state.task;
  }
  function explain(error) {
    const text = error.message || String(error);
    if (/ENOSPC|no space/i.test(text))
      return "磁盘空间不足，请选择空间更大的目录后重试";
    if (/EACCES|EPERM/i.test(text))
      return "目录无法写入。请选择自己的文件夹，避免 Program Files 等受保护目录";
    if (/fetch failed|ENOTFOUND|ETIMEDOUT|ECONNRESET|timeout/i.test(text))
      return "网络连接失败或超时。检查网络后继续；已下载的部分会保留。";
    if (/out of memory|cuda.*memory/i.test(text))
      return "显存不足。停止其他 GPU 任务，启用低显存启动，再尝试快速档；仍失败时需要更多显存或内存。";
    return text.slice(-3000);
  }
  async function command(file, args, signal, cwd, seconds = 600) {
    return new Promise((resolve, reject) => {
      const child = spawn(file, args, {
        cwd,
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let tail = "";
      const receive = (data) => {
        tail = (tail + data.toString()).slice(-4000);
        log(data.toString());
      };
      child.stdout.on("data", receive);
      child.stderr.on("data", receive);
      const abort = () => child.kill();
      signal.addEventListener("abort", abort, { once: true });
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error("操作超时，请检查任务日志"));
      }, seconds * 1000);
      child.on("error", reject);
      child.on("close", (code) => {
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        code === 0
          ? resolve()
          : reject(new Error(`操作退出 (${code})：${tail}`));
      });
      if (signal.aborted) abort();
    });
  }
  async function download(item, target, signal) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (fs.existsSync(target) && fs.statSync(target).size === item.bytes) {
      log(`检查已有文件：${path.basename(target)}`);
      patch({ progress: null, phase: "hashing", file: path.basename(target) });
      if ((await digest(target, signal)) === item.sha256) return;
    }
    if (fs.existsSync(target))
      throw new Error(
        `已有文件与官方校验不一致：${target}。请先将它移到备份目录，工作台不会覆盖。`,
      );
    const partial = target + ".part";
    let offset = fs.existsSync(partial) ? fs.statSync(partial).size : 0;
    if (offset > item.bytes)
      throw new Error(`临时下载长度异常，请将 ${partial} 移到备份目录后重试`);
    if (offset < item.bytes) {
      log(`下载 ${path.basename(target)}${offset ? " · 继续上次进度" : ""}`);
      patch({
        phase: "downloading",
        file: path.basename(target),
        downloaded: offset,
        total: item.bytes,
        progress: offset / item.bytes,
      });
      const response = await fetch(item.url, {
        headers: offset
          ? { Range: `bytes=${offset}-`, "Accept-Encoding": "identity" }
          : { "Accept-Encoding": "identity" },
        signal: AbortSignal.any([
          signal,
          AbortSignal.timeout(6 * 60 * 60 * 1000),
        ]),
      });
      if (!response.ok || !response.body)
        throw new Error(
          `下载失败 (${response.status})，请检查网络或模型源权限`,
        );
      if (offset && response.status === 200) offset = 0;
      else if (
        offset &&
        (response.status !== 206 ||
          !response.headers
            .get("content-range")
            ?.startsWith(`bytes ${offset}-`))
      ) {
        await response.body.cancel();
        throw new Error("下载源返回的续传位置不正确，请稍后重试");
      }
      const meter = new Transform({
        transform(chunk, _encoding, callback) {
          offset += chunk.length;
          patch({
            downloaded: offset,
            total: item.bytes,
            progress: offset / item.bytes,
          });
          callback(null, chunk);
        },
      });
      await pipeline(
        Readable.fromWeb(response.body),
        meter,
        fs.createWriteStream(partial, { flags: offset ? "a" : "w" }),
        { signal },
      );
    }
    if (fs.statSync(partial).size !== item.bytes)
      throw new Error("下载文件长度不匹配，已保留临时文件，请重试");
    log(`SHA-256 校验：${path.basename(target)}`);
    patch({ phase: "hashing", progress: null });
    if (
      (await digest(partial, signal, (bytes) =>
        patch({ progress: bytes / item.bytes }),
      )) !== item.sha256
    ) {
      fs.renameSync(partial, partial + ".invalid-" + Date.now());
      throw new Error(
        "文件校验失败，损坏文件已移到 .invalid 备份，重新下载可修复",
      );
    }
    signal.throwIfAborted();
    fs.renameSync(partial, target);
  }
  async function hardware() {
    if (hardwareCache && Date.now() - hardwareCache.time < 60000)
      return hardwareCache.value;
    let gpus = [],
      gpuError = "";
    try {
      const { stdout } = await execute(
        "nvidia-smi",
        [
          "--query-gpu=name,memory.total,driver_version",
          "--format=csv,noheader,nounits",
        ],
        { windowsHide: true, timeout: 10000 },
      );
      gpus = stdout
        .trim()
        .split(/\r?\n/)
        .map((line) => {
          const [name, memory, driver] = line.split(",").map((s) => s.trim());
          return { name, vram: Number(memory) * 1024 ** 2, driver };
        });
    } catch {
      gpuError =
        "未检测到可用的 NVIDIA 驱动。其他显卡请先按官方文档安装 ComfyUI，再连接已有服务。";
    }
    const value = {
      platform: process.platform,
      arch: process.arch,
      cpu: os.cpus()[0]?.model,
      ram: os.totalmem(),
      node: process.version,
      gpus,
      gpuError,
    };
    hardwareCache = { time: Date.now(), value };
    return value;
  }
  function modelRows(info) {
    const loaders = {
      unet: ["UNETLoader", "unet_name"],
      clip: ["CLIPLoader", "clip_name"],
      vae: ["VAELoader", "vae_name"],
      upscale: ["UpscaleModelLoader", "model_name"],
    };
    return manifest.models.map((item) => {
      const filename = config.models[item.id];
      const folders =
        item.id === "unet"
          ? ["diffusion_models", "unet"]
          : item.id === "clip"
            ? ["text_encoders", "clip"]
            : [path.dirname(item.file)];
      const candidates = folders.map((folder) =>
        path.join(runtime.comfyBase, "models", folder, filename),
      );
      const localPath =
        candidates.find((file) => fs.existsSync(file)) || candidates[0];
      const stat = fs.existsSync(localPath) ? fs.statSync(localPath) : null;
      const [node, field] = loaders[item.id];
      const names = info?.[node]?.input?.required?.[field]?.[0] || [];
      const known = filename === path.basename(item.file);
      const cached = state.checksums[localPath];
      return {
        ...item,
        filename,
        path: localPath,
        present: !!stat?.isFile(),
        size: stat?.size || 0,
        complete: !!stat?.isFile() && (!known || stat.size === item.bytes),
        recognized: Array.isArray(names) && names.includes(filename),
        verified:
          !!cached &&
          cached.sha256 === item.sha256 &&
          cached.size === stat?.size &&
          cached.mtime === stat?.mtimeMs,
        downloadable: known,
        url: `https://huggingface.co/${item.repo}/resolve/${item.revision}/${item.sourceFile || item.file}`,
        source: `https://huggingface.co/${item.repo}`,
        partialBytes: fs.existsSync(localPath + ".part")
          ? fs.statSync(localPath + ".part").size
          : 0,
      };
    });
  }
  async function inspect(probe = false, signal) {
    const hw = await hardware();
    let stats = null,
      info = null,
      engineError = "";
    try {
      [stats, info] = await Promise.all([
        comfyJson("/system_stats", { timeout: 5000 }),
        comfyJson("/object_info", { timeout: 10000 }),
      ]);
    } catch (error) {
      engineError = "ComfyUI 未就绪：" + explain(error);
    }
    const required = [
      "UNETLoader",
      "CLIPLoader",
      "CLIPTextEncode",
      "EmptyLatentImage",
      "KSampler",
      "VAELoader",
      "VAEDecode",
      "SaveImage",
      "TextEncodeQwenImage21",
      "LoadImage",
      "ImageScale",
    ];
    const missingNodes = info
      ? required.filter((node) => !info[node])
      : required;
    let torch = torchReport;
    if (probe && fs.existsSync(runtime.pythonPath)) {
      try {
        const script =
          'import torch,json; a=torch.cuda.is_available(); d=torch.cuda.current_device() if a else None; print(json.dumps({"version":torch.__version__,"cuda":a,"device":torch.cuda.get_device_name(d) if a else None,"capability":list(torch.cuda.get_device_capability(d)) if a else None,"architectures":torch.cuda.get_arch_list() if a else []})); x=torch.ones(1,device="cuda") if a else None; print("CUDA_PROBE_OK" if a else "CPU_ONLY")';
        const { stdout } = await execute(
          runtime.pythonPath,
          ["-s", "-c", script],
          { windowsHide: true, timeout: 45000, maxBuffer: 1024 * 1024, signal },
        );
        torch = JSON.parse(
          stdout.split(/\r?\n/).find((line) => line.startsWith("{")),
        );
        torch.kernelOk = stdout.includes("CUDA_PROBE_OK");
      } catch (error) {
        if (signal?.aborted) throw error;
        torch = { cuda: false, error: explain(error) };
      }
      torchReport = torch;
    }
    const models = modelRows(info);
    const free = await freeDisk(runtime.comfyBase).catch(() => null);
    const maxVram = Math.max(
      0,
      ...hw.gpus.map((gpu) => gpu.vram),
      ...(stats?.devices || []).map((device) =>
        device.type === "cuda" ? device.vram_total : 0,
      ),
    );
    const warnings = [];
    if (maxVram < 12 * GiB)
      warnings.push(
        maxVram >= 8 * GiB - 256 * 1024 ** 2
          ? "显存较紧，建议低显存模式和快速档，推理会使用系统内存。"
          : "显存少于 8 GB 或未识别 CUDA，运行这一模型可能很慢或失败。先完成驱动检查，再试生成。",
      );
    if (hw.ram < 32 * GiB - 512 * 1024 ** 2)
      warnings.push("系统内存少于 32 GB，模型卸载到内存时可能不足。");
    if (free !== null && free < 25 * GiB)
      warnings.push("可用磁盘少于 25 GB，新安装及模型下载可能空间不足。");
    if (missingNodes.length && info)
      warnings.push(
        "当前 ComfyUI 缺少必要节点，请安装支持 Qwen-Image 2.1 的版本。",
      );
    const ready =
      !!stats &&
      missingNodes.length === 0 &&
      models.filter((item) => !item.optional).every((item) => item.recognized);
    report = {
      hardware: hw,
      freeDisk: free,
      torch,
      installed:
        fs.existsSync(runtime.comfyMain) && fs.existsSync(runtime.pythonPath),
      connected: !!stats,
      engineError,
      engine: stats
        ? {
            version: stats.system?.comfyui_version,
            pytorch: stats.system?.pytorch_version,
            devices: stats.devices,
          }
        : null,
      models,
      missingNodes,
      ready,
      warnings,
      checkedAt: Date.now(),
    };
    return report;
  }
  async function assertIdle() {
    if (busy())
      throw new Error("生成任务尚未结束，请等待后再修改引擎或安装模型");
    const queue = await comfyJson("/queue", { timeout: 3000 }).catch(
      () => null,
    );
    if (
      queue &&
      ((queue.queue_running || []).length || (queue.queue_pending || []).length)
    )
      throw new Error("ComfyUI 正在处理任务，请等待队列结束后再执行此操作");
  }
  function saveRuntime(value) {
    writeJson(path.join(dataDir, "runtime.json"), value);
    Object.assign(runtime, value);
    applyRuntime(value);
    report = null;
    torchReport = null;
  }
  async function install(signal, directory) {
    const hw = await hardware();
    if (
      hw.platform !== "win32" ||
      hw.arch !== "x64" ||
      !hw.gpus.length ||
      !hw.gpus.some((gpu) => /RTX/i.test(gpu.name))
    )
      throw new Error(
        "自动安装支持 Windows x64 的 NVIDIA RTX 显卡。其他显卡请使用官方对应安装包，再连接已有服务。",
      );
    await assertIdle();
    const destination = path.join(directory, "ComfyUI_windows_portable");
    if (fs.existsSync(destination))
      throw new Error(
        "该目录已有 ComfyUI 文件，请连接已有安装，或选择新的空目录",
      );
    if ((await freeDisk(directory)) < 25 * GiB)
      throw new Error("安装目录可用空间不足 25 GB，请更换目录");
    fs.mkdirSync(cache, { recursive: true });
    const extractor = path.join(cache, "7zr.exe");
    const archive = path.join(
      cache,
      `ComfyUI-${manifest.comfy.version}-nvidia.7z`,
    );
    if (
      (await freeDisk(cache)) < manifest.comfy.bytes + GiB &&
      !fs.existsSync(archive)
    )
      throw new Error(
        "工作台所在磁盘的下载缓存空间不足 3 GB，请移动工作台目录后重试",
      );
    await download(manifest.extractor, extractor, signal);
    await download(manifest.comfy, archive, signal);
    const stage = path.join(directory, ".qwen-install-" + crypto.randomUUID());
    fs.mkdirSync(stage, { recursive: true });
    log("正在解压官方便携版，Python 与 PyTorch 已包含在安装包中");
    patch({ phase: "extracting", progress: null });
    await command(
      extractor,
      ["x", archive, `-o${stage}`, "-y"],
      signal,
      directory,
    );
    signal.throwIfAborted();
    const root = path.join(stage, "ComfyUI_windows_portable");
    if (
      !fs.existsSync(path.join(root, "ComfyUI", "main.py")) ||
      !fs.existsSync(path.join(root, "python_embeded", "python.exe"))
    )
      throw new Error(`安装包结构异常，临时文件已保留在 ${stage}`);
    fs.renameSync(root, destination);
    fs.rmdirSync(stage);
    const base = path.join(destination, "ComfyUI");
    saveRuntime({
      ...runtime,
      comfyBase: base,
      comfyMain: path.join(base, "main.py"),
      pythonPath: path.join(destination, "python_embeded", "python.exe"),
      lowVram: hw.gpus.every((gpu) => gpu.vram < 12 * GiB),
    });
    log("安装完成。继续下载模型，然后启动引擎。");
  }
  async function models(signal, ids, verifyOnly = false) {
    await assertIdle();
    if (!fs.existsSync(runtime.comfyMain))
      throw new Error("请先安装 ComfyUI 或保存正确的安装路径");
    const rows = modelRows(null).filter((item) => ids.includes(item.id));
    if (!rows.length) throw new Error("请选择模型");
    const remaining = rows.reduce(
      (sum, item) =>
        sum + (item.complete ? 0 : Math.max(0, item.bytes - item.partialBytes)),
      0,
    );
    if (!verifyOnly && (await freeDisk(runtime.comfyBase)) < remaining + GiB)
      throw new Error("模型目录可用空间不足，请更换路径或释放磁盘空间");
    for (const item of rows) {
      signal.throwIfAborted();
      if (!item.downloadable)
        throw new Error(
          `自定义模型 ${item.filename} 需要自行提供，自动下载仅支持清单中的原版文件`,
        );
      if (verifyOnly) {
        if (!item.complete)
          throw new Error(`${item.label}缺失或长度不正确，请先下载`);
        log(`校验 ${item.filename}`);
        patch({ phase: "hashing", file: item.filename, progress: null });
        if (
          (await digest(item.path, signal, (bytes) =>
            patch({ progress: bytes / item.bytes }),
          )) !== item.sha256
        )
          throw new Error(
            `${item.filename}校验不匹配，请备份损坏文件后重新下载`,
          );
      } else await download(item, item.path, signal);
      const stat = fs.statSync(item.path);
      state.checksums[item.path] = {
        sha256: item.sha256,
        size: stat.size,
        mtime: stat.mtimeMs,
      };
      persist();
      log(`${item.label}已校验`);
    }
    report = null;
    log(
      "模型文件就绪。若引擎已启动但未识别，请在 ComfyUI 中刷新模型列表，或结束任务后重启引擎。",
    );
  }
  async function start(signal) {
    localUrl(runtime.comfyUrl);
    const connected = await comfyJson("/system_stats", { timeout: 3000 }).catch(
      () => null,
    );
    if (connected) {
      log("已有 ComfyUI 正在运行，已连接，无需重复启动");
      return;
    }
    if (!fs.existsSync(runtime.pythonPath) || !fs.existsSync(runtime.comfyMain))
      throw new Error("Python 或 main.py 不存在，请检查安装路径");
    if (managedChild && managedChild.exitCode === null)
      throw new Error("引擎正在启动，请稍后重新检查");
    const url = new URL(runtime.comfyUrl);
    const args = [
      "-s",
      runtime.comfyMain,
      "--listen",
      url.hostname === "[::1]" ? "::1" : "127.0.0.1",
      "--port",
      url.port || "80",
      "--base-directory",
      runtime.comfyBase,
      "--disable-auto-launch",
    ];
    if (runtime.pythonPath.includes("python_embeded"))
      args.push("--windows-standalone-build");
    if (runtime.lowVram) args.push("--lowvram");
    log("启动 ComfyUI…");
    const child = spawn(runtime.pythonPath, args, {
      cwd: path.dirname(runtime.comfyMain),
      windowsHide: true,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    managedChild = child;
    const logPath = path.join(dataDir, "comfy-engine.log");
    const output = (data) => {
      const text = data.toString();
      fs.appendFileSync(logPath, text);
      if (state.task?.kind === "start" && state.task.status === "running")
        log(text);
    };
    child.stdout.on("data", output);
    child.stderr.on("data", output);
    let error = null;
    child.on("error", (value) => {
      error = value;
    });
    const cancel = () => child.kill();
    signal.addEventListener("abort", cancel, { once: true });
    try {
      for (let i = 0; i < 120; i++) {
        signal.throwIfAborted();
        if (error) throw error;
        if (child.exitCode !== null)
          throw new Error(
            `ComfyUI 提前退出 (${child.exitCode})，请查看引擎日志`,
          );
        if (
          await comfyJson("/system_stats", { timeout: 1500 }).catch(() => null)
        ) {
          log("引擎已就绪");
          await inspect(true, signal);
          return;
        }
        await delay(1000, null, { signal });
      }
      throw new Error(
        "引擎启动超过 3 分钟，仍在后台运行。查看日志并重新检查；可用停止按钮结束本次启动。",
      );
    } finally {
      signal.removeEventListener("abort", cancel);
    }
  }
  async function stop() {
    await assertIdle();
    if (!managedChild || managedChild.exitCode !== null)
      throw new Error("这个引擎由外部程序启动，请在对应 ComfyUI 窗口中停止");
    const child = managedChild;
    await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("停止引擎超时，请查看 ComfyUI 进程")),
        10000,
      );
      child.once("close", () => {
        clearTimeout(timer);
        resolve();
      });
      child.kill();
    });
    managedChild = null;
    report = null;
  }
  const router = require("express").Router();
  router.use((req, res, next) => {
    try {
      const host = new URL("http://" + req.get("host"));
      if (!["127.0.0.1", "localhost", "[::1]"].includes(host.hostname))
        throw new Error("配置接口仅供本机访问");
      if (
        req.method !== "GET" &&
        (!req.is("application/json") ||
          (req.get("origin") && req.get("origin") !== host.origin))
      )
        throw new Error("配置操作需要来自本机工作台的 JSON 请求");
      next();
    } catch (error) {
      res.status(403).json({ error: error.message });
    }
  });
  router.get("/status", async (_req, res) => {
    const snapshot = report || (await inspect());
    const engineLog = fs.existsSync(path.join(dataDir, "comfy-engine.log"))
      ? (() => {
          const file = path.join(dataDir, "comfy-engine.log");
          const size = fs.statSync(file).size;
          const fd = fs.openSync(file, "r");
          const buffer = Buffer.alloc(Math.min(size, 16000));
          try {
            fs.readSync(
              fd,
              buffer,
              0,
              buffer.length,
              Math.max(0, size - buffer.length),
            );
            return buffer.toString();
          } finally {
            fs.closeSync(fd);
          }
        })()
      : "";
    res.json({
      runtime,
      report: snapshot,
      task: state.task,
      verification:
        state.verification?.fingerprint === fingerprint()
          ? state.verification
          : null,
      managed: !!managedChild && managedChild.exitCode === null,
      manifest: {
        checkedAt: manifest.checkedAt,
        comfyVersion: manifest.comfy.version,
      },
      suggestedInstallDir: path.join(os.homedir(), "QwenWorkbench"),
      engineLog,
    });
  });
  router.post("/config", async (req, res) => {
    try {
      if (active) throw new Error("请先等待配置操作结束");
      await assertIdle();
      const value = {
        comfyBase: absolute(req.body.comfyBase, "数据目录"),
        comfyMain: absolute(req.body.comfyMain, "ComfyUI 程序"),
        pythonPath: absolute(req.body.pythonPath, "Python 程序"),
        comfyUrl: localUrl(req.body.comfyUrl),
        lowVram: !!req.body.lowVram,
        proxyUrl: req.body.proxyUrl ? localUrl(req.body.proxyUrl) : "",
      };
      saveRuntime(value);
      state.verification = null;
      persist();
      res.json({ runtime, report: await inspect() });
    } catch (error) {
      res.status(400).json({ error: explain(error) });
    }
  });
  router.post("/action", async (req, res) => {
    try {
      const { action, directory, modelIds } = req.body;
      const ids = Array.isArray(modelIds)
        ? modelIds.filter((id) =>
            manifest.models.some((item) => item.id === id),
          )
        : manifest.models
            .filter((item) => !item.optional)
            .map((item) => item.id);
      const actions = {
        check: async (signal) => {
          await inspect(true, signal);
          log("环境检查完成");
        },
        install: (signal) => install(signal, absolute(directory, "安装目录")),
        download: (signal) => models(signal, ids),
        checksums: (signal) => models(signal, ids, true),
        start,
        stop,
        verify: async (signal) => {
          await assertIdle();
          const result = await inspect(true, signal);
          if (!result.ready)
            throw new Error("模型或节点未就绪，请先完成环境检查");
          if (result.engine?.devices?.every((device) => device.type !== "cuda"))
            throw new Error(
              "未检测到 CUDA 推理设备，此向导的试生成面向 NVIDIA GPU，请先检查驱动",
            );
          state.verification = {
            status: "running",
            fingerprint: fingerprint(),
            startedAt: Date.now(),
          };
          persist();
          log(
            "试生成：1024 × 1024，使用实际工作流、25 步。首次加载模型会较慢。",
          );
          try {
            const proof = await verify(signal, log);
            state.verification = {
              ...state.verification,
              ...proof,
              status: "passed",
              completedAt: Date.now(),
              confirmed: false,
            };
            persist();
            log("图片已生成并成功解码，请查看画面后确认内容");
          } catch (error) {
            state.verification = {
              ...state.verification,
              status: signal.aborted ? "cancelled" : "failed",
              error: explain(error),
            };
            persist();
            throw error;
          }
        },
      };
      if (!actions[action]) throw new Error("不支持的配置操作");
      res.status(202).json({ task: task(action, actions[action]) });
    } catch (error) {
      res.status(400).json({ error: explain(error) });
    }
  });
  router.post("/cancel", (_req, res) => {
    active?.abort();
    res.json({ cancelling: !!active });
  });
  router.post("/confirm", (_req, res) => {
    if (
      state.verification?.status !== "passed" ||
      state.verification.fingerprint !== fingerprint()
    )
      return res.status(400).json({ error: "请先完成试生成" });
    state.verification.confirmed = true;
    persist();
    res.json({ confirmed: true });
  });
  app.use("/api/setup", router);
  return {
    runtime,
    inspect,
    isBusy: () => !!active && state.task?.kind !== "check",
  };
}
module.exports = { createSetup, loadRuntime, localUrl };
