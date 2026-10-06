<script setup>
import { computed, ref } from "vue";
import AppIcon from "./AppIcon.vue";
import VideoReferences from "./VideoReferences.vue";
import VideoPromptViewer from "./VideoPromptViewer.vue";
import { originalVideoPrompt } from "../../shared/video-inline.mjs";
import {
  videoQualities,
  videoRatios,
  videoDurations,
} from "../../shared/video.mjs";
const props = defineProps({
  model: Object,
  reference: Object,
  references: { type: Array, default: () => [] },
  referenceCount: Number,
  disabled: Boolean,
  engine: Object,
});
const emit = defineEmits([
  "submit",
  "remove-reference",
  "check-engine",
  "upload-references",
  "optimize",
  "configure-ai",
]);
const promptView = ref(null);
const original = computed(() => originalVideoPrompt(props.model));
const referenceItems = computed(() =>
  props.references.map((r, i) => ({
    ...r,
    key: r.id,
    role:
      props.model.referenceRoles?.[r.id] || (i === 0 ? "character" : "scene"),
  })),
);
function setRole(id, role) {
  props.model.referenceRoles ||= {};
  props.model.referenceRoles[id] = role;
}
const busy = computed(
  () =>
    props.disabled ||
    props.model.referencesUploading ||
    !!props.model.inlinePending,
);
const blocked = computed(
  () =>
    busy.value ||
    props.referenceCount > (props.engine.maxReferences || 9) ||
    props.model.referencesUploading ||
    !props.model.prompt.trim(),
);
</script>
<template>
  <form
    class="video-composer generation-composer"
    @pointerdown.stop
    @submit.prevent="!blocked && engine.ready && emit('submit')"
    @keydown.ctrl.enter.prevent="!blocked && engine.ready && emit('submit')"
  >
    <div class="video-model-line">
      <span class="video-model-badge"><AppIcon name="video" />MiniMax H3</span
      ><span>{{ engine.workflowLabel || "本地生成" }} · 画面与声音同步</span>
    </div>
    <VideoReferences
      :items="referenceItems"
      :disabled="busy"
      @role="setRole"
      @remove="emit('remove-reference', $event)"
      @upload="emit('upload-references', $event)"
    />
    <p v-if="referenceCount > (engine.maxReferences || 9)" class="video-note">
      参考图超出当前工作流支持的数量。
    </p>
    <div class="video-scene-heading">
      <label :for="'video-scene-' + model.id"
        >画面描述 <small>必填</small></label
      >
      <button
        type="button"
        class="ghost-button video-optimize-button"
        :disabled="blocked"
        @click="emit('optimize')"
      >
        <AppIcon name="edit" />{{
          model.inlinePending === "optimize" ? "AI 优化中…" : "AI 优化提示词"
        }}
      </button>
      <button
        type="button"
        class="quiet-icon"
        aria-label="配置提示词 AI"
        :disabled="busy"
        @click="emit('configure-ai')"
      >
        <AppIcon name="settings" />
      </button>
    </div>
    <textarea
      :id="'video-scene-' + model.id"
      v-model="model.prompt"
      :data-node-text="model.id"
      :disabled="busy"
      maxlength="4000"
      rows="3"
      placeholder="例如：人物面对镜头微笑，自然眨眼，轻轻点头，柔和光线，固定镜头"
    ></textarea>
    <div class="video-prompt-view-actions">
      <button
        type="button"
        class="ghost-button"
        @click="promptView = 'original'"
      >
        查看原始提示词
      </button>
      <button
        type="button"
        class="ghost-button"
        @click="promptView = 'current'"
      >
        <AppIcon name="expand" />放大当前提示词
      </button>
    </div>
    <p v-if="model.inlineError" class="video-review-warning" role="alert">
      {{ model.inlineError }}
    </p>
    <div class="video-options-row">
      <div>
        <label :for="'video-quality-' + model.id">清晰度</label>
        <select
          :id="'video-quality-' + model.id"
          v-model="model.quality"
          :disabled="busy"
        >
          <option
            v-for="(_, quality) in videoQualities"
            :key="quality"
            :value="quality"
          >
            {{ quality }}
          </option>
        </select>
      </div>
      <div>
        <label :for="'video-duration-' + model.id">时长</label
        ><select
          :id="'video-duration-' + model.id"
          v-model.number="model.seconds"
          :disabled="busy"
        >
          <option
            v-for="seconds in videoDurations"
            :key="seconds"
            :value="seconds"
          >
            {{ seconds }} 秒
          </option>
        </select>
      </div>
      <div>
        <label :for="'video-ratio-' + model.id">画面比例</label>
        <select
          :id="'video-ratio-' + model.id"
          v-model="model.ratio"
          :disabled="busy"
        >
          <option
            v-for="(name, ratio) in videoRatios"
            :key="ratio"
            :value="ratio"
          >
            {{ ratio }} {{ name }}
          </option>
        </select>
      </div>
    </div>
    <div v-if="!engine.ready" class="video-engine-status" role="status">
      <span>{{
        engine.checking
          ? "正在连接视频引擎…"
          : engine.missing?.length
            ? "本地视频模型尚未就绪"
            : engine.error || "视频引擎未连接"
      }}</span
      ><button
        type="button"
        class="ghost-button"
        :disabled="engine.checking"
        @click="emit('check-engine')"
      >
        重新连接
      </button>
    </div>
    <div class="video-submit-footer">
      <button
        class="primary-button video-submit"
        type="submit"
        :disabled="blocked || !engine.ready"
      >
        {{
          model.inlinePending === "optimize"
            ? "AI 优化中…"
            : model.inlinePending === "generate" || disabled
              ? "正在准备视频…"
              : "生成视频"
        }}<AppIcon name="arrow" />
      </button>
      <div class="composer-shortcut">
        Ctrl / ⌘ + Enter 生成视频 · 自动保存到本机
      </div>
    </div>
  </form>
  <VideoPromptViewer
    :open="!!promptView"
    :initial-view="promptView || 'original'"
    :original="original"
    :current="model.prompt"
    @close="promptView = null"
  />
</template>
