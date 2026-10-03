<script setup>
import { ref } from "vue";
import SafeImage from "./SafeImage.vue";
import AppIcon from "./AppIcon.vue";
import GenerationParameters from "./GenerationParameters.vue";
const props = defineProps({
  model: Object,
  config: Object,
  reference: Object,
  referenceCount: { type: Number, default: 0 },
  disabled: Boolean,
  nodeId: String,
});
const emit = defineEmits(["submit", "remove-reference"]);
const input = ref();
function enter(event) {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    event.stopPropagation();
    if (!props.disabled && props.referenceCount <= 1) emit("submit");
  }
}
defineExpose({ focus: () => input.value?.focus() });
</script>
<template>
  <div class="generation-composer" @pointerdown.stop>
    <div class="composer-reference" :class="{ 'has-reference': reference }">
      <span class="reference-label">参考图</span>
      <div v-if="reference" class="reference-thumb">
        <SafeImage
          :src="reference.url"
          :thumbnail="reference.thumbnailUrl || reference.url + '&thumbnail=1'"
          alt="参考图"
          draggable="false"
        />
        <button
          type="button"
          class="reference-remove"
          aria-label="移除参考图"
          @click="emit('remove-reference')"
        >
          <AppIcon name="close" />
        </button>
      </div>
      <AppIcon v-else name="link" class="reference-empty-icon" />
      <span class="reference-hint">{{
        referenceCount > 1
          ? `已连接 ${referenceCount} 张图片，请保留一张参考图`
          : reference
            ? "描述要修改的内容，以及需要保留的部分"
            : nodeId
              ? "从图片节点连线，添加一张参考图"
              : "未使用参考图，将按提示词生成"
      }}</span>
    </div>
    <div class="composer-prompt">
      <textarea
        ref="input"
        v-model="model.prompt"
        :id="nodeId ? undefined : 'boardEditPrompt'"
        :data-node-text="nodeId"
        :aria-label="nodeId ? '文字节点提示词' : '图片编辑提示词'"
        maxlength="4000"
        rows="6"
        :placeholder="
          reference
            ? '例如：把衣服换成红色，保持人物、姿势和构图不变'
            : '描述你想生成的画面，例如主体、环境、光线与风格…'
        "
        @keydown="enter"
      ></textarea>
      <span class="composer-count">{{ model.prompt.length }} / 4000</span>
    </div>
    <div class="composer-toolbar">
      <GenerationParameters :model="model" :config="config" />
      <button
        type="button"
        class="primary-button composer-submit"
        :id="nodeId ? undefined : 'boardEditSubmit'"
        :data-action="nodeId ? 'run' : undefined"
        :disabled="disabled || !model.prompt.trim() || referenceCount > 1"
        @click="emit('submit')"
      >
        {{ disabled ? "正在提交…" : "生成图片" }}<AppIcon name="arrow" />
      </button>
    </div>
    <div class="composer-shortcut">
      Enter 生成 <span>·</span> Shift + Enter 换行
    </div>
  </div>
</template>
