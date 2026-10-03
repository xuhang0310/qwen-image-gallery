import defaults from "../shared/config.json";
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
  });
export const nodeWidth = (node) => (node.status === "text" ? 480 : 220);
export const nodeHeight = (node) =>
  node.status === "text"
    ? 440
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
  if (
    !job ||
    typeof job.id !== "string" ||
    typeof job.prompt !== "string" ||
    !Number.isFinite(job.createdAt) ||
    !Object.hasOwn(defaults.ratios, job.ratio) ||
    !Object.hasOwn(defaults.qualities, job.quality) ||
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
        (n.url && !safeImageUrl(n.url))
      )
        return false;
      ids.add(n.id);
      return true;
    })
    .map((n) => {
      const node = { ...n, prompt: String(n.prompt || "").slice(0, 4000) };
      if (node.uploading)
        Object.assign(node, {
          status: "empty",
          uploading: false,
          error: "上次上传已中断，请重新上传",
        });
      if (node.ratio && !Object.hasOwn(defaults.ratios, node.ratio))
        node.ratio = "9:16";
      if (node.quality && !Object.hasOwn(defaults.qualities, node.quality))
        node.quality = "2K";
      return node;
    });
  return {
    nodes,
    edges: (Array.isArray(board.edges) ? board.edges : []).filter(
      (e) =>
        typeof e?.id === "string" &&
        ids.has(e.from) &&
        ids.has(e.to) &&
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
