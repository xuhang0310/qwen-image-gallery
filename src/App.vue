<script setup>
import { ref, watch, nextTick, onMounted, onBeforeUnmount } from "vue";
import GenerationForm from "./components/GenerationForm.vue";
import ResultPanel from "./components/ResultPanel.vue";
import TaskHistory from "./components/TaskHistory.vue";
import CanvasBoard from "./components/CanvasBoard.vue";
import PreviewDialog from "./components/PreviewDialog.vue";
import { useWorkbench } from "./composables/useWorkbench";
import AppIcon from "./components/AppIcon.vue";
import SetupWizard from "./components/SetupWizard.vue";
import EngineSwitch from "./components/EngineSwitch.vue";
import WorkbenchSettings from "./components/WorkbenchSettings.vue";
const store = useWorkbench(),
  { s } = store;
const importInput = ref();
const setupOpen = ref(false);
const settingsOpen = ref(false);
const returningToSettings = ref(false);
const settingsProvider = ref();
let settingsFromBoard = false;
let settingsTrigger;
const localSetupNeeded = ref(false);
function needsSetup() {
  localSetupNeeded.value = true;
  if (s.ready && s.engine.provider === "local" && !settingsOpen.value)
    openSetup();
}
watch(
  () => s.ready,
  (ready) => {
    if (ready && localSetupNeeded.value && s.engine.provider === "local")
      openSetup();
  },
);
function openSettings(provider = s.engine.provider) {
  settingsTrigger = document.activeElement;
  settingsFromBoard = s.boardOpen;
  settingsProvider.value = provider;
  s.boardOpen = false;
  s.preview = null;
  setupOpen.value = false;
  settingsOpen.value = true;
}
function closeSettings() {
  settingsOpen.value = false;
  if (settingsFromBoard) s.boardOpen = true;
  else nextTick(() => settingsTrigger?.focus());
  settingsFromBoard = false;
}
function configureLocal() {
  returningToSettings.value = true;
  settingsProvider.value = "local";
  settingsOpen.value = false;
  openSetup();
}
function closeSetup() {
  setupOpen.value = false;
  if (returningToSettings.value) settingsOpen.value = true;
  returningToSettings.value = false;
}
function openSetup() {
  s.boardOpen = false;
  s.preview = null;
  setupOpen.value = true;
}
function key(event) {
  if (
    !s.boardOpen &&
    !setupOpen.value &&
    !settingsOpen.value &&
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
  <div class="app-shell" :inert="setupOpen || settingsOpen">
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
              ? s.engine.provider === "api"
                ? "API 已连接"
                : "ComfyUI 已连接"
              : s.health.state === "checking"
                ? s.engine.provider === "api"
                  ? "正在检查 API"
                  : "正在连接 ComfyUI"
                : s.engine.provider === "api"
                  ? "API 未连接"
                  : "ComfyUI 未连接"
          }}</span>
        </div>
        <span class="topbar-divider"></span
        ><span id="runtimeText" class="runtime-text">{{
          s.engine.provider === "api"
            ? "API 生图"
            : s.health.state === "online"
              ? "本地运行"
              : "等待本地引擎"
        }}</span
        ><button class="ghost-button setup-entry" @click="openSettings()">
          <AppIcon name="settings" />生图配置</button
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
    <EngineSwitch :store="store" @configure="openSettings" />
    <main class="workspace">
      <GenerationForm :store="store" /><ResultPanel
        :store="store"
      /><TaskHistory :store="store" />
    </main>
  </div>
  <CanvasBoard :store="store" @configure-engine="openSettings" /><PreviewDialog
    :preview="s.preview"
    @close="s.preview = null"
  />
  <SetupWizard
    :open="setupOpen"
    :auto-check="s.ready && s.engine.provider === 'local'"
    :return-label="returningToSettings ? '返回生图配置' : '返回工作台'"
    @close="closeSetup"
    @needs-setup="needsSetup"
    @changed="store.checkHealth"
  />
  <WorkbenchSettings
    :open="settingsOpen"
    :store="store"
    :initial-provider="settingsProvider"
    @close="closeSettings"
    @setup-local="configureLocal"
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
