<script setup>
import { ref, computed, onMounted, onBeforeUnmount } from "vue";
import GenerationForm from "./components/GenerationForm.vue";
import ResultPanel from "./components/ResultPanel.vue";
import TaskHistory from "./components/TaskHistory.vue";
import CanvasBoard from "./components/CanvasBoard.vue";
import PreviewDialog from "./components/PreviewDialog.vue";
import ProjectsCenter from "./components/ProjectsCenter.vue";
import SettingsCenter from "./components/SettingsCenter.vue";
import SetupWizard from "./components/SetupWizard.vue";
import EngineSwitch from "./components/EngineSwitch.vue";
import AppIcon from "./components/AppIcon.vue";
import { useWorkbench } from "./composables/useWorkbench";
const store = useWorkbench(),
  { s } = store;
const importInput = ref(),
  setupOpen = ref(false);
const pages = [
  { id: "workbench", label: "工作台", icon: "home" },
  { id: "projects", label: "项目中心", icon: "folder" },
  { id: "canvas", label: "无限画布", icon: "grid" },
];
const pageTitle = computed(
  () =>
    ({
      workbench: "图像工作台",
      projects: "项目中心",
      canvas: s.currentProject.name,
      settings: "设置",
    })[s.view],
);
const saveText = computed(() =>
  s.saved === "saved"
    ? "已保存到本机"
    : s.saved === "error"
      ? s.saveError
      : s.saved === "loading"
        ? "正在恢复项目…"
        : "正在保存…",
);
function configure(provider) {
  store.openSettings("generation", provider);
}
function setup() {
  store.navigate("settings");
  s.settingsTab = "generation";
  setupOpen.value = true;
}
function importFile(event) {
  void store.importProject(event.target.files[0]);
  event.target.value = "";
}
function key(event) {
  if (
    s.view === "workbench" &&
    !setupOpen.value &&
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
  <div class="studio-layout" :inert="setupOpen">
    <aside class="studio-sidebar" aria-label="主导航">
      <button
        class="studio-brand"
        aria-label="返回工作台"
        @click="store.navigate('workbench')"
      >
        <span class="brand-mark"><AppIcon name="image" /></span
        ><span><strong>Qwen Image</strong><small>创作工作室</small></span>
      </button>
      <div class="sidebar-label">工作空间</div>
      <nav class="studio-navigation">
        <button
          v-for="page in pages"
          :key="page.id"
          :id="'nav-' + page.id"
          :aria-label="page.label"
          :title="page.label"
          :class="{ active: s.view === page.id }"
          :aria-current="s.view === page.id ? 'page' : undefined"
          :disabled="s.projectBusy"
          @click="store.navigate(page.id)"
        >
          <AppIcon :name="page.icon" /><span>{{ page.label }}</span
          ><span v-if="page.id === 'projects'" class="nav-count">{{
            s.projects.length
          }}</span>
        </button>
      </nav>
      <div class="sidebar-current">
        <span class="sidebar-label">当前项目</span
        ><button
          :disabled="s.projectBusy || !s.ready"
          @click="store.navigate('canvas')"
        >
          <AppIcon name="folder" /><span>{{
            s.currentProject.name
          }}</span></button
        ><small
          :class="{ 'save-error': s.saved === 'error' }"
          :title="s.saveError"
          role="status"
          >{{ saveText }}</small
        ><button
          v-if="s.saved === 'error'"
          class="sidebar-retry"
          @click="store.flush"
        >
          重试保存
        </button>
      </div>
      <div class="sidebar-bottom">
        <button
          id="nav-settings"
          aria-label="设置"
          title="设置"
          :class="{ active: s.view === 'settings' }"
          :disabled="s.projectBusy"
          @click="store.openSettings(s.settingsTab)"
        >
          <AppIcon name="settings" /><span>设置</span></button
        ><small>本机保存 · 项目自动同步</small>
      </div>
    </aside>
    <div class="studio-content" :inert="s.projectBusy">
      <header v-show="!s.boardOpen" class="studio-header">
        <div>
          <span class="header-eyebrow">{{
            s.view === "workbench" ? "创作" : "工作空间"
          }}</span>
          <h1>{{ pageTitle }}</h1>
        </div>
        <div class="studio-header-actions">
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
                  ? "正在检查连接"
                  : s.engine.provider === "api"
                    ? "API 未连接"
                    : "ComfyUI 未连接"
            }}</span>
          </div>
          <button
            id="refreshConnection"
            class="icon-button"
            title="重新检查连接"
            aria-label="重新检查连接"
            @click="store.checkHealth"
          >
            <AppIcon name="refresh" /></button
          ><button
            v-if="s.view === 'workbench'"
            id="openBoard"
            class="ghost-button"
            @click="store.navigate('canvas')"
          >
            <AppIcon name="grid" />打开画布
          </button>
        </div>
      </header>
      <div v-show="s.view === 'workbench'" class="app-shell workbench-page">
        <EngineSwitch :store="store" @configure="configure" />
        <main class="workspace">
          <GenerationForm :store="store" /><ResultPanel
            :store="store"
          /><TaskHistory :store="store" />
        </main>
      </div>
      <ProjectsCenter
        v-if="s.view === 'projects'"
        :store="store"
        @import="importInput.click()"
      />
      <SettingsCenter
        v-if="s.view === 'settings'"
        :store="store"
        @setup-local="setup"
      />
      <CanvasBoard :store="store" @configure-engine="configure" />
    </div>
    <input
      ref="importInput"
      class="hidden"
      type="file"
      accept="application/json,.json"
      @change="importFile"
    />
  </div>
  <SetupWizard
    :open="setupOpen"
    :auto-check="s.ready && s.engine.provider === 'local'"
    return-label="返回设置"
    @close="setupOpen = false"
    @needs-setup="store.toast('本地引擎需要配置，请打开设置 → 本地模型')"
    @changed="store.checkHealth"
  />
  <PreviewDialog :preview="s.preview" @close="s.preview = null" />
  <div
    id="toast"
    class="toast"
    :class="{ 'is-visible': !!s.toast }"
    role="status"
  >
    {{ s.toast }}
  </div>
</template>
