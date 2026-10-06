<script setup>
import WorkbenchSettings from "./WorkbenchSettings.vue";
import VideoPromptAISettings from "./VideoPromptAISettings.vue";
import StorageSettings from "./StorageSettings.vue";
import AppIcon from "./AppIcon.vue";
const props = defineProps({ store: Object });
defineEmits(["setup-local"]);
const { s } = props.store;
const tabs = [
  { id: "generation", label: "生图模型与本地环境" },
  { id: "prompt-ai", label: "视频写词 AI" },
  { id: "storage", label: "图片保存位置" },
];
</script>
<template>
  <main class="settings-page">
    <div class="page-intro">
      <div>
        <h2>工作室设置</h2>
        <p>工作台、所有项目和无限画布共用这些配置。</p>
      </div>
      <button
        class="ghost-button"
        @click="
          store.navigate(
            s.settingsReturn === 'settings' ? 'workbench' : s.settingsReturn,
          )
        "
      >
        <AppIcon name="undo" />返回{{
          s.settingsReturn === "canvas"
            ? "画布"
            : s.settingsReturn === "projects"
              ? "项目中心"
              : "工作台"
        }}
      </button>
    </div>
    <div class="settings-layout">
      <nav class="settings-tabs" aria-label="设置分类">
        <button
          v-for="tab in tabs"
          :key="tab.id"
          :data-settings-tab="tab.id"
          :class="{ active: s.settingsTab === tab.id }"
          :aria-current="s.settingsTab === tab.id ? 'page' : undefined"
          @click="s.settingsTab = tab.id"
        >
          {{ tab.label }}
        </button>
      </nav>
      <div class="settings-content">
        <WorkbenchSettings
          v-if="s.settingsTab === 'generation'"
          :open="true"
          embedded
          :store="store"
          :initial-provider="s.settingsProvider || s.engine.provider"
          @setup-local="$emit('setup-local')"
        /><VideoPromptAISettings
          v-else-if="s.settingsTab === 'prompt-ai'"
          :open="true"
          embedded
        /><StorageSettings v-else :store="store" />
      </div>
    </div>
  </main>
</template>
