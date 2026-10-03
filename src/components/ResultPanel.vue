<script setup>
import { computed, ref, onBeforeUnmount } from "vue";
import { summarize, pending } from "../domain";
import SafeImage from "./SafeImage.vue";
import AppIcon from "./AppIcon.vue";
const props = defineProps({ store: Object });
const { s } = props.store;
const job = computed(() => s.jobs.find((j) => j.id === s.selectedJobId));
const failed = computed(() =>
  ["failed", "cancelled"].includes(job.value?.status),
);
const now = ref(Date.now());
const timer = setInterval(() => (now.value = Date.now()), 1000);
onBeforeUnmount(() => clearInterval(timer));
const elapsed = computed(() => {
  const seconds = Math.max(
    0,
    Math.floor((now.value - (job.value?.createdAt || now.value)) / 1000),
  );
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
});
const dims = computed(() =>
  job.value
    ? [
        job.value.finalWidth || job.value.width,
        job.value.finalHeight || job.value.height,
      ]
    : s.config.ratios[s.form.ratio][s.form.quality],
);
function preview() {
  if (job.value?.imageUrl)
    s.preview = {
      url: job.value.imageUrl,
      caption: summarize(job.value.prompt),
    };
}
function example() {
  s.form.prompt =
    "一位穿白色亚麻裙的女孩，站在海边的风里，清晨柔光，电影感人像摄影";
}
</script>
<template>
  <section class="canvas-panel panel" aria-live="polite">
    <div class="canvas-heading">
      <div>
        <h2 id="canvasTitle">
          {{
            s.submitting
              ? "正在提交"
              : pending(job)
                ? job?.status === "queued"
                  ? "排队中"
                  : "正在生成"
                : failed
                  ? job?.status === "cancelled"
                    ? "任务已取消"
                    : "生成失败"
                  : job?.imageUrl
                    ? "生成结果"
                    : "预览"
          }}
        </h2>
      </div>
      <span id="canvasSize" class="canvas-size"
        >{{ dims[0] || "—" }} × {{ dims[1] || "—" }}</span
      >
    </div>
    <div id="canvasStage" class="canvas-stage">
      <div
        id="emptyState"
        class="empty-state"
        :class="{ hidden: s.submitting || !!job }"
      >
        <AppIcon name="image" class="empty-image-icon" />
        <h3>开始生成图片</h3>
        <p>输入提示词，选择比例和输出质量。</p>
        <button id="fillExample" class="ghost-button" @click="example">
          使用示例提示词
        </button>
      </div>
      <div
        id="loadingState"
        class="loading-state"
        :class="{ hidden: !s.submitting && !pending(job) }"
      >
        <div class="loading-visual">
          <div class="loading-ring"></div>
        </div>
        <h3>
          {{ job?.status === "queued" ? "任务已加入队列" : "正在生成图片" }}
        </h3>
        <p id="loadingDetail">
          {{
            job?.connectionError ||
            (job?.status === "running"
              ? "完成后将在这里显示结果，可以继续添加其他任务。"
              : "等待前面的任务完成，可以继续添加其他任务。")
          }}
        </p>
        <div class="progress-track"><span></span></div>
        <div class="loading-meta">
          <span id="loadingElapsed">{{ elapsed }}</span
          ><span id="loadingStage">{{
            job?.status === "running" ? "生成中" : "排队中"
          }}</span>
        </div>
        <button
          v-if="pending(job)"
          class="ghost-button"
          @click="store.cancel(job)"
        >
          取消这个任务
        </button>
      </div>
      <div
        id="resultState"
        class="result-state"
        :class="{ hidden: s.submitting || job?.status !== 'completed' }"
      >
        <div
          id="resultImageWrap"
          class="result-image-wrap"
          role="button"
          tabindex="0"
          aria-label="打开图片预览"
          @click="preview"
          @keydown.enter="preview"
          @keydown.space.prevent="preview"
        >
          <SafeImage
            id="resultImage"
            :src="job?.imageUrl"
            :alt="summarize(job?.prompt)"
          />
          <div class="image-overlay">
            <span id="resultQuality">{{
              s.config.qualities[job?.quality]?.label
            }}</span
            ><span id="resultRatio">{{ job?.ratio }}</span>
          </div>
          <span class="preview-hint">点击放大</span>
        </div>
        <div class="result-info">
          <div>
            <h3 id="resultTitle">{{ summarize(job?.prompt, 70) }}</h3>
          </div>
          <a
            id="downloadButton"
            class="download-button"
            :href="job?.downloadUrl || job?.imageUrl"
            download
            ><AppIcon name="download" />下载原图</a
          >
        </div>
        <div id="resultDetails" class="result-details">
          <span>{{ dims[0] }} × {{ dims[1] }} px</span
          ><span>种子 {{ job?.seed }}</span
          ><span>{{
            job?.quality === "4K" ? "精细生图 + 超分" : "原生生成"
          }}</span>
        </div>
      </div>
      <div
        id="errorState"
        class="error-state"
        :class="{ hidden: s.submitting || !failed }"
      >
        <div class="error-icon">!</div>
        <h3>{{ job?.status === "cancelled" ? "任务已取消" : "生成失败" }}</h3>
        <p id="errorMessage">{{ job?.error || "任务已经结束" }}</p>
        <button
          id="retryButton"
          class="ghost-button"
          :disabled="store.busy()"
          @click="store.retry(job)"
        >
          用相同参数重试
        </button>
      </div>
    </div>
    <div class="canvas-footer">
      <span
        ><i class="footer-dot"></i
        ><span id="canvasFooterText">{{
          s.health.state === "online"
            ? `本地生成 · 队列 ${s.health.queue || 0} 个任务`
            : "请先启动 ComfyUI 本地服务"
        }}</span></span
      ><span>支持中文提示词</span>
    </div>
  </section>
</template>
