import { reactive, watch, onBeforeUnmount } from "vue";
import defaults from "../../shared/config.json";
import {
  pending,
  availablePosition,
  normalizeJob,
  normalizeBoard,
  sourceUrl,
  request,
  jsonOptions,
} from "../domain";

const JOB_KEY = "qwen-image-gallery-jobs-v1";
const BOARD_KEY = "qwen-image-gallery-board-v1";
const BACKUP_KEY = "qwen-image-gallery-project-v2";
const read = (key, fallback) => {
  try {
    return JSON.parse(localStorage.getItem(key)) || fallback;
  } catch {
    return fallback;
  }
};

export function useWorkbench() {
  const s = reactive({
    ready: false,
    config: structuredClone(defaults),
    jobs: [],
    hiddenJobIds: [],
    board: normalizeBoard(),
    selectedJobId: null,
    submitting: false,
    preparing: 0,
    inFlight: 0,
    health: { state: "checking" },
    saved: "loading",
    saveError: "",
    revision: 0,
    toast: "",
    boardOpen: false,
    preview: null,
    form: {
      prompt: "",
      negativePrompt: "",
      ratio: "9:16",
      quality: "2K",
      fixedSeed: false,
      seed: "",
      mode: "txt2img",
      sourceImage: null,
      uploading: false,
      uploadStatus: "",
    },
  });
  const polls = new Map();
  let disposed = false,
    saveTimer,
    saveChain = Promise.resolve(),
    toastTimer,
    uploadToken = 0,
    dirty = false,
    savingCount = 0,
    blockedSave = false,
    healthTimer;
  let submissionOrder = 0;
  const snapshot = () =>
    JSON.parse(
      JSON.stringify({
        jobs: s.jobs,
        board: s.board,
        hiddenJobIds: s.hiddenJobIds,
      }),
    );
  // Only a submission from the main form locks that form briefly.
  const busy = () => s.submitting;
  const hasActiveJobs = () =>
    s.inFlight > 0 || s.preparing > 0 || s.jobs.some(pending);
  function toast(message) {
    s.toast = message;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (s.toast = ""), 4000);
  }
  function backup() {
    try {
      localStorage.setItem(
        BACKUP_KEY,
        JSON.stringify({
          ...snapshot(),
          dirty: dirty || savingCount > 0,
          savedAt: Date.now(),
        }),
      );
      localStorage.setItem(JOB_KEY, JSON.stringify(s.jobs));
      localStorage.setItem(BOARD_KEY, JSON.stringify(s.board));
    } catch {
      s.saveError = "浏览器备份空间不足，项目仍会保存到本地服务";
    }
  }
  function flush() {
    clearTimeout(saveTimer);
    if (!s.ready || !dirty || blockedSave) return saveChain;
    const data = snapshot();
    dirty = false;
    savingCount++;
    saveChain = saveChain.then(async () => {
      if (blockedSave || disposed) {
        dirty = true;
        savingCount--;
        return;
      }
      s.saved = "saving";
      try {
        const result = await request(
          "/api/project",
          jsonOptions({ ...data, revision: s.revision }, "PUT"),
        );
        s.revision = result.revision;
        s.saved = dirty || savingCount > 1 ? "saving" : "saved";
        s.saveError = "";
      } catch (error) {
        dirty = true;
        s.saved = "error";
        s.saveError = error.message;
        if (error.status === 409) {
          blockedSave = true;
          toast(error.message);
        } else if (!disposed) saveTimer = setTimeout(flush, 5000);
      } finally {
        savingCount--;
        backup();
      }
    });
    return saveChain;
  }
  function changed() {
    if (!s.ready) return;
    dirty = true;
    s.saved = "saving";
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      backup();
      flush();
    }, 300);
  }
  watch(() => s.board, changed, { deep: true, flush: "sync" });
  watch(
    () => [s.jobs, s.hiddenJobIds],
    () => {
      changed();
      if (s.ready) backup();
    },
    { deep: true, flush: "post" },
  );

  async function checkHealth() {
    try {
      const result = await request("/api/health");
      s.health = { ...result, state: result.connected ? "online" : "offline" };
    } catch (error) {
      s.health = { state: "offline", error: error.message };
    }
  }
  function syncNode(job) {
    for (const node of s.board.nodes.filter((n) => n.jobId === job.id)) {
      node.jobStatus = job.status;
      if (job.status === "completed" && job.imageUrl)
        Object.assign(node, {
          status: "done",
          url: job.imageUrl,
          thumbnailUrl: job.thumbnailUrl,
          width: job.finalWidth || job.width,
          height: job.finalHeight || job.height,
        });
      else if (["failed", "cancelled"].includes(job.status))
        Object.assign(node, {
          status: "failed",
          error: job.error || "任务已结束",
        });
    }
  }
  function stopPoll(id) {
    const poll = polls.get(id);
    if (poll) {
      clearTimeout(poll.timer);
      poll.controller?.abort();
      polls.delete(id);
    }
  }
  function pollJob(id) {
    if (polls.has(id) || disposed) return;
    const poll = { failures: 0, timer: null, controller: null };
    polls.set(id, poll);
    async function tick() {
      const job = s.jobs.find((j) => j.id === id);
      if (!job || !pending(job) || disposed) return stopPoll(id);
      poll.controller = new AbortController();
      const timeout = setTimeout(() => poll.controller.abort(), 25000);
      try {
        const data = await request("/api/jobs/" + encodeURIComponent(id), {
          signal: poll.controller.signal,
        });
        if (polls.get(id) !== poll || !s.jobs.includes(job)) return;
        if (
          !["queued", "running", "completed", "failed", "cancelled"].includes(
            data.status,
          )
        )
          throw new Error("任务状态暂时不可用");
        Object.assign(
          job,
          Object.fromEntries(
            Object.entries({
              status: data.status,
              error: data.error,
              ...data.dimensions,
              seed: data.seed,
              imageUrl: data.imageUrls?.[0]?.url,
              thumbnailUrl: data.imageUrls?.[0]?.thumbnailUrl,
              downloadUrl: data.imageUrls?.[0]?.downloadUrl,
            }).filter(([, v]) => v !== undefined),
          ),
        );
        delete job.connectionError;
        poll.failures = 0;
        syncNode(job);
        if (!pending(job)) {
          stopPoll(id);
          if (
            job.status === "completed" &&
            !s.board.nodes.some((n) => n.jobId === id)
          )
            addImage(job);
          return;
        }
      } catch (error) {
        if (polls.get(id) !== poll || disposed) return;
        // A failed status request does not mean the GPU task has failed.
        job.connectionError = "连接暂时中断，自动重试中";
        poll.failures++;
      } finally {
        clearTimeout(timeout);
      }
      if (polls.get(id) === poll)
        poll.timer = setTimeout(
          tick,
          Math.min(15000, 1500 * 2 ** Math.min(poll.failures, 4)),
        );
    }
    tick();
  }
  async function initialize() {
    const legacyJobs =
      read(JOB_KEY, []).map?.(normalizeJob).filter(Boolean) || [];
    const legacyBoard = normalizeBoard(read(BOARD_KEY, {}));
    const localBackup = read(BACKUP_KEY, null);
    try {
      const [project, data, config] = await Promise.all([
        request("/api/project"),
        request("/api/jobs"),
        request("/api/config"),
      ]);
      Object.assign(s.config, config);
      s.revision = project.revision;
      const restored = localBackup?.dirty
        ? localBackup
        : project.revision
          ? project
          : { jobs: legacyJobs, board: legacyBoard, hiddenJobIds: [] };
      s.hiddenJobIds = restored.hiddenJobIds || [];
      const map = new Map();
      // Database results are authoritative; browser snapshots carry legacy jobs.
      for (const job of [...(restored.jobs || []), ...(data.jobs || [])]
        .map(normalizeJob)
        .filter(Boolean))
        if (!s.hiddenJobIds.includes(job.id) || pending(job))
          map.set(job.id, job);
      s.jobs = [...map.values()].sort((a, b) => b.createdAt - a.createdAt);
      s.board = normalizeBoard(restored.board);
      s.saved = "saved";
    } catch (error) {
      s.jobs = (localBackup?.jobs || legacyJobs)
        .map(normalizeJob)
        .filter(Boolean);
      s.board = normalizeBoard(localBackup?.board || legacyBoard);
      s.saved = "error";
      s.saveError = "本地服务暂时不可用，已恢复浏览器备份";
      toast(error.message);
    }
    s.ready = true;
    for (const node of s.board.nodes) {
      const job = s.jobs.find((j) => j.id === node.jobId);
      if (job) syncNode(job);
      else if (node.status === "loading")
        Object.assign(node, {
          status: "failed",
          error: "上次提交已中断，请重新生成",
        });
    }
    s.selectedJobId = s.jobs.find(pending)?.id || s.jobs[0]?.id || null;
    for (const job of s.jobs.filter(pending)) pollJob(job.id);
    changed();
    checkHealth();
    healthTimer = setInterval(checkHealth, 15000);
  }

  async function uploadSource(file) {
    if (
      !file ||
      file.size > 10 * 1024 * 1024 ||
      !["image/png", "image/jpeg", "image/webp"].includes(file.type)
    )
      throw new Error("请选择 10MB 以内的 PNG、JPEG 或 WebP");
    const body = new FormData();
    body.append("image", file);
    return (await request("/api/upload", { method: "POST", body })).sourceImage;
  }
  async function upload(file) {
    if (!file) return;
    const token = ++uploadToken;
    Object.assign(s.form, {
      sourceImage: null,
      uploading: true,
      uploadStatus: "正在上传到本地 ComfyUI…",
    });
    try {
      const source = await uploadSource(file);
      if (token === uploadToken)
        Object.assign(s.form, {
          sourceImage: source,
          uploadStatus: "原图已上传，可以按提示词编辑",
        });
    } catch (error) {
      if (token === uploadToken) {
        s.form.uploadStatus = error.message;
        toast(error.message);
      }
    } finally {
      if (token === uploadToken) s.form.uploading = false;
    }
  }
  function removeSource() {
    ++uploadToken;
    Object.assign(s.form, {
      sourceImage: null,
      uploading: false,
      uploadStatus: "原图已移除",
    });
  }

  async function generate(parameters, node = null) {
    if (!node && s.submitting) {
      toast("正在提交，请稍候");
      return null;
    }
    if (!node) s.submitting = true;
    s.inFlight++;
    const order = ++submissionOrder;
    const submittedAt = Date.now();
    const snapshotParams = JSON.parse(JSON.stringify(parameters));
    try {
      const data = await request("/api/generate", jsonOptions(snapshotParams));
      const job = {
        ...snapshotParams,
        id: data.promptId,
        status: "queued",
        createdAt: data.createdAt || submittedAt,
        ...data.dimensions,
        seed: data.seed,
      };
      s.jobs.unshift(job);
      s.jobs.sort((a, b) => b.createdAt - a.createdAt);
      if (order === submissionOrder) s.selectedJobId = job.id;
      if (node && s.board.nodes.includes(node)) {
        node.jobId = job.id;
        node.jobStatus = "queued";
      }
      pollJob(job.id);
      return job;
    } catch (error) {
      if (node && s.board.nodes.includes(node))
        Object.assign(node, { status: "failed", error: error.message });
      toast(error.message);
      return null;
    } finally {
      s.inFlight--;
      if (!node) s.submitting = false;
    }
  }
  function submitForm() {
    const f = s.form;
    if (
      !f.prompt.trim() ||
      busy() ||
      (f.mode === "img2img" && (f.uploading || !f.sourceImage))
    )
      return;
    return generate({
      prompt: f.prompt.trim(),
      negativePrompt: f.negativePrompt.trim(),
      ratio: f.ratio,
      quality: f.quality,
      seed: f.fixedSeed ? Number(f.seed) : undefined,
      mode: f.mode,
      sourceImage: f.mode === "img2img" ? f.sourceImage : undefined,
    });
  }
  function retry(job) {
    if (busy()) return;
    ++uploadToken;
    Object.assign(s.form, {
      prompt: job.prompt,
      negativePrompt: job.negativePrompt || "",
      ratio: job.ratio,
      quality: job.quality,
      fixedSeed: true,
      seed: job.seed ?? "",
      mode: job.mode || "txt2img",
      sourceImage: job.sourceImage || null,
      uploading: false,
      uploadStatus: job.sourceImage
        ? "已恢复历史原图；若文件已移除，请重新上传"
        : "",
    });
    return generate({
      prompt: job.prompt,
      negativePrompt: job.negativePrompt || "",
      ratio: job.ratio,
      quality: job.quality,
      seed: job.seed,
      mode: job.mode || "txt2img",
      sourceImage: job.sourceImage,
    });
  }
  function deleteJob(id) {
    const job = s.jobs.find((j) => j.id === id);
    // Hidden pending tasks keep their independent polling and recover on reload.
    if (!pending(job)) {
      stopPoll(id);
      s.jobs = s.jobs.filter((j) => j.id !== id);
    }
    s.hiddenJobIds = [...new Set([...s.hiddenJobIds, id])];
    if (s.selectedJobId === id) s.selectedJobId = null;
    if (job && pending(job))
      for (const node of s.board.nodes.filter(
        (n) => n.jobId === id && n.status === "loading",
      ))
        Object.assign(node, {
          status: "failed",
          error: "记录已移除，后台任务可能仍在运行",
        });
  }
  async function cancel(job) {
    try {
      await request(
        "/api/jobs/" + encodeURIComponent(job.id) + "/cancel",
        jsonOptions({}),
      );
      stopPoll(job.id);
      Object.assign(job, { status: "cancelled", error: "任务已取消" });
      syncNode(job);
    } catch (error) {
      toast(error.message);
    }
  }
  function clearHistory() {
    for (const job of [...s.jobs]) if (!pending(job)) deleteJob(job.id);
    toast("已清除结束的记录，正在执行的任务保留");
  }
  function addImage(job, position = null) {
    const existing = s.board.nodes.find((n) => n.jobId === job.id);
    if (existing) return existing;
    position ||= availablePosition(
      s.board.nodes,
      { x: 200, y: 120 },
      (220 * (job.finalHeight || job.height || 1)) /
        (job.finalWidth || job.width || 1) +
        32,
    );
    const node = {
      id: crypto.randomUUID(),
      jobId: job.id,
      status: "done",
      x: position.x,
      y: position.y,
      url: job.imageUrl,
      thumbnailUrl: job.thumbnailUrl,
      width: job.finalWidth || job.width,
      height: job.finalHeight || job.height,
      prompt: job.prompt,
      ratio: job.ratio,
      quality: job.quality,
    };
    s.board.nodes.push(node);
    return node;
  }
  function exportProject() {
    const content = JSON.stringify(
      { format: "qwen-workbench", version: 2, ...snapshot() },
      null,
      2,
    );
    const url = URL.createObjectURL(
      new Blob([content], { type: "application/json" }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = "qwen-project.json";
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  async function importProject(file) {
    try {
      if (!file || file.size > 16 * 1024 * 1024)
        throw new Error("项目文件不能超过 16MB");
      const data = JSON.parse(await file.text());
      if (
        data.format !== "qwen-workbench" ||
        data.version !== 2 ||
        !Array.isArray(data.jobs) ||
        !data.board ||
        !Array.isArray(data.board.nodes) ||
        !Array.isArray(data.board.edges)
      )
        throw new Error("请选择有效的 Qwen 项目文件");
      if (hasActiveJobs()) throw new Error("请等待当前任务结束后再导入项目");
      const jobs = data.jobs.map(normalizeJob);
      if (jobs.some((j) => !j)) throw new Error("项目包含无效的历史记录");
      const board = normalizeBoard(data.board);
      if (
        board.nodes.length !== data.board.nodes.length ||
        board.edges.length !== data.board.edges.length
      )
        throw new Error("项目包含无效的节点或连线");
      await flush();
      const result = await request(
        "/api/project",
        jsonOptions(
          {
            jobs,
            board,
            hiddenJobIds: data.hiddenJobIds || [],
            revision: s.revision,
          },
          "PUT",
        ),
      );
      s.ready = false;
      s.revision = result.revision;
      s.jobs = jobs;
      s.board = board;
      s.hiddenJobIds = data.hiddenJobIds || [];
      s.selectedJobId = jobs[0]?.id || null;
      s.ready = true;
      blockedSave = false;
      dirty = false;
      s.saved = "saved";
      s.saveError = "";
      backup();
      for (const job of jobs.filter(pending)) pollJob(job.id);
      toast("项目已导入");
    } catch (error) {
      toast(error.message);
    }
  }
  function unload() {
    backup();
  }
  document.addEventListener("visibilitychange", flush);
  window.addEventListener("pagehide", unload);
  onBeforeUnmount(() => {
    disposed = true;
    for (const id of polls.keys()) stopPoll(id);
    clearTimeout(saveTimer);
    clearInterval(healthTimer);
    clearTimeout(toastTimer);
    document.removeEventListener("visibilitychange", flush);
    window.removeEventListener("pagehide", unload);
  });
  return {
    s,
    initialize,
    busy,
    toast,
    flush,
    upload,
    uploadSource,
    removeSource,
    generate,
    submitForm,
    retry,
    deleteJob,
    cancel,
    clearHistory,
    addImage,
    exportProject,
    importProject,
    checkHealth,
    sourceUrl,
  };
}
