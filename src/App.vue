<script setup>
import { ref, onMounted, onBeforeUnmount } from "vue";
import GenerationForm from "./components/GenerationForm.vue";
import ResultPanel from "./components/ResultPanel.vue";
import TaskHistory from "./components/TaskHistory.vue";
import CanvasBoard from "./components/CanvasBoard.vue";
import PreviewDialog from "./components/PreviewDialog.vue";
import { useWorkbench } from "./composables/useWorkbench";
import AppIcon from "./components/AppIcon.vue";
const store = useWorkbench(),
  { s } = store;
const importInput = ref();
function key(event) {
  if (
    !s.boardOpen &&
    !s.preview &&
    !event.isComposing &&
    (event.ctrlKey || event.metaKey) &&
    event.key === "Enter"
  ) {
    event.preventDefault();
    document.querySelector("#generateForm")?.requestSubmit();
  }
}
onMounted(() => {
  store.initialize();
  document.addEventListener("keydown", key);
});
onBeforeUnmount(() => document.removeEventListener("keydown", key));
</script>
<template>
  <div class="app-shell">
    <header class="topbar">
      <a class="brand" href="/" aria-label="Qwen Image 工作台首页"
        ><span class="brand-mark"><AppIcon name="image" /></span
        ><span><strong>Qwen Image</strong><small>图像工作台</small></span></a
      >
      <div class="topbar-meta">
        <div
          id="connectionPill"
          class="connection-pill"
          :data-state="s.health.state"
        >
          <span class="status-dot"></span
          ><span id="connectionText">{{
            s.health.state === "online"
              ? "ComfyUI 已连接"
              : s.health.state === "checking"
                ? "正在连接 ComfyUI"
                : "ComfyUI 未连接"
          }}</span>
        </div>
        <span class="topbar-divider"></span
        ><span id="runtimeText" class="runtime-text">{{
          s.health.state === "online" ? "本地运行" : "等待本地引擎"
        }}</span
        ><button
          id="openBoard"
          class="ghost-button board-entry"
          title="无限画布"
          aria-label="打开无限画布"
          @click="s.boardOpen = true"
        >
          <AppIcon name="grid" />节点画布</button
        ><button
          id="refreshConnection"
          class="icon-button"
          title="重新检查连接"
          aria-label="重新检查连接"
          @click="store.checkHealth"
        >
          <AppIcon name="refresh" />
        </button>
      </div>
    </header>
    <div class="project-bar">
      <span
        id="saveStatus"
        :class="{ 'save-error': s.saved === 'error' }"
        :title="s.saveError"
        role="status"
        >{{
          s.saved === "saved"
            ? "已保存到本机"
            : s.saved === "error"
              ? s.saveError
              : s.saved === "loading"
                ? "正在恢复项目…"
                : "正在保存…"
        }}</span
      >
      <div>
        <button
          id="exportProject"
          class="ghost-button"
          @click="store.exportProject"
        >
          导出项目</button
        ><button
          id="importProject"
          class="ghost-button"
          @click="importInput.click()"
        >
          导入项目</button
        ><input
          ref="importInput"
          class="hidden"
          type="file"
          accept="application/json,.json"
          @change="
            (event) => {
              store.importProject(event.target.files[0]);
              event.target.value = '';
            }
          "
        />
      </div>
    </div>
    <main class="workspace">
      <GenerationForm :store="store" /><ResultPanel
        :store="store"
      /><TaskHistory :store="store" />
    </main>
  </div>
  <CanvasBoard :store="store" /><PreviewDialog
    :preview="s.preview"
    @close="s.preview = null"
  />
  <div
    id="toast"
    class="toast"
    :class="{ 'is-visible': !!s.toast }"
    role="status"
  >
    {{ s.toast }}
  </div>
</template>
