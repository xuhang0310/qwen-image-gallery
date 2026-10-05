<script setup>
import AppIcon from "./AppIcon.vue";
const props = defineProps({ store: Object, compact: Boolean });
const emit = defineEmits(["configure"]);
const { s } = props.store;
async function model(event) {
  try {
    await props.store.saveEngine({ model: event.target.value });
  } catch (error) {
    props.store.toast(error.message);
  }
}
</script>
<template>
  <div class="engine-switch" :class="{ 'is-compact': compact }">
    <span class="engine-label">生图引擎</span>
    <div class="engine-tabs" role="radiogroup" aria-label="生图引擎">
      <button
        type="button"
        role="radio"
        :aria-checked="s.engine.provider === 'local'"
        :disabled="!s.ready || s.switching"
        @click="store.switchEngine('local')"
      >
        本地
      </button>
      <button
        type="button"
        role="radio"
        :aria-checked="s.engine.provider === 'api'"
        :disabled="!s.ready || s.switching"
        @click="store.switchEngine('api')"
      >
        API
      </button>
    </div>
    <select
      v-if="s.engine.provider === 'api'"
      class="engine-model"
      aria-label="API 生图模型"
      :value="s.engine.model"
      :disabled="!s.ready || s.switching"
      @change="model"
    >
      <option
        v-for="model in s.engine.models"
        :key="model.id"
        :value="model.id"
      >
        {{ model.label }}
      </option>
    </select>
    <span v-else class="engine-name">Qwen Image 2.1</span>
    <button
      type="button"
      class="ghost-button api-entry"
      :disabled="!s.ready || s.switching"
      @click="emit('configure', s.engine.provider)"
    >
      <AppIcon name="settings" />{{
        s.engine.provider === "api" ? "API 配置" : "本地配置"
      }}<span
        v-if="s.engine.provider === 'api' && !s.engine.keyConfigured"
        class="engine-setup-dot"
        aria-label="尚未配置密钥"
      ></span>
    </button>
    <span class="engine-description">{{
      s.engine.provider === "api"
        ? "无需本地显卡 · 图片保存到本机"
        : "本机运行 · 使用本地模型"
    }}</span>
  </div>
</template>
