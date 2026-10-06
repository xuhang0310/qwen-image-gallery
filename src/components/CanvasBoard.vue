<script setup>
import EngineSwitch from "./EngineSwitch.vue";
import { useFileDrop, hasFiles } from "../composables/useFileDrop";
import { imageFileError } from "../image-upload";
import { beginImageEdit, failImageEdit } from "../../shared/image-edit.mjs";
import {
  ref,
  reactive,
  computed,
  watch,
  nextTick,
  onMounted,
  onBeforeUnmount,
} from "vue";
import BoardNode from "./BoardNode.vue";
import SafeImage from "./SafeImage.vue";
import GenerationComposer from "./GenerationComposer.vue";
import AppIcon from "./AppIcon.vue";
import { videoDimensions } from "../../shared/video.mjs";
import { videoReviewReady } from "../../shared/video-review.mjs";
import { confirmVideoReview } from "../../shared/video-confirm.mjs";
import {
  inlineVideoAction,
  inlineVideoInputSignature,
} from "../../shared/video-inline.mjs";
import {
  pending,
  summarize,
  sourceUrl,
  availablePosition,
  nodeWidth,
  nodeHeight,
  jobRatio,
} from "../domain";
const props = defineProps({ store: Object });
defineEmits(["configure-engine"]);
const { s } = props.store;
const submittingParents = reactive(new Set());
const viewport = ref(),
  world = ref(),
  fileInput = ref(),
  closeButton = ref(),
  editComposer = ref();
const selected = ref(null),
  selectedEdge = ref(null),
  edit = ref(null),
  menu = ref(null),
  temporaryPath = ref("");
const sizes = reactive(new Map());
const fileDrop = useFileDrop(dropFiles);
const draggingFiles = fileDrop.active;
const board = computed(() => s.board);
const nodeMap = computed(
  () => new Map(board.value.nodes.map((n) => [n.id, n])),
);
const references = computed(() => {
  const map = new Map();
  for (const edge of board.value.edges) {
    const source = nodeMap.value.get(edge.from);
    if (source?.url && source.kind !== "video")
      map.set(edge.to, [...(map.get(edge.to) || []), source]);
  }
  return map;
});
const form = reactive({
  prompt: "",
  ratio: "9:16",
  quality: "2K",
  source: null,
  target: null,
});
const libraryCount = ref(30);
const libraryType = ref("image");
const library = computed(() =>
  (libraryType.value === "video" ? s.videoJobs : s.jobs)
    .filter(
      (j) =>
        (libraryType.value === "video" ||
          (j.status === "completed" && j.imageUrl)) &&
        !s.hiddenJobIds.includes(j.id),
    )
    .slice(0, libraryCount.value),
);
const transform = computed(() => ({
  transform: `translate(${board.value.pan.x}px, ${board.value.pan.y}px) scale(${board.value.zoom})`,
}));
const background = computed(() => ({
  backgroundSize: `${44 * board.value.zoom}px ${44 * board.value.zoom}px`,
  backgroundPosition: `${board.value.pan.x}px ${board.value.pan.y}px`,
}));
// Keep off-screen images out of the DOM while preserving selected/editable nodes.
const viewportSize = reactive({ width: 1600, height: 1000 });
const visibleNodes = computed(() => {
  const { pan, zoom } = board.value;
  return board.value.nodes.filter(
    (n) =>
      n.id === selected.value ||
      (n.x + nodeWidth(n) >= (-pan.x - 600) / zoom &&
        n.x <= (viewportSize.width - pan.x + 600) / zoom &&
        n.y + height(n) >= (-pan.y - 600) / zoom &&
        n.y <= (viewportSize.height - pan.y + 600) / zoom),
  );
});
function height(node) {
  return sizes.get(node.id) || nodeHeight(node);
}
function point(node, side) {
  return {
    x: node.x + (side === "right" ? nodeWidth(node) : 0),
    y: node.y + height(node) / 2,
  };
}
function curve(a, b, fromSide, toSide) {
  const d = Math.max(40, Math.min(160, Math.abs(b.x - a.x) / 2));
  return `M ${a.x} ${a.y} C ${a.x + (fromSide === "right" ? d : -d)} ${a.y}, ${b.x + (toSide === "right" ? d : -d)} ${b.y}, ${b.x} ${b.y}`;
}
const paths = computed(() =>
  board.value.edges.flatMap((e) => {
    const a = nodeMap.value.get(e.from),
      b = nodeMap.value.get(e.to);
    return a && b
      ? [
          {
            ...e,
            d: curve(
              point(a, e.fromSide),
              point(b, e.toSide),
              e.fromSide,
              e.toSide,
            ),
          },
        ]
      : [];
  }),
);
function worldPoint(clientX, clientY) {
  const rect = viewport.value.getBoundingClientRect();
  return {
    x: (clientX - rect.left - board.value.pan.x) / board.value.zoom,
    y: (clientY - rect.top - board.value.pan.y) / board.value.zoom,
  };
}
function center() {
  const rect = viewport.value.getBoundingClientRect();
  return worldPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
}
function select(id) {
  selected.value = id;
  selectedEdge.value = null;
}
function focusLibraryNode(node) {
  select(node.id);
  const rect = viewport.value?.getBoundingClientRect();
  if (!rect?.width || !rect.height) return;
  const railWidth =
    document.querySelector("#boardRail")?.getBoundingClientRect().width || 240;
  const usableWidth = Math.max(200, rect.width - railWidth - 32);
  const width = nodeWidth(node),
    nodeH = height(node);
  const zoom = Math.max(
    0.1,
    Math.min(
      board.value.zoom,
      1,
      (usableWidth - 48) / width,
      (rect.height - 80) / nodeH,
    ),
  );
  board.value.zoom = zoom;
  board.value.pan = {
    x: usableWidth / 2 - (node.x + width / 2) * zoom,
    y: rect.height / 2 - (node.y + nodeH / 2) * zoom,
  };
}
async function placeLibrary(job, position = null) {
  if (!s.ready || s.projectBusy) return;
  const alreadyAdded = board.value.nodes.some((n) => n.jobId === job.id);
  const point = position || center();
  const node =
    job.mediaType === "video"
      ? props.store.addVideo(job, point)
      : props.store.addImage(job, point);
  if (!node) return;
  await nextTick();
  focusLibraryNode(node);
  props.store.toast(
    alreadyAdded ? "已定位到画布中的节点" : "已放入当前项目画布",
  );
}
async function focusVideoPrompt(node) {
  await nextTick();
  if (!s.boardOpen || selected.value !== node.id || !nodeMap.value.has(node.id))
    return;
  const rect = viewport.value?.getBoundingClientRect();
  if (!rect?.width || !rect.height) return;
  const space = Math.max(280, rect.width - 280);
  const height = sizes.get(node.id) || 800;
  const zoom = Math.max(
    0.25,
    Math.min(
      board.value.zoom,
      1,
      (space - 40) / 480,
      (rect.height - 60) / height,
    ),
  );
  board.value.zoom = zoom;
  board.value.pan = {
    x: space / 2 - (node.x + 240) * zoom,
    y: 30 - node.y * zoom,
  };
}
function remove(id) {
  board.value.nodes = board.value.nodes.filter((n) => n.id !== id);
  board.value.edges = board.value.edges.filter(
    (e) => e.from !== id && e.to !== id,
  );
  sizes.delete(id);
  if (selected.value === id) selected.value = null;
  if (form.target?.id === id) edit.value = null;
}
function clearCanvas() {
  props.store.clearBoard();
  selected.value = null;
  selectedEdge.value = null;
  edit.value = false;
  menu.value = null;
  drag = null;
  temporaryPath.value = "";
  sizes.clear();
  form.source = null;
  form.target = null;
  s.preview = null;
}
function add(status, position, prompt = "") {
  const video = status === "video";
  if (video) status = "text";
  const node = {
    id: crypto.randomUUID(),
    status,
    jobId: null,
    x: Math.round(position.x - (status === "text" ? 240 : 110)),
    y: Math.round(position.y - (video ? 330 : 105)),
    prompt,
    ratio: status === "text" ? "9:16" : null,
    quality: status === "text" ? "2K" : null,
    url: null,
  };
  if (video)
    Object.assign(node, {
      kind: "video-generator",
      ratio: "16:9",
      quality: "480P",
      seconds: 6,
      dialogue: "",
      framing: "contain",
      provider: "local",
      model: "MiniMax H3",
    });
  else if (status === "text") props.store.setNodeEngine(node, s.engine);
  board.value.nodes.push(node);
  select(node.id);
  return board.value.nodes.at(-1);
}
function addMenuNode(status) {
  const node = add(status, menu.value.pos);
  menu.value = null;
  if (status === "text" || status === "video")
    nextTick(() =>
      world.value.querySelector(`[data-node-text="${node.id}"]`)?.focus(),
    );
}
function addLoading(prompt, ratio, quality, source, engine) {
  const pos = source
    ? { x: source.x + nodeWidth(source) + 230, y: source.y + 105 }
    : center();
  const [width, height] =
    props.store.generationConfigFor(engine).ratios[ratio][quality];
  const free = availablePosition(
    board.value.nodes,
    { x: pos.x - 110, y: pos.y - 105 },
    (220 * height) / width + 32,
  );
  const node = add("loading", { x: free.x + 110, y: free.y + 105 }, prompt);
  [node.width, node.height] = [width, height];
  Object.assign(node, { ratio, quality }, engine);
  if (source)
    board.value.edges.push({
      id: crypto.randomUUID(),
      from: source.id,
      to: node.id,
      fromSide: "right",
      toSide: "left",
    });
  return node;
}
function zoomAt(factor, clientX, clientY) {
  const rect = viewport.value.getBoundingClientRect();
  const x = clientX === undefined ? rect.width / 2 : clientX - rect.left,
    y = clientY === undefined ? rect.height / 2 : clientY - rect.top;
  const next = Math.max(0.1, Math.min(4, board.value.zoom * factor));
  board.value.pan = {
    x: x - ((x - board.value.pan.x) / board.value.zoom) * next,
    y: y - ((y - board.value.pan.y) / board.value.zoom) * next,
  };
  board.value.zoom = next;
}
function fit() {
  if (!board.value.nodes.length) return;
  const ns = board.value.nodes,
    minX = Math.min(...ns.map((n) => n.x)),
    minY = Math.min(...ns.map((n) => n.y)),
    maxX = Math.max(...ns.map((n) => n.x + nodeWidth(n))),
    maxY = Math.max(...ns.map((n) => n.y + height(n)));
  const rect = viewport.value.getBoundingClientRect();
  board.value.zoom = Math.max(
    0.1,
    Math.min(
      4,
      (rect.width - 180) / (maxX - minX),
      (rect.height - 180) / (maxY - minY),
    ),
  );
  board.value.pan = {
    x:
      (rect.width - (maxX - minX) * board.value.zoom) / 2 -
      minX * board.value.zoom,
    y:
      (rect.height - (maxY - minY) * board.value.zoom) / 2 -
      minY * board.value.zoom,
  };
}
let drag, fileTarget, resizeObserver;
function down(event) {
  menu.value = null;
  if (
    event.button !== 0 ||
    event.target.closest(
      ".board-history-rail,.board-node-actions,.generation-composer,.node-heading button,.board-node-pick",
    )
  )
    return;
  if (event.target.closest("video,.video-result-footer,.video-playback-error"))
    return;
  const port = event.target.closest(".board-port"),
    node = event.target.closest(".board-node");
  if (port)
    drag = {
      type: "edge",
      nodeId: node.dataset.nodeId,
      side: port.dataset.port,
      startX: event.clientX,
      startY: event.clientY,
    };
  else if (node) {
    const n = nodeMap.value.get(node.dataset.nodeId);
    select(n.id);
    drag = {
      type: "node",
      node: n,
      startX: event.clientX,
      startY: event.clientY,
      x: n.x,
      y: n.y,
    };
  } else
    drag = {
      type: "pan",
      startX: event.clientX,
      startY: event.clientY,
      x: board.value.pan.x,
      y: board.value.pan.y,
    };
  viewport.value.setPointerCapture(event.pointerId);
}
function move(event) {
  if (!drag) return;
  const dx = event.clientX - drag.startX,
    dy = event.clientY - drag.startY;
  if (Math.hypot(dx, dy) < 4 && !drag.moved) return;
  drag.moved = true;
  if (drag.type === "pan") board.value.pan = { x: drag.x + dx, y: drag.y + dy };
  else if (drag.type === "node") {
    drag.node.x = Math.round(drag.x + dx / board.value.zoom);
    drag.node.y = Math.round(drag.y + dy / board.value.zoom);
  } else {
    const n = nodeMap.value.get(drag.nodeId);
    if (n)
      temporaryPath.value = curve(
        point(n, drag.side),
        worldPoint(event.clientX, event.clientY),
        drag.side,
        drag.side === "right" ? "left" : "right",
      );
  }
}
function up(event) {
  if (!drag) return;
  const d = drag;
  drag = null;
  temporaryPath.value = "";
  if (d.type === "edge" && d.moved) {
    const target = document
      .elementFromPoint(event.clientX, event.clientY)
      ?.closest(".board-node");
    if (
      target &&
      target.dataset.nodeId !== d.nodeId &&
      !board.value.edges.some(
        (e) => e.from === d.nodeId && e.to === target.dataset.nodeId,
      )
    ) {
      if (nodeMap.value.get(d.nodeId)?.kind === "video") {
        props.store.toast("视频结果不能作为图片参考，请连接图片节点");
        return;
      }
      board.value.edges.push({
        id: crypto.randomUUID(),
        from: d.nodeId,
        to: target.dataset.nodeId,
        fromSide: d.side,
        toSide:
          event.clientX <
          target.getBoundingClientRect().left +
            target.getBoundingClientRect().width / 2
            ? "left"
            : "right",
      });
    }
  }
}
function wheel(event) {
  if (event.target.closest(".board-history-rail,.generation-composer")) return;
  event.preventDefault();
  zoomAt(event.deltaY < 0 ? 1.12 : 1 / 1.12, event.clientX, event.clientY);
}
function context(event) {
  if (event.target.closest(".board-history-rail,.generation-composer")) return;
  event.preventDefault();
  menu.value = {
    x: Math.min(event.clientX, innerWidth - 190),
    y: Math.min(event.clientY, innerHeight - 210),
    pos: worldPoint(event.clientX, event.clientY),
  };
}
function pick(target) {
  fileTarget = target;
  fileInput.value.value = "";
  fileInput.value.click();
}
function menuUpload() {
  const pos = menu.value.pos;
  menu.value = null;
  pick({ pos });
}
async function uploaded(event) {
  const file = event.target.files[0],
    target = fileTarget;
  fileTarget = null;
  event.target.value = "";
  if (!file || !target) return;
  await uploadFile(file, target);
}
async function uploadFile(file, target) {
  const node = target.nodeId
    ? nodeMap.value.get(target.nodeId)
    : add("loading", target.pos);
  if (!node) return;
  Object.assign(node, { status: "loading", uploading: true });
  try {
    const source = await props.store.uploadSource(file);
    if (!nodeMap.value.has(node.id)) return;
    Object.assign(node, {
      status: "done",
      uploading: false,
      url: sourceUrl(source),
      sourceImage: source,
      prompt: file.name,
      width: source.width,
      height: source.height,
    });
  } catch (error) {
    if (!nodeMap.value.has(node.id)) return;
    Object.assign(node, {
      status: "empty",
      uploading: false,
      error: error.message,
    });
    props.store.toast(error.message);
  }
}
async function prepareSource(node) {
  if (node.sourceImage) return node.sourceImage;
  const response = await fetch(node.url, {
    signal: AbortSignal.timeout(25000),
  });
  if (!response.ok) throw new Error("读取画布图片失败，请重试");
  let blob = await response.blob();
  if (blob.size > 8 * 1024 * 1024) {
    const bitmap = await createImageBitmap(blob),
      scale = Math.min(1, 2560 / Math.max(bitmap.width, bitmap.height)),
      canvas = document.createElement("canvas");
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas
      .getContext("2d")
      .drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    blob = await new Promise((resolve) =>
      canvas.toBlob(resolve, "image/jpeg", 0.92),
    );
    if (!blob) throw new Error("图片处理失败");
  }
  return props.store.uploadSource(
    new File([blob], "reference.png", { type: blob.type }),
  );
}
function apiUnavailable(selection) {
  return (
    props.store.engineSelection(selection).provider === "api" &&
    !s.engine.keyConfigured
  );
}
async function run(
  prompt,
  ratio,
  quality,
  parent,
  reference,
  selection,
  replace = false,
) {
  if (!s.ready || s.switching || submittingParents.has(parent?.id)) {
    props.store.toast("这个节点正在提交，请稍候");
    return;
  }
  if (!prompt.trim()) {
    props.store.toast("先写一句提示词吧");
    return;
  }
  const engine = props.store.engineParameters(selection);
  if (apiUnavailable(engine)) {
    props.store.toast("请先在 API 配置中填写密钥");
    return;
  }
  const parameters = { ...engine, prompt: prompt.trim(), ratio, quality };
  const node = replace
    ? parent
    : addLoading(prompt.trim(), ratio, quality, parent, engine);
  if (
    replace &&
    (!nodeMap.value.has(node?.id) || !beginImageEdit(node, parameters))
  )
    return;
  submittingParents.add(parent?.id);
  s.preparing++;
  if (!replace) node.preparing = true;
  try {
    const sourceImage = reference ? await prepareSource(reference) : undefined;
    if (replace && !nodeMap.value.has(node.id)) return;
    if (!replace) node.preparing = false;
    await props.store.generate(
      {
        ...parameters,
        mode: sourceImage ? "img2img" : "txt2img",
        sourceImage,
      },
      node,
      { replaceImage: replace },
    );
  } catch (error) {
    if (replace) failImageEdit(node, error.message);
    else Object.assign(node, { status: "failed", error: error.message });
    props.store.toast(error.message);
  } finally {
    s.preparing--;
    if (!replace) node.preparing = false;
    submittingParents.delete(parent?.id);
  }
}
function action(name, node, detail) {
  if (name === "optimize-inline-video") runInlineVideo(node, true);
  if (name === "unlink-video-reference")
    board.value.edges = board.value.edges.filter(
      (e) => !(e.to === node.id && e.from === detail),
    );
  if (name === "upload-video-references") uploadVideoReferences(node, detail);
  if (name === "configure-prompt-ai") props.store.openSettings("prompt-ai");
  if (name === "expand-video-prompt") updateVideoPrompt(node, true);
  if (name === "check-video") props.store.checkVideoEngine();
  if (name === "cancel-video") {
    const job = s.videoJobs.find((j) => j.id === node.jobId);
    if (job) props.store.cancel(job);
  }
  if (name === "retry-video") {
    const job = s.videoJobs.find((j) => j.id === node.jobId);
    const parameters = node.videoParameters || job;
    if (parameters) createVideoPrompt(node, null, parameters);
    else props.store.toast("请在视频生成节点重新提交");
  }
  if (name === "video") {
    const generator = add("video", {
      x: node.x + nodeWidth(node) + 280,
      y: node.y + 105,
    });
    board.value.edges.push({
      id: crypto.randomUUID(),
      from: node.id,
      to: generator.id,
      fromSide: "right",
      toSide: "left",
    });
  }
  if (name === "run-video") runInlineVideo(node);
  if (name === "update-video-prompt") updateVideoPrompt(node);
  if (name === "confirm-video") {
    confirmVideoPrompt(node);
  }
  if (name === "delete") remove(node.id);
  if (name === "zoom")
    s.preview = { url: node.url, caption: summarize(node.prompt) };
  if (name === "pick") pick({ nodeId: node.id });
  if (name === "edit") {
    if (node.imageEdit) {
      props.store.toast("这张图片正在编辑，请稍候");
      return;
    }
    select(node.id);
    Object.assign(form, {
      prompt: "",
      ratio: node.ratio || "9:16",
      quality: node.quality || "2K",
      source: node,
      target: node,
    });
    props.store.setNodeEngine(form, node);
    edit.value = true;
    nextTick(() => editComposer.value?.focus());
  }
  if (name === "unlink")
    board.value.edges = board.value.edges.filter(
      (edge) => edge.to !== node.id || !nodeMap.value.get(edge.from)?.url,
    );
  if (name === "run") {
    const incoming = board.value.edges
      .filter((e) => e.to === node.id)
      .map((e) => nodeMap.value.get(e.from))
      .filter((n) => n?.url && n.kind !== "video");
    if (incoming.length > 1) {
      props.store.toast("一个文本节点只能连接一张参考图");
      return;
    }
    run(node.prompt, node.ratio, node.quality, node, incoming[0], node);
  }
}
async function runInlineVideo(node, optimize = false) {
  if (!s.ready || s.switching || submittingParents.has(node.id)) return;
  const incoming = () => references.value.get(node.id) || [];
  const signature = () =>
    inlineVideoInputSignature(node, incoming(), s.videoEngine.workflowPreset);
  return inlineVideoAction(node, {
    optimize,
    signature,
    isPresent: () => nodeMap.value.has(node.id),
    isEngineReady: () => s.videoEngine.ready,
    notify: (message) => props.store.toast(message),
    prepare: async (expanding) => {
      const inputs = incoming().map((r, i) => ({
        node: r,
        role: node.referenceRoles?.[r.id] || (i === 0 ? "character" : "scene"),
      }));
      if (inputs.length > (s.videoEngine.maxReferences || 9))
        throw new Error("参考图超出当前工作流支持的数量");
      const snapshot = JSON.parse(
        JSON.stringify({
          prompt: node.prompt,
          dialogue: node.dialogue || "",
          quality: node.quality,
          ratio: node.ratio,
          seconds: node.seconds,
          framing: node.framing || "contain",
          ...(node.seed !== undefined ? { seed: node.seed } : {}),
        }),
      );
      s.preparing++;
      try {
        if (inputs.length) {
          if (s.videoEngine.workflowPreset === "base")
            snapshot.sourceImage = await prepareSource(inputs[0].node);
          else {
            snapshot.references = [];
            for (const r of inputs)
              snapshot.references.push({
                role: r.role,
                sourceImage: await prepareSource(r.node),
              });
          }
        }
        return await props.store.prepareVideo({
          ...snapshot,
          expand: expanding,
          inlineOptimize: expanding,
        });
      } finally {
        s.preparing--;
      }
    },
    submit: (parameters) => runVideo(node, null, parameters),
  });
}

async function uploadVideoReferences(parent, files) {
  if (
    parent.referencesUploading ||
    parent.inlinePending ||
    !nodeMap.value.has(parent.id)
  )
    return;
  const count = (references.value.get(parent.id) || []).length;
  if (count + files.length > (s.videoEngine.maxReferences || 9)) {
    props.store.toast("视频最多支持 9 张参考图");
    return;
  }
  for (const file of files) {
    const error = imageFileError(file);
    if (error) {
      props.store.toast(error);
      return;
    }
  }
  parent.referencesUploading = true;
  try {
    for (const file of files) {
      if (!nodeMap.value.has(parent.id)) break;
      const pos = availablePosition(
        board.value.nodes,
        { x: parent.x - 300, y: parent.y },
        280,
      );
      const image = add("loading", pos);
      await uploadFile(file, { nodeId: image.id });
      if (!nodeMap.value.has(parent.id) || !image.url) continue;
      parent.referenceRoles ||= {};
      parent.referenceRoles[image.id] = (references.value.get(parent.id) || [])
        .length
        ? "scene"
        : "character";
      board.value.edges.push({
        id: crypto.randomUUID(),
        from: image.id,
        to: parent.id,
        fromSide: "right",
        toSide: "left",
      });
    }
  } finally {
    parent.referencesUploading = false;
  }
}

async function createVideoPrompt(parent, reference, restored) {
  if (!s.ready || submittingParents.has(parent.id)) return;
  const source = restored || parent;
  const snapshot = JSON.parse(
    JSON.stringify({
      prompt: source.prompt,
      dialogue: restored?.dialogue || "",
      quality: source.quality,
      ratio: source.ratio || "16:9",
      seconds: source.seconds,
      framing: restored?.framing || "contain",
      ...(source.seed !== undefined ? { seed: source.seed } : {}),
      ...(source.references?.length
        ? { references: source.references }
        : source.sourceImage
          ? { sourceImage: source.sourceImage }
          : {}),
    }),
  );
  if (!snapshot.prompt?.trim()) {
    props.store.toast("请填写画面描述");
    return;
  }
  const node = {
    id: crypto.randomUUID(),
    kind: "video-prompt",
    status: "text",
    ...availablePosition(
      board.value.nodes,
      { x: parent.x + nodeWidth(parent) + 90, y: parent.y },
      800,
    ),
    prompt: snapshot.prompt,
    quality: snapshot.quality,
    ratio: snapshot.ratio,
    seconds: snapshot.seconds,
    dialogue: "",
    videoParameters: snapshot,
    review: source.review ? JSON.parse(JSON.stringify(source.review)) : null,
    referenceNodeId: !Array.isArray(reference) ? reference?.id : undefined,
    referenceNodes: Array.isArray(reference)
      ? reference.map((r, i) => ({
          id: r.id,
          role:
            parent.referenceRoles?.[r.id] || (i === 0 ? "character" : "scene"),
        }))
      : undefined,
    reviewPending: false,
  };
  board.value.nodes.push(node);
  board.value.edges.push({
    id: crypto.randomUUID(),
    from: parent.id,
    to: node.id,
    fromSide: "right",
    toSide: "left",
  });
  const draft = nodeMap.value.get(node.id);
  select(node.id);
  submittingParents.add(parent.id);
  try {
    await focusVideoPrompt(draft);
    await updateVideoPrompt(draft);
    await focusVideoPrompt(draft);
  } finally {
    submittingParents.delete(parent.id);
  }
}

async function updateVideoPrompt(node, expand = false) {
  if (node.reviewPending || submittingParents.has(node.id)) return;
  node.reviewPending = true;
  node.reviewError = "";
  node.aiWriting = expand || !node.review;
  submittingParents.add(node.id);
  s.preparing++;
  try {
    const snapshot = JSON.parse(JSON.stringify(node.videoParameters));
    if (!snapshot.references?.length && node.referenceNodes?.length) {
      snapshot.references = [];
      for (const saved of node.referenceNodes) {
        const reference = nodeMap.value.get(saved.id);
        if (!reference?.url)
          throw new Error("参考图已移除，请重新创建提示词卡片");
        snapshot.references.push({
          role: saved.role,
          sourceImage: await prepareSource(reference),
        });
      }
    }
    if (
      !snapshot.sourceImage &&
      !snapshot.references?.length &&
      node.referenceNodeId
    ) {
      const reference = nodeMap.value.get(node.referenceNodeId);
      if (!reference?.url)
        throw new Error("参考图已移除，请重新创建提示词卡片");
      snapshot.sourceImage = await prepareSource(reference);
    }
    // Capture fields before awaiting; edits and original nodes cannot change this request.
    const review = node.review
      ? JSON.parse(JSON.stringify(node.review))
      : undefined;
    const prepared = await props.store.prepareVideo({
      ...snapshot,
      review,
      expand: expand ? true : !review ? "auto" : false,
    });
    if (!nodeMap.value.has(node.id)) return;
    node.videoParameters = prepared.parameters;
    node.review = prepared.review;
    node.referenceUrl = prepared.parameters.sourceImage
      ? sourceUrl(prepared.parameters.sourceImage)
      : "";
    Object.assign(node, {
      quality: prepared.parameters.quality,
      ratio: prepared.parameters.ratio,
      seconds: prepared.parameters.seconds,
    });
  } catch (error) {
    if (error.draft?.review && nodeMap.value.has(node.id)) {
      node.review = error.draft.review;
      node.videoParameters = error.draft.parameters;
    }
    node.reviewError = error.message;
    props.store.toast(error.message);
  } finally {
    node.reviewPending = false;
    node.aiWriting = false;
    submittingParents.delete(node.id);
    s.preparing--;
  }
}

async function confirmVideoPrompt(node) {
  if (!s.ready || submittingParents.has(node.id)) return;
  return confirmVideoReview(node, {
    isPresent: () => nodeMap.value.has(node.id),
    isEngineReady: () => s.videoEngine.ready,
    prepare: () => updateVideoPrompt(node),
    submit: (parameters) => runVideo(node, null, parameters),
    notify: (message) => props.store.toast(message),
  });
}

async function runVideo(parent, reference, restored) {
  if (!s.ready || submittingParents.has(parent.id)) return;
  const snapshot = JSON.parse(
    JSON.stringify(
      restored || {
        prompt: parent.prompt,
        dialogue: "",
        quality: parent.quality,
        ratio: parent.ratio,
        seconds: parent.seconds,
        framing: "contain",
      },
    ),
  );
  const dims = videoDimensions(snapshot.quality, snapshot.ratio);
  if (!dims || !(snapshot.prompt?.trim() || snapshot.dialogue?.trim())) {
    props.store.toast("请填写画面描述");
    return;
  }
  const position = availablePosition(
    board.value.nodes,
    { x: parent.x + nodeWidth(parent) + 90, y: parent.y },
    300,
  );
  const result = {
    id: crypto.randomUUID(),
    kind: "video",
    status: "loading",
    ...position,
    jobId: null,
    prompt: snapshot.prompt,
    dialogue: snapshot.dialogue,
    ratio: snapshot.ratio || "16:9",
    quality: snapshot.quality,
    width: dims.width,
    height: dims.height,
    createdAt: Date.now(),
    preparing: !!reference,
  };
  board.value.nodes.push(result);
  board.value.edges.push({
    id: crypto.randomUUID(),
    from: parent.id,
    to: result.id,
    fromSide: "right",
    toSide: "left",
  });
  submittingParents.add(parent.id);
  s.preparing++;
  try {
    if (reference) snapshot.sourceImage = await prepareSource(reference);
    result.videoParameters = snapshot;
    result.preparing = false;
    const job = await props.store.generateVideo(snapshot, result);
    if (job) parent.lastJobId = job.id;
    return job;
  } catch (error) {
    Object.assign(result, { status: "failed", error: error.message });
    props.store.toast(error.message);
  } finally {
    result.preparing = false;
    s.preparing--;
    submittingParents.delete(parent.id);
  }
}
function submitEdit() {
  const target = form.target;
  if (
    !target ||
    !nodeMap.value.has(target.id) ||
    target.imageEdit ||
    submittingParents.has(target.id)
  )
    return;
  const source = form.source;
  if (!s.ready || s.switching || apiUnavailable(form)) return;
  run(form.prompt, form.ratio, form.quality, target, source, form, true);
  if (form.prompt.trim()) edit.value = false;
}
function close() {
  fileDrop.reset();
  props.store.navigate("projects");
  edit.value = false;
  menu.value = null;
  props.store.flush();
}
function drop(event) {
  if (hasFiles(event)) {
    fileDrop.drop(event);
    return;
  }
  const job = s.jobs.find(
    (j) => j.id === event.dataTransfer.getData("text/plain"),
  );
  const video = s.videoJobs.find(
    (j) => j.id === event.dataTransfer.getData("text/plain"),
  );
  if (video) {
    void placeLibrary(video, worldPoint(event.clientX, event.clientY));
    return;
  }
  if (job?.imageUrl) {
    const p = worldPoint(event.clientX, event.clientY);
    void placeLibrary(job, { x: p.x - 110, y: p.y - 100 });
  }
}
function dropFiles(files, event) {
  if (!s.ready) {
    props.store.toast("工作台正在加载，请稍后上传");
    return;
  }
  menu.value = null;
  const position = event.target.closest(".board-history-rail")
    ? center()
    : worldPoint(event.clientX, event.clientY);
  const targetId = event.target.closest(".board-node")?.dataset.nodeId;
  const target = nodeMap.value.get(targetId);
  if (target?.kind === "video-generator") {
    uploadVideoReferences(target, files);
    return;
  }
  let count = 0;
  let rejected = false;
  for (const file of files) {
    if (imageFileError(file)) {
      rejected = true;
      continue;
    }
    const destination =
      count === 0 && target?.status === "empty"
        ? { nodeId: target.id }
        : { pos: { x: position.x + count * 250, y: position.y } };
    uploadFile(file, destination);
    count++;
  }
  if (rejected)
    props.store.toast(
      "已跳过不支持的文件，请上传 10MB 以内的 PNG、JPEG 或 WebP",
    );
}
function key(event) {
  if (event.defaultPrevented || !s.boardOpen || s.preview) return;
  if (document.fullscreenElement || event.target.closest("video,.video-player"))
    return;
  if (event.key === "Escape" && event.repeat) return;
  if (event.isComposing) return;
  if (event.key === "Escape") {
    event.preventDefault();
    if (menu.value) menu.value = null;
    else if (edit.value) edit.value = false;
    else if (selected.value || selectedEdge.value) {
      selected.value = null;
      selectedEdge.value = null;
    } else close();
    return;
  }
  if (event.key === "Tab") {
    const container = edit.value ? "#boardEditModal" : "#boardOverlay";
    const buttons = [
      ...document.querySelectorAll(
        `${container} button:not(:disabled),${container} textarea,${container} select`,
      ),
    ].filter((el) => el.getClientRects().length);
    const first = buttons[0],
      last = buttons.at(-1);
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last?.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first?.focus();
    }
    return;
  }
  if (event.target.closest("textarea,input,select") || edit.value) return;
  if (["Delete", "Backspace"].includes(event.key)) {
    event.preventDefault();
    if (selected.value) remove(selected.value);
    else
      board.value.edges = board.value.edges.filter(
        (e) => e.id !== selectedEdge.value,
      );
  }
  if (["+", "="].includes(event.key)) zoomAt(1.25);
  if (event.key === "-") zoomAt(0.8);
  if (event.key === "0") board.value.zoom = 1;
  if (event.key === "1") fit();
}
watch(
  () => s.boardOpen,
  async (open) => {
    document.body.classList.toggle("board-open", open);
    if (open) {
      props.store.checkVideoEngine();
      await nextTick();
      closeButton.value?.focus();
    } else document.querySelector("#openBoard")?.focus();
  },
  { immediate: true },
);
onMounted(() => {
  document.addEventListener("keydown", key);
  resizeObserver = new ResizeObserver((entries) => {
    if (entries[0].contentRect.width > 0) {
      viewportSize.width = entries[0].contentRect.width;
      viewportSize.height = entries[0].contentRect.height;
    }
  });
  resizeObserver.observe(viewport.value);
});
watch(
  () => s.currentProject.id,
  () => {
    selected.value = null;
    selectedEdge.value = null;
    edit.value = null;
    menu.value = null;
    sizes.clear();
  },
);
onBeforeUnmount(() => {
  document.removeEventListener("keydown", key);
  resizeObserver?.disconnect();
  document.body.classList.remove("board-open");
});
</script>
<template>
  <div
    id="boardOverlay"
    class="board-overlay"
    :class="{ hidden: !s.boardOpen }"
    role="region"
    aria-label="无限画布"
  >
    <div class="board-topbar">
      <div class="board-title">
        <AppIcon name="grid" /><strong>节点画布</strong
        ><strong class="canvas-project-name">{{ s.currentProject.name }}</strong
        ><span id="boardStats" class="board-stats"
          >{{ board.nodes.length }} 个节点 ·
          {{ board.edges.length }} 条连线</span
        >
      </div>
      <div class="board-zoom-controls">
        <button
          id="boardAddVideo"
          class="ghost-button board-add-video"
          @click="add('video', center())"
        >
          <AppIcon name="video" />视频节点
        </button>
        <button
          :id="s.canUndoBoardClear ? 'boardUndoClear' : 'boardClear'"
          class="ghost-button board-fit board-clear"
          :disabled="!s.ready || (!s.canUndoBoardClear && !board.nodes.length)"
          :title="
            s.canUndoBoardClear
              ? '恢复上一次清空的节点和连线'
              : '清空节点和连线，图片仍保留在图片库'
          "
          @click="s.canUndoBoardClear ? store.undoClearBoard() : clearCanvas()"
        >
          <AppIcon :name="s.canUndoBoardClear ? 'undo' : 'trash'" />{{
            s.canUndoBoardClear ? "撤销清空" : "清空画布"
          }}
        </button>
        <span class="board-default-model">新节点默认</span>
        <EngineSwitch
          :store="store"
          compact
          @configure="$emit('configure-engine', $event)"
        />
        <button
          id="zoomOut"
          class="icon-button"
          aria-label="缩小"
          @click="zoomAt(0.8)"
        >
          −</button
        ><span id="zoomReadout" class="zoom-readout"
          >{{ Math.round(board.zoom * 100) }}%</span
        ><button
          id="zoomIn"
          class="icon-button"
          aria-label="放大"
          @click="zoomAt(1.25)"
        >
          +</button
        ><button id="zoomFit" class="ghost-button board-fit" @click="fit">
          适配全部</button
        ><button
          id="zoomReset"
          class="ghost-button board-fit"
          @click="board.zoom = 1"
        >
          100%
        </button>
      </div>
      <button
        id="boardClose"
        ref="closeButton"
        class="preview-close board-close"
        aria-label="关闭无限画布"
        @click="close"
      >
        ×
      </button>
    </div>
    <div
      id="boardViewport"
      ref="viewport"
      class="board-viewport"
      :class="{ 'is-file-dragging': draggingFiles }"
      :style="background"
      @pointerdown="down"
      @pointermove="move"
      @pointerup="up"
      @pointercancel="
        drag = null;
        temporaryPath = '';
      "
      @wheel="wheel"
      @contextmenu="context"
      @dragenter="fileDrop.enter"
      @dragleave="fileDrop.leave"
      @dragover.prevent="fileDrop.over"
      @drop.prevent="drop"
    >
      <div id="boardWorld" ref="world" class="board-world" :style="transform">
        <svg id="boardEdges" class="board-edges" aria-hidden="true">
          <path
            v-for="edge in paths"
            :key="edge.id"
            :d="edge.d"
            :data-edge-id="edge.id"
            :class="{ 'is-selected': selectedEdge === edge.id }"
            @pointerdown.stop="
              selectedEdge = edge.id;
              selected = null;
            "
          />
          <path
            v-if="temporaryPath"
            :d="temporaryPath"
            stroke-dasharray="6 5"
          /></svg
        ><BoardNode
          v-for="node in visibleNodes"
          :key="node.id"
          :node="node"
          :selected="selected === node.id"
          :disabled="!s.ready || s.switching || submittingParents.has(node.id)"
          :unavailable="apiUnavailable(node)"
          :config="store.generationConfigFor(node)"
          :references="references.get(node.id) || []"
          :reference="references.get(node.id)?.[0]"
          :reference-count="references.get(node.id)?.length || 0"
          :video-engine="s.videoEngine"
          @action="action"
          @change-engine="store.setNodeEngine"
          @configure-engine="$emit('configure-engine', $event)"
          @size="(id, size) => sizes.set(id, size)"
          @dblclick="node.url && node.kind !== 'video' && action('zoom', node)"
        />
      </div>
      <div
        id="boardEmpty"
        class="board-empty"
        :class="{ hidden: !!board.nodes.length }"
      >
        <h3>画布是空的</h3>
        <p>
          将本地图片拖入画布即可上传，也可右键添加节点<br />把人物图片连入视频节点，填写画面描述即可生成视频
          · 拖动空白处平移 · 滚轮缩放
        </p>
      </div>
      <div v-if="draggingFiles" class="board-file-drop" role="status">
        <AppIcon name="upload" />
        <strong>松开即可上传图片</strong>
        <span>支持多张 · PNG / JPEG / WebP · 每张 ≤10MB</span>
      </div>
      <aside id="boardRail" class="board-history-rail">
        <div class="board-rail-heading">
          <div class="board-library-tabs">
            <button
              :class="{ 'is-selected': libraryType === 'image' }"
              @click="
                libraryType = 'image';
                libraryCount = 30;
              "
            >
              图片库</button
            ><button
              :class="{ 'is-selected': libraryType === 'video' }"
              @click="
                libraryType = 'video';
                libraryCount = 30;
              "
            >
              视频库
            </button>
          </div>
          <span>{{ library.length }}</span>
        </div>
        <div id="boardRailList" class="board-rail-list">
          <div v-if="!library.length" class="board-rail-empty">
            {{
              libraryType === "video" ? "还没有视频任务" : "还没有已完成的图片"
            }}
          </div>
          <div
            v-for="job in library"
            :key="job.id"
            class="board-rail-item"
            draggable="true"
            :data-job-id="job.id"
            @dragstart="
              (event) => event.dataTransfer.setData('text/plain', job.id)
            "
          >
            <span v-if="job.mediaType === 'video'" class="board-rail-video-icon"
              ><AppIcon name="video"
            /></span>
            <SafeImage
              v-else
              :src="job.imageUrl"
              :thumbnail="job.thumbnailUrl || job.imageUrl + '&thumbnail=1'"
              alt=""
              draggable="false"
              loading="lazy"
            />
            <div class="board-rail-item-info">
              <strong>{{ summarize(job.dialogue || job.prompt, 20) }}</strong
              ><small
                >{{ jobRatio(job) }} ·
                <template v-if="job.mediaType === 'video'"
                  >{{ job.quality }} ·
                  {{
                    {
                      queued: "排队中",
                      running: "生成中",
                      completed: "已完成",
                      failed: "失败",
                      cancelled: "已取消",
                    }[job.status]
                  }}
                  ·
                </template>
                <template v-else-if="job.provider !== 'api'"
                  >{{ store.qualityLabel(job) }} ·
                </template>
                {{ job.provider === "api" ? "API" : "本地" }}</small
              ><button
                class="board-rail-add"
                :data-add-id="job.id"
                :disabled="!s.ready || s.projectBusy"
                @click="placeLibrary(job)"
              >
                {{
                  board.nodes.some((n) => n.jobId === job.id)
                    ? "定位节点"
                    : "放入画布"
                }}
              </button>
            </div>
          </div>
          <button
            v-if="library.length === libraryCount"
            class="ghost-button"
            @click="libraryCount += 30"
          >
            加载更多
          </button>
        </div>
      </aside>
    </div>
    <div
      id="boardEditModal"
      class="board-modal"
      :class="{ hidden: !edit }"
      role="dialog"
      aria-modal="true"
      aria-label="编辑图片"
    >
      <div
        class="board-modal-backdrop"
        data-close-edit
        @click="edit = false"
      ></div>
      <div class="board-modal-panel">
        <button
          id="boardEditClose"
          class="preview-close board-modal-close"
          aria-label="关闭编辑"
          @click="edit = false"
        >
          ×
        </button>
        <div class="modal-heading">
          <h2>编辑图片</h2>
          <span>生成完成后替换原节点图片，保留位置与连线</span>
        </div>
        <GenerationComposer
          ref="editComposer"
          :model="form"
          :config="store.generationConfigFor(form)"
          :reference="form.source"
          :reference-count="form.source ? 1 : 0"
          :disabled="
            !s.ready ||
            s.switching ||
            !!form.target?.imageEdit ||
            submittingParents.has(form.target?.id)
          "
          :unavailable="apiUnavailable(form)"
          @change-engine="store.setNodeEngine(form, $event)"
          @configure-engine="$emit('configure-engine', $event)"
          @submit="submitEdit"
          @remove-reference="form.source = null"
        />
      </div>
    </div>
    <div
      id="boardMenu"
      class="board-menu"
      :class="{ hidden: !menu }"
      :style="menu ? { left: menu.x + 'px', top: menu.y + 'px' } : {}"
      role="menu"
    >
      <button id="boardMenuText" role="menuitem" @click="addMenuNode('text')">
        <span>✎</span>增加文本节点</button
      ><button
        id="boardMenuVideo"
        role="menuitem"
        @click="addMenuNode('video')"
      >
        <AppIcon name="video" />增加视频节点</button
      ><button id="boardMenuAdd" role="menuitem" @click="addMenuNode('empty')">
        <span>＋</span>增加图片节点</button
      ><button id="boardMenuUpload" role="menuitem" @click="menuUpload">
        <span>⇪</span>上传图片
      </button>
    </div>
    <input
      ref="fileInput"
      type="file"
      class="hidden"
      accept="image/png,image/jpeg,image/webp"
      @change="uploaded"
    />
  </div>
</template>
