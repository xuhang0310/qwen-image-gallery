import { reactive, computed, watch, onBeforeUnmount } from "vue";
import defaults from "../../shared/config.json";
import { imageFileError } from "../image-upload";
import {
  attachImageEdit,
  failImageEdit,
  syncImageEdit,
} from "../../shared/image-edit.mjs";
import apiProfile from "../../shared/api-image.json";
import { mediaLibrary, assetOnBoard } from "../../shared/media-library.mjs";
import {
  imageProfile,
  imageModels,
  fitImageParameters,
} from "../../shared/image-models.mjs";
import {
  pending,
  availablePosition,
  normalizeJob,
  normalizeVideoJob,
  normalizeBoard,
  safeImageUrl,
  sourceUrl,
  request,
  jsonOptions,
} from "../domain";

const JOB_KEY = "qwen-image-gallery-jobs-v1";
const BOARD_KEY = "qwen-image-gallery-board-v1";
const BACKUP_KEY = "qwen-image-gallery-project-v2";
const NAV_KEY = "qwen-image-gallery-navigation-v1";
const read = (key, fallback) => {
  try {
    return JSON.parse(localStorage.getItem(key)) || fallback;
  } catch {
    return fallback;
  }
};
const normalizeEngine = (engine) => ({
  ...engine,
  model: imageProfile(engine.model)?.model || "gpt-image-2",
  models: imageModels(engine.models?.map((model) => model.id)),
});

export function useWorkbench() {
  const navigation = read(NAV_KEY, {});
  const s = reactive({
    ready: false,
    config: structuredClone(defaults),
    engine: {
      provider: "local",
      model: "gpt-image-2",
      baseUrl: "https://api.openai.com/v1",
      keyConfigured: false,
      models: apiProfile.models,
    },
    switching: false,
    jobs: [],
    videoJobs: [],
    videoEngine: { ready: false, checking: true },
    hiddenJobIds: [],
    libraryLoading: false,
    libraryError: "",
    canvasFocusId: null,
    board: normalizeBoard(),
    canUndoBoardClear: false,
    selectedJobId: null,
    submitting: false,
    preparing: 0,
    inFlight: 0,
    health: { state: "checking" },
    saved: "loading",
    saveError: "",
    revision: 0,
    currentProject: { id: navigation.projectId || "default", name: "默认项目" },
    projects: [],
    projectBusy: false,
    view: ["workbench", "projects", "library", "canvas", "settings"].includes(
      navigation.view,
    )
      ? navigation.view
      : "workbench",
    settingsTab: ["generation", "prompt-ai", "storage"].includes(
      navigation.settingsTab,
    )
      ? navigation.settingsTab
      : "generation",
    settingsProvider: null,
    settingsReturn: ["workbench", "projects", "library", "canvas"].includes(
      navigation.settingsReturn,
    )
      ? navigation.settingsReturn
      : "workbench",
    toast: "",
    get boardOpen() {
      return this.view === "canvas";
    },
    set boardOpen(open) {
      if (open) this.view = "canvas";
      else if (this.view === "canvas") this.view = "workbench";
    },
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
  const assets = computed(() => mediaLibrary(s.jobs, s.videoJobs));
  const modelConfigs = computed(() => ({
    local: { ...s.config, provider: "local", model: "Qwen Image 2.1" },
    ...Object.fromEntries(
      imageModels().map(({ id }) => [id, { ...s.config, ...imageProfile(id) }]),
    ),
  }));
  function engineSelection(selection = s.engine) {
    const provider = ["local", "api"].includes(selection?.provider)
      ? selection.provider
      : s.engine.provider;
    return {
      provider,
      model:
        provider === "api"
          ? imageProfile(selection?.model)?.model ||
            imageProfile(s.engine.model)?.model ||
            "gpt-image-2"
          : "Qwen Image 2.1",
    };
  }
  function generationConfigFor(selection) {
    const engine = engineSelection(selection);
    return modelConfigs.value[
      engine.provider === "api" ? engine.model : "local"
    ];
  }
  function setNodeEngine(node, selection) {
    const engine = engineSelection(selection);
    Object.assign(
      node,
      engine,
      fitImageParameters(node, generationConfigFor(engine)),
    );
  }
  function restoreNodeEngines(board) {
    for (const node of board.nodes)
      if (
        node.status === "text" &&
        !["video-generator", "video-prompt"].includes(node.kind)
      )
        setNodeEngine(node, node);
    return board;
  }
  const generationConfig = computed(() => generationConfigFor(s.engine));
  watch(
    generationConfig,
    (config) => {
      Object.assign(s.form, fitImageParameters(s.form, config));
    },
    { flush: "sync" },
  );
  const engineParameters = (selection) => {
    const engine = engineSelection(selection);
    return {
      provider: engine.provider,
      model: engine.provider === "api" ? engine.model : undefined,
    };
  };
  const qualityLabel = (job) => {
    return job?.provider === "api"
      ? ""
      : s.config.qualities[job?.quality]?.label || "";
  };
  let healthRequest = 0;
  let disposed = false,
    saveTimer,
    saveChain = Promise.resolve(),
    toastTimer,
    clearedBoard,
    uploadToken = 0,
    dirty = false,
    savingCount = 0,
    blockedSave = false,
    healthTimer;
  let submissionOrder = 0;
  const snapshot = () =>
    JSON.parse(
      JSON.stringify({
        projectId: s.currentProject.id,
        jobs: s.jobs,
        videoJobs: s.videoJobs,
        board: s.board,
        hiddenJobIds: s.hiddenJobIds,
      }),
    );
  // Only a submission from the main form locks that form briefly.
  const busy = () => s.submitting || s.switching || s.projectBusy;
  function toast(message) {
    s.toast = message;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (s.toast = ""), 4000);
  }
  function backup() {
    try {
      localStorage.setItem(
        BACKUP_KEY + ":" + s.currentProject.id,
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
        updateProjectSummary();
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
  function rememberNavigation() {
    try {
      localStorage.setItem(
        NAV_KEY,
        JSON.stringify({
          view: s.view,
          projectId: s.currentProject.id,
          settingsTab: s.settingsTab,
          settingsReturn: s.settingsReturn,
        }),
      );
    } catch {
      /* Navigation is still usable without browser storage. */
    }
  }
  watch(
    () => [s.view, s.currentProject.id, s.settingsTab, s.settingsReturn],
    rememberNavigation,
    {
      flush: "sync",
    },
  );
  function navigate(view) {
    if (
      !["workbench", "projects", "library", "canvas", "settings"].includes(
        view,
      ) ||
      s.projectBusy
    )
      return;
    if (view === "settings" && s.view !== "settings") s.settingsReturn = s.view;
    s.preview = null;
    s.view = view;
    if (view === "projects")
      void refreshProjects().catch((error) => toast(error.message));
    if (view === "library" && s.ready) void refreshLibrary();
  }
  async function refreshLibrary() {
    if (s.libraryLoading) return;
    s.libraryLoading = true;
    s.libraryError = "";
    try {
      const [images, videos] = await Promise.all([
        request("/api/jobs"),
        request("/api/videos/jobs"),
      ]);
      if (disposed) return;
      const merge = (current, latest, normalize) => {
        const map = new Map(current.map((job) => [job.id, job]));
        for (const value of latest) {
          const job = normalize(value);
          if (!job) continue;
          const existing = map.get(job.id);
          if (existing) Object.assign(existing, job);
          else map.set(job.id, job);
        }
        return [...map.values()].sort((a, b) => b.createdAt - a.createdAt);
      };
      s.jobs = merge(s.jobs, images.jobs || [], normalizeJob);
      s.videoJobs = merge(s.videoJobs, videos.jobs || [], normalizeVideoJob);
      for (const job of [...s.jobs, ...s.videoJobs]) {
        syncNode(job);
        if (pending(job)) {
          if (job.mediaType === "video") pollVideo(job.id);
          else pollJob(job.id);
        }
      }
    } catch (error) {
      s.libraryError = "素材加载失败：" + error.message;
    } finally {
      s.libraryLoading = false;
    }
  }
  function placeAsset(asset) {
    if (!s.ready || s.projectBusy) return;
    const existing = assetOnBoard(asset, s.board.nodes);
    const node =
      asset.mediaType === "video" ? addVideo(asset) : addImage(asset);
    if (!node) return;
    s.canvasFocusId = node.id;
    navigate("canvas");
    toast(existing ? "已定位到画布中的节点" : "已放入当前项目画布");
  }
  function openSettings(tab = "generation", provider = s.engine.provider) {
    s.settingsTab = tab;
    s.settingsProvider = provider;
    navigate("settings");
  }
  function updateProjectSummary() {
    const current = s.projects.find((p) => p.id === s.currentProject.id);
    if (current)
      Object.assign(current, {
        revision: s.revision,
        updatedAt: Date.now(),
        nodeCount: s.board.nodes.length,
        imageCount: s.board.nodes.filter(
          (n) => n.status === "done" && n.kind !== "video",
        ).length,
        videoCount: s.board.nodes.filter((n) => n.kind === "video").length,
        coverUrl:
          s.board.nodes.find(
            (n) => n.status === "done" && n.kind !== "video" && n.url,
          )?.thumbnailUrl ||
          s.board.nodes.find(
            (n) => n.status === "done" && n.kind !== "video" && n.url,
          )?.url ||
          null,
      });
  }
  async function refreshProjects() {
    const data = await request("/api/projects");
    s.projects = data.projects;
    return data;
  }
  async function openProject(id, view = "canvas") {
    if (s.projectBusy) return false;
    if (s.inFlight || s.preparing) {
      toast("请等待当前提交完成后再切换项目");
      return false;
    }
    s.projectBusy = true;
    try {
      await flush();
      if (s.saved === "error")
        throw new Error("当前画布尚未保存，请先重试保存后切换项目");
      const project = await request("/api/projects/" + encodeURIComponent(id));
      await request(
        "/api/projects/" + encodeURIComponent(id) + "/activate",
        jsonOptions({}),
      );
      s.ready = false;
      clearedBoard = null;
      s.canUndoBoardClear = false;
      s.canvasFocusId = null;
      s.currentProject = { id: project.id, name: project.name };
      s.revision = project.revision;
      s.board = restoreNodeEngines(normalizeBoard(project.board));
      s.hiddenJobIds = project.hiddenJobIds || [];
      s.jobs = [
        ...new Map(
          [
            ...(project.jobs || []).map(normalizeJob).filter(Boolean),
            ...s.jobs,
          ].map((j) => [j.id, j]),
        ).values(),
      ].sort((a, b) => b.createdAt - a.createdAt);
      s.videoJobs = [
        ...new Map(
          [
            ...(project.videoJobs || []).map(normalizeVideoJob).filter(Boolean),
            ...s.videoJobs,
          ].map((j) => [j.id, j]),
        ).values(),
      ].sort((a, b) => b.createdAt - a.createdAt);
      for (const job of [...s.jobs, ...s.videoJobs]) syncNode(job);
      for (const job of s.jobs.filter(pending)) pollJob(job.id);
      for (const job of s.videoJobs.filter(pending)) pollVideo(job.id);
      s.ready = true;
      dirty = false;
      blockedSave = false;
      s.saved = "saved";
      s.saveError = "";
      s.view = view;
      backup();
      return true;
    } catch (error) {
      toast(error.message);
      return false;
    } finally {
      s.projectBusy = false;
    }
  }
  async function createProject(name) {
    if (s.projectBusy || s.inFlight || s.preparing) {
      toast("请等待当前提交完成后再创建项目");
      return false;
    }
    try {
      await flush();
      if (s.saved === "error")
        throw new Error("当前画布尚未保存，请先重试保存");
      const project = await request("/api/projects", jsonOptions({ name }));
      await refreshProjects();
      return await openProject(project.id);
    } catch (error) {
      toast(error.message);
      return false;
    }
  }
  async function renameProject(id, name) {
    try {
      const project = await request(
        "/api/projects/" + encodeURIComponent(id),
        jsonOptions({ name }, "PATCH"),
      );
      if (id === s.currentProject.id) s.currentProject.name = project.name;
      await refreshProjects();
      return true;
    } catch (error) {
      toast(error.message);
      return false;
    }
  }
  async function deleteProject(id) {
    if (s.projectBusy || s.inFlight || s.preparing) return false;
    try {
      if (id === s.currentProject.id) {
        const next = s.projects.find((p) => p.id !== id);
        if (!next) throw new Error("请至少保留一个项目");
        if (!(await openProject(next.id, "projects"))) return false;
      }
      await request("/api/projects/" + encodeURIComponent(id), {
        method: "DELETE",
      });
      await refreshProjects();
      toast("项目已删除，素材文件和生成记录保留");
      return true;
    } catch (error) {
      toast(error.message);
      return false;
    }
  }
  watch(
    () => s.board,
    () => {
      if (
        s.canUndoBoardClear &&
        (s.board.nodes.length || s.board.edges.length)
      ) {
        clearedBoard = null;
        s.canUndoBoardClear = false;
      }
      changed();
    },
    { deep: true, flush: "sync" },
  );
  watch(
    () => [s.jobs, s.videoJobs, s.hiddenJobIds],
    () => {
      changed();
      if (s.ready) backup();
    },
    { deep: true, flush: "post" },
  );

  async function checkHealth() {
    const requestId = ++healthRequest;
    const provider = s.engine.provider;
    try {
      const result = await request("/api/health?provider=" + provider);
      if (requestId === healthRequest && provider === s.engine.provider) {
        s.health = {
          ...result,
          state: result.connected ? "online" : "offline",
        };
        if (provider === "api" && result.models)
          s.engine.models = imageModels(result.models.map((model) => model.id));
      }
    } catch (error) {
      if (requestId === healthRequest)
        s.health = { state: "offline", error: error.message };
    }
  }
  async function saveEngine(values) {
    if (s.switching) throw new Error("正在切换，请稍候");
    s.switching = true;
    try {
      s.engine = normalizeEngine(
        await request("/api/engine", jsonOptions(values)),
      );
      s.health = { state: "checking" };
      void checkHealth();
      return s.engine;
    } finally {
      s.switching = false;
    }
  }
  async function switchEngine(provider) {
    try {
      await saveEngine({ provider });
    } catch (error) {
      toast(error.message);
    }
  }
  function syncNode(job) {
    for (const node of s.board.nodes.filter(
      (n) => n.jobId === job.id || n.imageEdit?.jobId === job.id,
    )) {
      if (syncImageEdit(node, job)) {
        if (job.status === "completed" && job.imageUrl && node.jobId === job.id)
          node.assetIndex = 0;
        continue;
      }
      node.jobStatus = job.status;
      node.provider = job.provider || "local";
      node.model = job.model;
      if (job.mediaType === "video") {
        Object.assign(node, {
          kind: "video",
          ratio: job.ratio || "16:9",
          duration: job.duration,
          dialogue: job.dialogue,
          connectionError: job.connectionError,
          sampleStep: job.sampleStep,
          sampleTotal: job.sampleTotal,
          stage: job.stage,
        });
        if (job.status === "completed" && job.videoUrl)
          Object.assign(node, {
            status: "done",
            url: job.videoUrl,
            downloadUrl: job.downloadUrl,
            width: job.finalWidth || job.dimensions?.finalWidth,
            height: job.finalHeight || job.dimensions?.finalHeight,
          });
        else if (["failed", "cancelled"].includes(job.status))
          Object.assign(node, {
            status: "failed",
            error: job.error || "任务已结束",
          });
        continue;
      }
      if (job.status === "completed" && job.imageUrl) {
        const output = job.imageUrls?.[node.assetIndex || 0];
        const url = safeImageUrl(output?.url) ? output.url : job.imageUrl;
        Object.assign(node, {
          status: "done",
          url,
          thumbnailUrl: safeImageUrl(output?.thumbnailUrl)
            ? output.thumbnailUrl
            : url + "&thumbnail=1",
          width: job.finalWidth || job.width,
          height: job.finalHeight || job.height,
        });
      } else if (["failed", "cancelled"].includes(job.status))
        Object.assign(node, {
          status: "failed",
          error: job.error || "任务已结束",
        });
    }
  }
  async function checkVideoEngine() {
    s.videoEngine.checking = true;
    try {
      s.videoEngine = {
        ...(await request("/api/videos/config")),
        checking: false,
      };
    } catch (error) {
      s.videoEngine = { ready: false, checking: false, error: error.message };
    }
  }
  function pollVideo(id) {
    if (polls.has(id) || disposed) return;
    const poll = { failures: 0, timer: null, controller: null };
    polls.set(id, poll);
    async function tick() {
      const job = s.videoJobs.find((j) => j.id === id);
      if (!job || !pending(job) || disposed) return stopPoll(id);
      poll.controller = new AbortController();
      const timeout = setTimeout(() => poll.controller.abort(), 25000);
      try {
        const data = await request(
          "/api/videos/jobs/" + encodeURIComponent(id),
          { signal: poll.controller.signal },
        );
        if (polls.get(id) !== poll || !s.videoJobs.includes(job)) return;
        const normalized = normalizeVideoJob(data);
        if (!normalized) throw new Error("视频任务状态暂时不可用");
        Object.assign(job, normalized);
        delete job.connectionError;
        poll.failures = 0;
        syncNode(job);
        if (!pending(job)) return stopPoll(id);
      } catch (error) {
        if (polls.get(id) !== poll || disposed) return;
        job.connectionError = "连接暂时中断，自动重试中";
        syncNode(job);
        poll.failures++;
      } finally {
        clearTimeout(timeout);
      }
      if (polls.get(id) === poll)
        poll.timer = setTimeout(
          tick,
          Math.min(15000, 2500 * 2 ** Math.min(poll.failures, 3)),
        );
    }
    tick();
  }
  async function prepareVideo(parameters) {
    s.preparing++;
    try {
      return await request("/api/videos/prepare", {
        ...jsonOptions(parameters),
        signal: AbortSignal.timeout(150000),
      });
    } finally {
      s.preparing--;
    }
  }
  async function generateVideo(parameters, node) {
    s.inFlight++;
    try {
      const data = await request("/api/videos/generate", {
        ...jsonOptions(parameters),
        signal: AbortSignal.timeout(90000),
      });
      const job = normalizeVideoJob(data);
      if (!job) throw new Error("视频服务返回了无效任务");
      s.videoJobs.unshift(job);
      Object.assign(node, {
        jobId: job.id,
        jobStatus: job.status,
        duration: job.duration,
        createdAt: job.createdAt,
        kind: "video",
      });
      pollVideo(job.id);
      return job;
    } catch (error) {
      Object.assign(node, { status: "failed", error: error.message });
      toast(error.message);
      return null;
    } finally {
      s.inFlight--;
    }
  }
  function addVideo(job, position = { x: 200, y: 120 }) {
    const existing = s.board.nodes.find((n) => n.jobId === job.id);
    if (existing) return existing;
    const node = {
      id: crypto.randomUUID(),
      jobId: job.id,
      kind: "video",
      status: pending(job)
        ? "loading"
        : job.status === "completed"
          ? "done"
          : "failed",
      ...availablePosition(s.board.nodes, position, 300),
      prompt: job.prompt,
      dialogue: job.dialogue,
      ratio: job.ratio || "16:9",
      quality: job.quality,
      createdAt: job.createdAt,
      width: job.finalWidth || job.dimensions?.finalWidth,
      height: job.finalHeight || job.dimensions?.finalHeight,
    };
    s.board.nodes.push(node);
    syncNode(job);
    return node;
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
        if (data.imageSaveError && !job.imageSaveError)
          toast(data.imageSaveError);
        Object.assign(
          job,
          Object.fromEntries(
            Object.entries({
              status: data.status,
              error: data.error,
              dimensions: data.dimensions,
              usage: data.usage,
              apiResult: data.apiResult,
              savedImages: data.savedImages,
              imageSaveError: data.imageSaveError,
              completedAt: data.completedAt,
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
    let localBackup =
      read(BACKUP_KEY + ":" + s.currentProject.id, null) ||
      (s.currentProject.id === "default" ? read(BACKUP_KEY, null) : null);
    try {
      const [collection, data, config, videos] = await Promise.all([
        request("/api/projects"),
        request("/api/jobs"),
        request("/api/config"),
        request("/api/videos/jobs"),
      ]);
      s.projects = collection.projects;
      const id = collection.projects.some((p) => p.id === navigation.projectId)
        ? navigation.projectId
        : collection.activeProjectId;
      const project = await request("/api/projects/" + encodeURIComponent(id));
      s.currentProject = { id: project.id, name: project.name };
      localBackup =
        read(BACKUP_KEY + ":" + id, null) ||
        (id === "default" ? read(BACKUP_KEY, null) : null);
      Object.assign(s.config, config);
      if (config.engine) s.engine = normalizeEngine(config.engine);
      s.revision = project.revision;
      const restored = localBackup?.dirty
        ? localBackup
        : project.revision
          ? project
          : id === "default"
            ? { jobs: legacyJobs, board: legacyBoard, hiddenJobIds: [] }
            : project;
      s.hiddenJobIds = restored.hiddenJobIds || [];
      const map = new Map();
      // Database results are authoritative; browser snapshots carry legacy jobs.
      for (const job of [...(restored.jobs || []), ...(data.jobs || [])]
        .map(normalizeJob)
        .filter(Boolean))
        map.set(job.id, job);
      s.jobs = [...map.values()].sort((a, b) => b.createdAt - a.createdAt);
      s.videoJobs = [
        ...new Map(
          [...(restored.videoJobs || []), ...(videos.jobs || [])]
            .map(normalizeVideoJob)
            .filter(Boolean)
            .map((j) => [j.id, j]),
        ).values(),
      ].sort((a, b) => b.createdAt - a.createdAt);
      s.board = normalizeBoard(restored.board);
      s.saved = "saved";
    } catch (error) {
      s.libraryError = "素材加载失败：" + error.message;
      s.jobs = (localBackup?.jobs || legacyJobs)
        .map(normalizeJob)
        .filter(Boolean);
      s.board = normalizeBoard(localBackup?.board || legacyBoard);
      s.videoJobs = (localBackup?.videoJobs || [])
        .map(normalizeVideoJob)
        .filter(Boolean);
      s.saved = "error";
      s.saveError = "本地服务暂时不可用，已恢复浏览器备份";
      toast(error.message);
    }
    restoreNodeEngines(s.board);
    s.ready = true;
    for (const node of s.board.nodes) {
      if (node.imageEdit) {
        const editJob = s.jobs.find((j) => j.id === node.imageEdit.jobId);
        if (editJob) syncNode(editJob);
        else failImageEdit(node, "上次编辑已中断，原图已保留");
      }
      const job = [...s.jobs, ...s.videoJobs].find((j) => j.id === node.jobId);
      if (job) syncNode(job);
      else if (node.status === "loading")
        Object.assign(node, {
          status: "failed",
          error: "上次提交已中断，请重新生成",
        });
    }
    const visibleJobs = s.jobs.filter(
      (job) => !s.hiddenJobIds.includes(job.id),
    );
    s.selectedJobId =
      visibleJobs.find(pending)?.id || visibleJobs[0]?.id || null;
    for (const job of s.jobs.filter(pending)) pollJob(job.id);
    for (const job of s.videoJobs.filter(pending)) pollVideo(job.id);
    checkVideoEngine();
    changed();
    checkHealth();
    healthTimer = setInterval(checkHealth, 15000);
  }

  async function uploadSource(file) {
    const error = imageFileError(file);
    if (error) throw new Error(error);
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
      uploadStatus: "正在保存参考图…",
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

  async function generate(
    parameters,
    node = null,
    { replaceImage = false } = {},
  ) {
    if (!node && s.submitting) {
      toast("正在提交，请稍候");
      return null;
    }
    if (!node) s.submitting = true;
    s.inFlight++;
    const order = ++submissionOrder;
    const submittedAt = Date.now();
    const snapshotParams = JSON.parse(
      JSON.stringify({ ...engineParameters(), ...parameters }),
    );
    try {
      const data = await request("/api/generate", jsonOptions(snapshotParams));
      const job = {
        ...snapshotParams,
        ...data,
        id: data.promptId,
        status: "queued",
        createdAt: data.createdAt || submittedAt,
        ...data.dimensions,
        seed: data.seed,
      };
      s.jobs.unshift(job);
      s.jobs.sort((a, b) => b.createdAt - a.createdAt);
      if (order === submissionOrder) s.selectedJobId = job.id;
      if (node) {
        if (replaceImage) attachImageEdit(node, job);
        else {
          node.jobId = job.id;
          node.jobStatus = "queued";
          node.provider = job.provider;
          node.model = job.model;
        }
      }
      pollJob(job.id);
      return job;
    } catch (error) {
      if (node) {
        if (replaceImage) failImageEdit(node, error.message);
        else Object.assign(node, { status: "failed", error: error.message });
      }
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
      seed:
        s.engine.provider === "local" && f.fixedSeed
          ? Number(f.seed)
          : undefined,
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
      ...fitImageParameters(job, generationConfig.value),
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
      provider: job.provider || "local",
      model: job.provider === "api" ? job.model : undefined,
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
    // Removing a history entry does not remove its generated assets.
    if (!pending(job)) stopPoll(id);
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
      const result = await request(
        (job.mediaType === "video" ? "/api/videos/jobs/" : "/api/jobs/") +
          encodeURIComponent(job.id) +
          "/cancel",
        jsonOptions({}),
      );
      stopPoll(job.id);
      if (job.mediaType === "video") {
        Object.assign(job, normalizeVideoJob(result) || result);
        syncNode(job);
        return;
      }
      Object.assign(job, {
        status: result.status || "cancelled",
        error: result.error || "任务已取消",
      });
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
    const existing = assetOnBoard(
      { ...job, mediaType: "image" },
      s.board.nodes,
    );
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
      assetIndex: job.assetIndex || 0,
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
      provider: job.provider || "local",
      model: job.model,
    };
    s.board.nodes.push(node);
    return node;
  }
  function clearBoard() {
    if (!s.ready || !s.board.nodes.length) return;
    clearedBoard = s.board;
    s.board = normalizeBoard();
    s.canUndoBoardClear = true;
    toast("画布已清空，图片仍保留在图片库");
  }
  function undoClearBoard() {
    if (!s.ready || !clearedBoard) return;
    const restored = clearedBoard;
    clearedBoard = null;
    s.canUndoBoardClear = false;
    s.board = restored;
    for (const job of [...s.jobs, ...s.videoJobs]) syncNode(job);
    toast("已恢复画布");
  }
  function exportProject() {
    const content = JSON.stringify(
      {
        format: "qwen-workbench",
        version: 2,
        name: s.currentProject.name,
        ...snapshot(),
      },
      null,
      2,
    );
    const url = URL.createObjectURL(
      new Blob([content], { type: "application/json" }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download =
      s.currentProject.name.replace(/[<>:"/\\|?*]/g, "_") + ".json";
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
      if (s.inFlight || s.preparing)
        throw new Error("请等待当前提交完成后再导入项目");
      const jobs = data.jobs.map(normalizeJob);
      const videoJobs = (data.videoJobs || []).map(normalizeVideoJob);
      if (videoJobs.some((j) => !j)) throw new Error("项目包含无效的视频记录");
      if (jobs.some((j) => !j)) throw new Error("项目包含无效的历史记录");
      const board = restoreNodeEngines(normalizeBoard(data.board));
      if (
        board.nodes.length !== data.board.nodes.length ||
        board.edges.length !== data.board.edges.length
      )
        throw new Error("项目包含无效的节点或连线");
      await flush();
      if (s.saved === "error")
        throw new Error("当前画布尚未保存，请先重试保存");
      const project = await request(
        "/api/projects",
        jsonOptions({
          name: String(
            data.name || file.name.replace(/\.json$/i, "") || "导入项目",
          ).slice(0, 80),
          data: {
            jobs,
            videoJobs,
            board,
            hiddenJobIds: data.hiddenJobIds || [],
          },
        }),
      );
      await refreshProjects();
      if (await openProject(project.id)) toast("已导入为新项目");
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
    assets,
    refreshLibrary,
    placeAsset,
    initialize,
    busy,
    toast,
    flush,
    upload,
    uploadSource,
    removeSource,
    generate,
    generateVideo,
    prepareVideo,
    addVideo,
    checkVideoEngine,
    submitForm,
    retry,
    deleteJob,
    cancel,
    clearHistory,
    addImage,
    clearBoard,
    undoClearBoard,
    exportProject,
    importProject,
    checkHealth,
    sourceUrl,
    generationConfig,
    generationConfigFor,
    engineSelection,
    setNodeEngine,
    engineParameters,
    qualityLabel,
    saveEngine,
    switchEngine,
    navigate,
    openSettings,
    refreshProjects,
    openProject,
    createProject,
    renameProject,
    deleteProject,
  };
}
