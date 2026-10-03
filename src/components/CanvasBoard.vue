<script setup>
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
import {
  pending,
  summarize,
  sourceUrl,
  availablePosition,
  nodeWidth,
  nodeHeight,
} from "../domain";
const props = defineProps({ store: Object });
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
const board = computed(() => s.board);
const nodeMap = computed(
  () => new Map(board.value.nodes.map((n) => [n.id, n])),
);
const references = computed(() => {
  const map = new Map();
  for (const edge of board.value.edges) {
    const source = nodeMap.value.get(edge.from);
    if (source?.url) map.set(edge.to, [...(map.get(edge.to) || []), source]);
  }
  return map;
});
const form = reactive({
  prompt: "",
  ratio: "9:16",
  quality: "2K",
  source: null,
});
const libraryCount = ref(30);
const library = computed(() =>
  s.jobs
    .filter(
      (j) =>
        j.status === "completed" &&
        j.imageUrl &&
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
function remove(id) {
  board.value.nodes = board.value.nodes.filter((n) => n.id !== id);
  board.value.edges = board.value.edges.filter(
    (e) => e.from !== id && e.to !== id,
  );
  sizes.delete(id);
  if (selected.value === id) selected.value = null;
  if (form.source?.id === id) edit.value = null;
}
function add(status, position, prompt = "") {
  const node = {
    id: crypto.randomUUID(),
    status,
    jobId: null,
    x: Math.round(position.x - (status === "text" ? 240 : 110)),
    y: Math.round(position.y - 105),
    prompt,
    ratio: status === "text" ? "9:16" : null,
    quality: status === "text" ? "2K" : null,
    url: null,
  };
  board.value.nodes.push(node);
  select(node.id);
  return board.value.nodes.at(-1);
}
function addMenuNode(status) {
  const node = add(status, menu.value.pos);
  menu.value = null;
  if (status === "text")
    nextTick(() =>
      world.value.querySelector(`[data-node-text="${node.id}"]`)?.focus(),
    );
}
function addLoading(prompt, ratio, quality, source) {
  const pos = source
    ? { x: source.x + nodeWidth(source) + 230, y: source.y + 105 }
    : center();
  const [width, height] = s.config.ratios[ratio][quality];
  const free = availablePosition(
    board.value.nodes,
    { x: pos.x - 110, y: pos.y - 105 },
    (220 * height) / width + 32,
  );
  const node = add("loading", { x: free.x + 110, y: free.y + 105 }, prompt);
  [node.width, node.height] = [width, height];
  Object.assign(node, { ratio, quality });
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
    )
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
    y: Math.min(event.clientY, innerHeight - 170),
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
  if (!file || !target) return;
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
    if (nodeMap.value.has(node.id))
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
async function run(prompt, ratio, quality, parent, reference) {
  if (!s.ready || submittingParents.has(parent?.id)) {
    props.store.toast("这个节点正在提交，请稍候");
    return;
  }
  if (!prompt.trim()) {
    props.store.toast("先写一句提示词吧");
    return;
  }
  const node = addLoading(prompt.trim(), ratio, quality, parent);
  submittingParents.add(parent?.id);
  s.preparing++;
  node.preparing = true;
  try {
    const sourceImage = reference ? await prepareSource(reference) : undefined;
    node.preparing = false;
    await props.store.generate(
      {
        prompt: prompt.trim(),
        ratio,
        quality,
        mode: sourceImage ? "img2img" : "txt2img",
        sourceImage,
      },
      node,
    );
  } catch (error) {
    if (nodeMap.value.has(node.id))
      Object.assign(node, { status: "failed", error: error.message });
    props.store.toast(error.message);
  } finally {
    s.preparing--;
    node.preparing = false;
    submittingParents.delete(parent?.id);
  }
}
function action(name, node) {
  if (name === "delete") remove(node.id);
  if (name === "zoom")
    s.preview = { url: node.url, caption: summarize(node.prompt) };
  if (name === "pick") pick({ nodeId: node.id });
  if (name === "edit") {
    select(node.id);
    Object.assign(form, {
      prompt: "",
      ratio: node.ratio || "9:16",
      quality: node.quality || "2K",
      source: node,
    });
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
      .filter((n) => n?.url);
    if (incoming.length > 1) {
      props.store.toast("一个文本节点只能连接一张参考图");
      return;
    }
    run(node.prompt, node.ratio, node.quality, node, incoming[0]);
  }
}
function submitEdit() {
  if (submittingParents.has(form.source?.id)) return;
  const source = form.source;
  run(form.prompt, form.ratio, form.quality, source, source);
  if (form.prompt.trim()) edit.value = false;
}
function close() {
  s.boardOpen = false;
  edit.value = false;
  menu.value = null;
  props.store.flush();
}
function drop(event) {
  const job = s.jobs.find(
    (j) => j.id === event.dataTransfer.getData("text/plain"),
  );
  if (job?.imageUrl) {
    const p = worldPoint(event.clientX, event.clientY);
    props.store.addImage(job, { x: p.x - 110, y: p.y - 100 });
  }
}
function key(event) {
  if (event.defaultPrevented || !s.boardOpen || s.preview) return;
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
      await nextTick();
      closeButton.value?.focus();
    } else document.querySelector("#openBoard")?.focus();
  },
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
    role="dialog"
    aria-modal="true"
    aria-label="无限画布"
  >
    <div class="board-topbar">
      <div class="board-title">
        <AppIcon name="grid" /><strong>节点画布</strong
        ><span id="boardStats" class="board-stats"
          >{{ board.nodes.length }} 个节点 ·
          {{ board.edges.length }} 条连线</span
        >
      </div>
      <div class="board-zoom-controls">
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
      @dragover.prevent
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
          :disabled="!s.ready || submittingParents.has(node.id)"
          :config="s.config"
          :reference="references.get(node.id)?.[0]"
          :reference-count="references.get(node.id)?.length || 0"
          @action="action"
          @size="(id, size) => sizes.set(id, size)"
          @dblclick="node.url && action('zoom', node)"
        />
      </div>
      <div
        id="boardEmpty"
        class="board-empty"
        :class="{ hidden: !!board.nodes.length }"
      >
        <h3>画布是空的</h3>
        <p>
          右键添加文本或图片节点，或从右侧历史记录拖入图片<br />把图片连入文本节点，可作为参考图编辑
          · 拖动空白处平移 · 滚轮缩放
        </p>
      </div>
      <aside id="boardRail" class="board-history-rail">
        <div class="board-rail-heading">
          <strong>图片库</strong><span>{{ library.length }}</span>
        </div>
        <div id="boardRailList" class="board-rail-list">
          <div v-if="!library.length" class="board-rail-empty">
            还没有已完成的图片
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
            <SafeImage
              :src="job.imageUrl"
              :thumbnail="job.thumbnailUrl || job.imageUrl + '&thumbnail=1'"
              alt=""
              draggable="false"
              loading="lazy"
            />
            <div class="board-rail-item-info">
              <strong>{{ summarize(job.prompt, 20) }}</strong
              ><small>{{ job.ratio }} · {{ job.quality }}</small
              ><button
                class="board-rail-add"
                :data-add-id="job.id"
                @click="store.addImage(job, center())"
              >
                放入画布
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
          <span>基于参考图生成新画面</span>
        </div>
        <GenerationComposer
          ref="editComposer"
          :model="form"
          :config="s.config"
          :reference="form.source"
          :reference-count="form.source ? 1 : 0"
          :disabled="!s.ready || submittingParents.has(form.source?.id)"
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
