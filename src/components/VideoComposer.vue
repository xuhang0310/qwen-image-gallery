<script setup>
import { computed } from "vue";
import AppIcon from "./AppIcon.vue";
import SafeImage from "./SafeImage.vue";
import {
  videoQualities,
  videoRatios,
  videoDimensions,
  videoDurations,
  videoFrames,
} from "../../shared/video.mjs";
const props = defineProps({
  model: Object,
  reference: Object,
  referenceCount: Number,
  disabled: Boolean,
  engine: Object,
});
const emit = defineEmits(["submit", "remove-reference", "check-engine"]);
const dimensions = computed(
  () =>
    videoDimensions(props.model.quality, props.model.ratio) ||
    videoQualities["480P"],
);
const duration = computed(() =>
  (videoFrames(props.model.seconds || 6) / 24).toFixed(1),
);
const blocked = computed(
  () =>
    props.disabled ||
    !props.engine.ready ||
    props.referenceCount > 1 ||
    !props.model.prompt.trim(),
);
</script>
<template>
  <form
    class="video-composer generation-composer"
    @pointerdown.stop
    @submit.prevent="!blocked && emit('submit')"
    @keydown.ctrl.enter.prevent="!blocked && emit('submit')"
  >
    <div class="video-model-line">
      <span class="video-model-badge"><AppIcon name="video" />MiniMax H3</span
      ><span>本地生成 · 画面与声音同步</span>
    </div>
    <div class="composer-reference" :class="{ 'has-reference': reference }">
      <span class="reference-label">参考图</span>
      <div v-if="reference" class="reference-thumb">
        <SafeImage
          :src="reference.url"
          :thumbnail="reference.thumbnailUrl || reference.url + '&thumbnail=1'"
          alt="视频参考人物"
        /><button
          type="button"
          class="reference-remove"
          aria-label="移除视频参考图"
          @click="emit('remove-reference')"
        >
          <AppIcon name="close" />
        </button>
      </div>
      <AppIcon v-else name="link" class="reference-empty-icon" />
      <span class="reference-hint">{{
        referenceCount > 1
          ? "请保留一张参考图"
          : reference
            ? "人物外观将参考这张图片"
            : "连接一张人物图片，或直接描述画面"
      }}</span>
    </div>
    <label :for="'video-scene-' + model.id">画面描述 <small>必填</small></label>
    <textarea
      :id="'video-scene-' + model.id"
      v-model="model.prompt"
      :data-node-text="model.id"
      maxlength="4000"
      rows="3"
      placeholder="例如：人物面对镜头微笑，自然眨眼，轻轻点头，柔和光线，固定镜头"
    ></textarea>
    <p class="video-note">
      默认按画面与动作生成；需要说台词请明确写“口播：…”，唱歌请写“唱：…”。
    </p>
    <div class="video-options-row">
      <div>
        <span class="parameter-label">清晰度</span>
        <div
          class="parameter-options"
          role="radiogroup"
          aria-label="视频清晰度"
        >
          <button
            v-for="(_, quality) in videoQualities"
            :key="quality"
            type="button"
            role="radio"
            :aria-checked="model.quality === quality"
            :class="{ 'is-selected': model.quality === quality }"
            @click="model.quality = quality"
          >
            {{ quality }}
          </button>
        </div>
      </div>
      <div>
        <label :for="'video-duration-' + model.id">时长</label
        ><select
          :id="'video-duration-' + model.id"
          v-model.number="model.seconds"
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
    </div>
    <div class="video-ratio-options">
      <span class="parameter-label">画面比例</span>
      <div
        class="parameter-options"
        role="radiogroup"
        aria-label="视频画面比例"
      >
        <button
          v-for="(name, ratio) in videoRatios"
          :key="ratio"
          type="button"
          role="radio"
          :aria-checked="model.ratio === ratio"
          :class="{ 'is-selected': model.ratio === ratio }"
          @click="model.ratio = ratio"
        >
          {{ ratio }} {{ name }}
        </button>
      </div>
    </div>
    <div class="video-output">
      <span>{{ model.ratio }} {{ videoRatios[model.ratio] }}</span
      ><strong>{{ dimensions.width }} × {{ dimensions.height }}</strong
      ><span>约 {{ duration }} 秒 · 24 fps</span>
    </div>
    <p class="video-note">
      {{
        model.quality === "720P"
          ? "720P 生成时间较长，可关闭画布，任务会继续运行。"
          : "480P 适合先测试人物与动作。"
      }}
    </p>
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
    <button
      class="primary-button video-submit"
      type="submit"
      :disabled="blocked"
    >
      {{ disabled ? "正在提交…" : "生成视频" }}<AppIcon name="arrow" />
    </button>
    <div class="composer-shortcut">Ctrl / ⌘ + Enter 生成 · 自动保存到本机</div>
  </form>
</template>
