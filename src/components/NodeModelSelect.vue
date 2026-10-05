<script setup>
import { computed } from "vue";
import apiImage from "../../shared/api-image.json";

const props = defineProps({
  provider: { type: String, default: "local" },
  model: { type: String, default: "" },
  disabled: Boolean,
});
const emit = defineEmits(["change"]);
const localModel = "Qwen Image 2.1";
const selected = computed(() =>
  props.provider === "api"
    ? apiImage.models.some((model) => model.id === props.model)
      ? props.model
      : "gpt-image-2"
    : localModel,
);
const selectedLabel = computed(
  () =>
    apiImage.models.find((model) => model.id === selected.value)?.label ||
    localModel,
);

function change(event) {
  if (props.disabled) return;
  const model = event.target.value;
  if (model === localModel) emit("change", { provider: "local", model });
  else if (apiImage.models.some((option) => option.id === model))
    emit("change", { provider: "api", model });
}
</script>

<template>
  <label class="node-model-select" @pointerdown.stop @keydown.stop>
    <span class="node-model-label">模型</span>
    <select
      aria-label="节点生图模型"
      :value="selected"
      :title="selectedLabel"
      :disabled="disabled"
      @change="change"
    >
      <optgroup label="本地模型 · Qwen">
        <option :value="localModel">Qwen Image 2.1 · 本地</option>
      </optgroup>
      <optgroup label="API 模型 · GPT Image 2 系列">
        <option
          v-for="model in apiImage.models"
          :key="model.id"
          :value="model.id"
        >
          {{ model.label }}
        </option>
      </optgroup>
    </select>
  </label>
</template>

<style scoped>
.node-model-select {
  display: flex;
  align-items: center;
  gap: 12px;
  min-width: 0;
}

.node-model-label {
  flex: none;
  color: var(--muted, #a4a9b6);
  font-size: 12px;
}

.node-model-select select {
  flex: 1;
  min-width: 0;
  width: 100%;
  min-height: 36px;
  padding: 7px 10px;
  border: 1px solid var(--line, #3d424e);
  border-radius: 7px;
  background: #14161b;
  color: var(--text, #cbd0dc);
  color-scheme: dark;
  font: inherit;
  font-size: 12px;
  text-overflow: ellipsis;
  cursor: pointer;
}

.node-model-select select:hover:not(:disabled) {
  border-color: #7a808e;
}

.node-model-select select:focus-visible {
  outline: 2px solid #b3bdde;
  outline-offset: 2px;
}

.node-model-select select:disabled {
  opacity: 0.55;
  cursor: wait;
}
</style>
