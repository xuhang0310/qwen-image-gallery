import defaults from "../shared/config.json";
import { validateVideoPromptNode } from "../shared/video-review.mjs";
import { validateInlineVideoCache } from "../shared/video-inline.mjs";
import { imageProfile, imageModels } from "../shared/image-models.mjs";
import {
  safeVideoUrl,
  videoQualities,
  videoRatios,
  videoDurations,
} from "../shared/video.mjs";
export const pending = (job) => ["queued", "running"].includes(job?.status);
export const label = (status) =>
  ({
    queued: "排队中",
    running: "生成中",
    completed: "已完成",
    failed: "失败",
    cancelled: "已取消",
  })[status] || status;
export const summarize = (text, length = 34) =>
  String(text || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, length) || "未命名画面";
export function imageRatio(width, height) {
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width <= 0 ||
    height <= 0
  )
    return "";
  let a = width,
    b = height;
  while (b) [a, b] = [b, a % b];
  return `${width / a}:${height / a}`;
}
export function jobRatio(job) {
  if (job?.provider === "api" && job.status === "completed") {
    return (
      imageRatio(
        job.dimensions?.finalWidth || job.finalWidth,
        job.dimensions?.finalHeight || job.finalHeight,
      ) || job.ratio
    );
  }
  return job?.ratio || "";
}
export const safeImageUrl = (url) =>
  typeof url === "string" &&
  /^\/api\/images\/(view|download)\?/.test(url) &&
  !/[\r\n]/.test(url);
export const sourceUrl = (source) =>
  "/api/images/view?" +
  new URLSearchParams({
    filename: source.name,
    subfolder: source.subfolder,
    type: source.type,
    ...(source.provider === "api" ? { provider: "api" } : {}),
  });
export const nodeWidth = (node) =>
  node.status === "text" ? 480 : node.kind === "video" ? 360 : 220;
export const nodeHeight = (node) =>
  node.status === "text"
    ? node.kind === "video-generator"
      ? 650
      : node.kind === "video-prompt"
        ? 800
        : 490
    : node.kind === "video"
      ? node.status === "done" && node.width && node.height
        ? (360 * node.height) / node.width + 100
        : 300
      : node.width && node.height
        ? (220 * node.height) / node.width + 32
        : 260;
export function availablePosition(nodes, position, height = 260) {
  const result = { ...position };
  for (let i = 0; i <= nodes.length; i++) {
    const overlaps = nodes.filter((node) => {
      return (
        result.x < node.x + nodeWidth(node) + 40 &&
        result.x + 260 > node.x &&
        result.y < node.y + nodeHeight(node) + 40 &&
        result.y + height + 40 > node.y
      );
    });
    if (!overlaps.length) break;
    result.y = Math.max(
      ...overlaps.map((node) => node.y + nodeHeight(node) + 40),
    );
  }
  return result;
}
export function normalizeJob(job) {
  const config =
    job?.provider === "api"
      ? imageProfile(job.model || "gpt-image-2")
      : defaults;
  if (
    !job ||
    typeof job.id !== "string" ||
    typeof job.prompt !== "string" ||
    !Number.isFinite(job.createdAt) ||
    !config ||
    !Object.hasOwn(config.ratios, job.ratio) ||
    !Object.hasOwn(config.qualities, job.quality) ||
    !["queued", "running", "completed", "failed", "cancelled"].includes(
      job.status,
    )
  )
    return null;
  const image = job.imageUrls?.[0];
  const normalized = {
    ...job,
    imageUrl: image?.url || job.imageUrl,
    thumbnailUrl: image?.thumbnailUrl || job.thumbnailUrl,
    downloadUrl: image?.downloadUrl || job.downloadUrl,
  };
  if (
    [normalized.imageUrl, normalized.thumbnailUrl, normalized.downloadUrl].some(
      (url) => url && !safeImageUrl(url),
    )
  )
    return null;
  return {
    ...normalized,
    ...job.dimensions,
    prompt: job.prompt.slice(0, 4000),
  };
}
export function normalizeVideoJob(job) {
  if (
    !job ||
    job.mediaType !== "video" ||
    typeof job.id !== "string" ||
    typeof job.prompt !== "string" ||
    !Number.isFinite(job.createdAt) ||
    !Object.hasOwn(videoQualities, job.quality) ||
    (job.ratio !== undefined && !Object.hasOwn(videoRatios, job.ratio)) ||
    !["queued", "running", "completed", "failed", "cancelled"].includes(
      job.status,
    ) ||
    (job.videoUrl && !safeVideoUrl(job.videoUrl)) ||
    (job.downloadUrl && !safeVideoUrl(job.downloadUrl))
  )
    return null;
  return { ...job, ...job.dimensions, ratio: job.ratio || "16:9" };
}
export function normalizeBoard(board = {}) {
  const ids = new Set();
  const nodes = (Array.isArray(board.nodes) ? board.nodes : [])
    .filter((n) => {
      if (
        !n ||
        typeof n.id !== "string" ||
        ids.has(n.id) ||
        !Number.isFinite(n.x) ||
        !Number.isFinite(n.y) ||
        !["done", "loading", "failed", "empty", "text"].includes(n.status) ||
        (n.url &&
          !(n.kind === "video" ? safeVideoUrl(n.url) : safeImageUrl(n.url))) ||
        (n.kind === "video" && n.downloadUrl && !safeVideoUrl(n.downloadUrl))
      )
        return false;
      ids.add(n.id);
      return true;
    })
    .map((n) => {
      const node = { ...n, prompt: String(n.prompt || "").slice(0, 4000) };
      if (
        node.originalPrompt !== undefined &&
        (typeof node.originalPrompt !== "string" ||
          node.originalPrompt.length > 4000)
      )
        delete node.originalPrompt;
      if (
        node.imageEdit &&
        (!node.imageEdit.jobId ||
          typeof node.imageEdit.parameters?.prompt !== "string")
      ) {
        delete node.imageEdit;
        node.imageEditError = "上次编辑已中断，原图已保留";
      }
      if (node.kind === "video-prompt") {
        try {
          validateVideoPromptNode(node);
        } catch {
          return null;
        }
        node.status = "text";
        if (node.referenceUrl && !safeImageUrl(node.referenceUrl))
          delete node.referenceUrl;
        if (node.reviewPending)
          node.reviewError = "上次整理已中断，请重新整理提示词。";
        node.reviewPending = false;
        node.aiWriting = false;
        node.confirmPending = false;
        return node;
      }
      if (node.kind === "video-generator" || node.kind === "video") {
        if (!Object.hasOwn(videoRatios, node.ratio)) node.ratio = "16:9";
        if (!Object.hasOwn(videoQualities, node.quality)) node.quality = "480P";
        node.dialogue = String(node.dialogue || "").slice(0, 200);
        if (node.kind === "video-generator") {
          node.status = "text";
          node.referencesUploading = false;
          if (node.inlinePending)
            node.inlineError = "上次提示词处理已中断，可以重新优化或生成视频。";
          node.inlinePending = false;
          try {
            validateInlineVideoCache(node.inlineVideo);
          } catch {
            delete node.inlineVideo;
          }
          if (!videoDurations.includes(node.seconds)) node.seconds = 6;
          if (!["contain", "cover", "front"].includes(node.framing))
            node.framing = "contain";
        }
        if (node.duration && !Number.isFinite(node.duration))
          delete node.duration;
        return node;
      }
      if (node.uploading)
        Object.assign(node, {
          status: "empty",
          uploading: false,
          error: "上次上传已中断，请重新上传",
        });
      const apiConfigs = imageModels().map((model) => imageProfile(model.id));
      if (
        node.ratio &&
        !Object.hasOwn(defaults.ratios, node.ratio) &&
        !apiConfigs.some((config) => Object.hasOwn(config.ratios, node.ratio))
      )
        node.ratio = "9:16";
      if (
        node.quality &&
        !Object.hasOwn(defaults.qualities, node.quality) &&
        !apiConfigs.some((config) =>
          Object.hasOwn(config.qualities, node.quality),
        )
      )
        node.quality = "2K";
      return node;
    })
    .filter(Boolean);
  const keptIds = new Set(nodes.map((n) => n.id));
  return {
    nodes,
    edges: (Array.isArray(board.edges) ? board.edges : []).filter(
      (e) =>
        typeof e?.id === "string" &&
        keptIds.has(e.from) &&
        keptIds.has(e.to) &&
        e.from !== e.to &&
        ["left", "right"].includes(e.fromSide) &&
        ["left", "right"].includes(e.toSide),
    ),
    pan:
      Number.isFinite(board.pan?.x) && Number.isFinite(board.pan?.y)
        ? { ...board.pan }
        : { x: 0, y: 0 },
    zoom: Number.isFinite(board.zoom)
      ? Math.max(0.1, Math.min(4, board.zoom))
      : 1,
  };
}
export async function request(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    signal: options.signal || AbortSignal.timeout(25000),
  });
  let data;
  try {
    data = await response.json();
  } catch {
    throw new Error("服务返回了无法读取的内容");
  }
  if (!response.ok) {
    const error = new Error(data.error || "请求失败");
    Object.assign(error, {
      status: response.status,
      recoverable: data.recoverable,
      code: data.code,
      draft: data.draft,
    });
    throw error;
  }
  return data;
}
export const jsonOptions = (body, method = "POST") => ({
  method,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});
