<script setup>
import { computed } from "vue";
import AppIcon from "./AppIcon.vue";
import SafeImage from "./SafeImage.vue";
import VideoReferences from "./VideoReferences.vue";
import { sourceUrl } from "../domain";
import { videoReferenceLabels } from "../../shared/video-references.mjs";
import { vocalModes, videoReviewReady } from "../../shared/video-review.mjs";
import {
  videoDimensions,
  videoDurations,
  videoFrames,
} from "../../shared/video.mjs";
const props = defineProps({ node: Object, disabled: Boolean, engine: Object });
const emit = defineEmits([
  "confirm",
  "update",
  "expand",
  "configure-ai",
  "delete",
  "check-engine",
]);
const prepared = computed(
  () =>
    videoReviewReady(props.node.review, props.node.videoParameters) &&
    (!props.engine.workflowPreset ||
      props.node.review.workflowPreset === props.engine.workflowPreset),
);
const blocked = computed(
  () => props.disabled || props.node.reviewPending || props.node.confirmPending,
);
const submitting = computed(() => blocked.value || props.node.confirmPending);
function splitTime() {
  const timeline = props.node.review.timeline;
  const last = timeline.at(-1);
  const middle = Math.round(((last.start + last.end) / 2) * 1000) / 1000;
  if (middle <= last.start || middle >= last.end || timeline.length >= 12)
    return;
  timeline.push({ ...last, start: middle });
  last.end = middle;
}
function removeTime(index) {
  const timeline = props.node.review.timeline;
  if (timeline.length <= 1) return;
  if (index === 0) timeline[1].start = 0;
  else timeline[index - 1].end = timeline[index].end;
  timeline.splice(index, 1);
}
const referenceItems = computed(() => {
  const refs = props.node.videoParameters.references || [];
  const labels = videoReferenceLabels(refs);
  return refs.map((r, i) => ({
    key: i,
    role: r.role,
    label: labels[i],
    url: sourceUrl(r.sourceImage),
  }));
});
const dimensions = computed(() =>
  videoDimensions(
    props.node.videoParameters.quality,
    props.node.videoParameters.ratio,
  ),
);
const chinese = computed(() =>
  /[\u3400-\u9fff]/.test(props.node.review?.vocalText || ""),
);
</script>
<template>
  <div class="node-heading video-review-heading">
    <span><AppIcon name="edit" />视频提示词</span>
    <span class="video-review-state" :class="{ 'needs-update': !prepared }">{{
      node.confirmPending
        ? "更新并提交中"
        : node.reviewPending
          ? node.aiWriting
            ? "AI 写词中"
            : "整理中"
          : node.reviewError
            ? "需要重试"
            : !prepared
              ? "有修改 · 待更新"
              : node.lastJobId
                ? "已提交 · 可复用"
                : "待确认"
    }}</span>
    <button
      class="quiet-icon"
      aria-label="移除提示词卡片"
      @click="emit('delete')"
    >
      <AppIcon name="close" />
    </button>
  </div>
  <form
    class="video-composer video-review generation-composer"
    @pointerdown.stop
    @submit.prevent="
      !submitting && engine.ready && node.review && emit('confirm')
    "
    @keydown.ctrl.enter.prevent="
      !submitting && engine.ready && node.review && emit('confirm')
    "
  >
    <p class="video-review-intro">先检查提示词。点击确认后，才开始生成视频。</p>
    <VideoReferences
      v-if="referenceItems.length"
      :items="referenceItems"
      readonly
    />
    <div v-else-if="node.referenceUrl" class="video-review-reference">
      <SafeImage
        :src="node.referenceUrl"
        :thumbnail="node.referenceUrl + '&thumbnail=1'"
        alt="已选定的视频参考图"
      />
      <span>参考图已保留<small>修改原节点不会改变这张卡片</small></span>
    </div>
    <details class="video-review-original">
      <summary>原始描述</summary>
      <p>{{ node.prompt }}</p>
    </details>
    <template v-if="node.review">
      <div class="video-ai-tools">
        <div>
          <strong>AI 表演导演</strong
          ><small>{{
            node.review.aiModel || "八条表演规范 · 保留原台词"
          }}</small>
        </div>
        <button
          type="button"
          class="ghost-button"
          :disabled="blocked"
          @click="emit('expand')"
        >
          {{ node.aiWriting ? "扩写中…" : "AI 扩写" }}
        </button>
        <button
          type="button"
          class="quiet-icon"
          aria-label="配置写词 AI"
          :disabled="blocked"
          @click="emit('configure-ai')"
        >
          <AppIcon name="settings" />
        </button>
      </div>
      <section v-if="node.review.timeline" class="video-timeline">
        <div class="video-performance-heading">
          <strong>时间分段</strong
          ><small>连续覆盖 0–{{ node.videoParameters.seconds }}s</small>
        </div>
        <div
          v-for="(segment, index) in node.review.timeline"
          :key="index"
          class="video-time-segment"
        >
          <div class="video-time-range">
            <input
              v-model.number="segment.start"
              type="number"
              min="0"
              :max="node.videoParameters.seconds"
              step="any"
              :aria-label="'第' + (index + 1) + '段开始秒数'"
              :disabled="submitting"
            /><span>–</span
            ><input
              v-model.number="segment.end"
              type="number"
              min="0"
              :max="node.videoParameters.seconds"
              step="any"
              :aria-label="'第' + (index + 1) + '段结束秒数'"
              :disabled="submitting"
            /><span>s</span
            ><button
              type="button"
              class="quiet-icon"
              :aria-label="'移除第' + (index + 1) + '时间段'"
              :disabled="submitting || node.review.timeline.length <= 1"
              @click="removeTime(index)"
            >
              <AppIcon name="close" />
            </button>
          </div>
          <textarea
            v-model="segment.action"
            rows="2"
            maxlength="1200"
            :aria-label="'第' + (index + 1) + '时间段动作'"
            :disabled="submitting"
          />
        </div>
        <button
          type="button"
          class="ghost-button"
          :disabled="submitting || node.review.timeline.length >= 12"
          @click="splitTime"
        >
          拆分最后一段
        </button>
      </section>
      <label :for="'review-scene-' + node.id"
        >画面与动作 <small>可修改</small></label
      >
      <textarea
        :id="'review-scene-' + node.id"
        v-model="node.review.scene"
        rows="3"
        maxlength="4000"
        :disabled="blocked"
      />
      <label :for="'review-mode-' + node.id">声音与台词</label>
      <select
        :id="'review-mode-' + node.id"
        v-model="node.review.vocalMode"
        @change="
          node.review.vocalMode === 'none' &&
          node.review.performance &&
          (node.review.performance.beats = [])
        "
        :disabled="blocked"
      >
        <option v-for="(label, mode) in vocalModes" :key="mode" :value="mode">
          {{ label }}
        </option>
      </select>
      <template v-if="node.review.vocalMode !== 'none'">
        <label :for="'review-vocal-' + node.id"
          >{{ node.review.vocalMode === "singing" ? "歌词" : "台词" }}
          <small>{{
            chinese ? "中文普通话 · 保留原文" : "按台词原语言生成"
          }}</small></label
        >
        <textarea
          :id="'review-vocal-' + node.id"
          v-model="node.review.vocalText"
          rows="2"
          maxlength="200"
          :disabled="blocked"
          placeholder="在这里填写人物要说或唱的原文"
        />
      </template>
      <template v-if="node.review.performance">
        <div class="video-performance-heading">
          <strong>表演方案</strong><small>全部说明置于台词前</small>
        </div>
        <label :for="'review-overview-' + node.id">表演总纲 · 情绪顺序</label
        ><textarea
          :id="'review-overview-' + node.id"
          v-model="node.review.performance.overview"
          rows="3"
          maxlength="1000"
          :disabled="blocked"
        />
        <label :for="'review-start-' + node.id">起始状态 · 平静起点</label
        ><textarea
          :id="'review-start-' + node.id"
          v-model="node.review.performance.startingState"
          rows="2"
          maxlength="1000"
          :disabled="blocked"
        />
        <label :for="'review-camera-' + node.id">镜头与构图</label
        ><textarea
          :id="'review-camera-' + node.id"
          v-model="node.review.performance.camera"
          rows="2"
          maxlength="1000"
          :disabled="blocked"
        />
        <details
          v-for="(beat, index) in node.review.performance.beats"
          :key="index"
          class="video-performance-beat"
          :open="index === 0"
        >
          <summary>
            <span>{{ String(index + 1).padStart(2, "0") }}</span
            >{{ beat.line }}
          </summary>
          <label :for="'beat-line-' + node.id + '-' + index"
            >对应台词 <small>同步上方台词，或重新 AI 扩写</small></label
          ><textarea
            :id="'beat-line-' + node.id + '-' + index"
            v-model="beat.line"
            rows="2"
            maxlength="200"
            :disabled="blocked"
          />
          <label :for="'beat-face-' + node.id + '-' + index"
            >这句说出口时的脸部动作</label
          ><textarea
            :id="'beat-face-' + node.id + '-' + index"
            v-model="beat.face"
            rows="2"
            maxlength="600"
            :disabled="blocked"
          />
          <div class="video-performance-voice">
            <label
              v-for="(title, key) in {
                volume: '音量',
                pace: '快慢',
                pitch: '音高',
              }"
              :key="key"
              >{{ title
              }}<input
                v-model="beat[key]"
                :aria-label="'第' + (index + 1) + '句' + title"
                maxlength="600"
                :disabled="blocked"
            /></label>
          </div>
          <label class="video-performance-pause"
            >句前停顿（双唇闭着）<input
              v-model.number="beat.pauseBefore"
              type="number"
              min="0"
              max="2"
              step="0.1"
              :disabled="blocked"
            />秒</label
          >
        </details>
      </template>
      <label v-if="node.review.vocalMode !== 'none'"
        >台词字数估算<select
          v-model="node.review.speechSpeed"
          :disabled="blocked"
        >
          <option value="slow">慢速 · 每秒约 3.5 字</option>
          <option value="fast">快速 · 每秒约 4.6 字</option>
        </select></label
      >
      <label class="video-review-music"
        ><input
          v-model="node.review.music"
          type="checkbox"
          :disabled="blocked"
          @change="node.review.backgroundMusic = node.review.music"
        />音乐与伴奏</label
      >
      <p
        v-for="warning in node.review.warnings"
        :key="warning"
        class="video-review-warning"
      >
        {{ warning }}
      </p>
    </template>
    <div class="video-review-parameters">
      <label
        >清晰度<select
          v-model="node.videoParameters.quality"
          aria-label="提示词卡片清晰度"
          :disabled="blocked"
        >
          <option>480P</option>
          <option>720P</option>
        </select></label
      >
      <label
        >比例<select
          v-model="node.videoParameters.ratio"
          aria-label="提示词卡片比例"
          :disabled="blocked"
        >
          <option>9:16</option>
          <option>16:9</option>
          <option>1:1</option>
        </select></label
      >
      <label
        >时长<select
          v-model.number="node.videoParameters.seconds"
          aria-label="提示词卡片时长"
          :disabled="blocked"
        >
          <option
            v-for="seconds in videoDurations"
            :key="seconds"
            :value="seconds"
          >
            {{ seconds }} 秒
          </option>
        </select></label
      >
    </div>
    <div v-if="dimensions" class="video-output">
      <strong>{{ dimensions.width }} × {{ dimensions.height }}</strong
      ><span
        >约 {{ (videoFrames(node.videoParameters.seconds) / 24).toFixed(1) }} 秒
        · 24 fps</span
      >
    </div>
    <details v-if="node.review?.enginePrompt" class="video-review-engine">
      <summary>查看实际提交的提示词</summary>
      <p>画面说明适配模型；中文台词保留原文。确认时提交下面这一版。</p>
      <textarea
        :value="node.review.enginePrompt"
        readonly
        rows="7"
        aria-label="实际提交的模型提示词"
      />
    </details>
    <p v-if="node.reviewError" class="video-review-warning" role="alert">
      {{ node.reviewError }}
    </p>
    <p v-else-if="node.reviewPending" class="video-note" role="status">
      {{
        node.aiWriting
          ? "AI 正在扩写表演、镜头和声音，中文台词保留原文…"
          : "正在整理画面与台词，暂未提交视频任务…"
      }}
    </p>
    <p v-else-if="!prepared" class="video-review-warning">
      内容已修改。可直接确认生成，系统会先更新当前提示词。
    </p>
    <div v-if="!engine.ready" class="video-engine-status">
      <span>视频引擎未连接，可先整理提示词</span
      ><button
        type="button"
        class="ghost-button"
        :disabled="engine.checking"
        @click="emit('check-engine')"
      >
        重新连接
      </button>
    </div>
    <div class="video-review-buttons">
      <button
        type="button"
        class="ghost-button"
        :disabled="blocked"
        @click="emit('update')"
      >
        {{
          node.reviewPending
            ? "整理中…"
            : node.reviewError
              ? "重试整理"
              : "更新提示词"
        }}
      </button>
      <button
        class="primary-button"
        type="submit"
        :disabled="submitting || !engine.ready || !node.review"
      >
        {{ node.confirmPending ? "更新并提交中…" : "确认生成视频"
        }}<AppIcon name="arrow" />
      </button>
    </div>
  </form>
</template>
