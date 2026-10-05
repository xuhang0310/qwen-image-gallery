<script setup>
import { computed, ref } from "vue";
import { label, summarize, pending, jobRatio } from "../domain";
import SafeImage from "./SafeImage.vue";
import AppIcon from "./AppIcon.vue";
const props = defineProps({ store: Object });
const { s } = props.store;
const count = ref(50);
const jobs = computed(() =>
  s.jobs.filter((j) => !s.hiddenJobIds.includes(j.id)),
);
const visible = computed(() => jobs.value.slice(0, count.value));
const runningCount = computed(
  () => s.jobs.filter((j) => j.status === "running").length,
);
const queuedCount = computed(
  () => s.jobs.filter((j) => j.status === "queued").length,
);
const time = (timestamp) =>
  new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(timestamp);
</script>
<template>
  <aside class="history-panel panel">
    <div class="panel-heading history-heading">
      <div>
        <h2>最近任务</h2>
      </div>
      <span id="taskCount" class="task-count">{{ jobs.length }}</span>
    </div>
    <p v-if="runningCount || queuedCount" id="queueSummary" class="image-note">
      生成中 {{ runningCount }} · 排队中 {{ queuedCount }}
    </p>
    <div id="taskList" class="task-list">
      <div v-if="!jobs.length" class="history-empty">
        <span>暂无任务记录</span><small>生成的图片会保存在这里</small>
      </div>
      <article
        v-for="job in visible"
        :key="job.id"
        class="task-card"
        :class="{ 'is-active': job.id === s.selectedJobId }"
        :data-job-id="job.id"
        tabindex="0"
        @click="s.selectedJobId = job.id"
        @keydown.enter="s.selectedJobId = job.id"
      >
        <div class="task-thumb">
          <SafeImage
            v-if="job.imageUrl"
            :src="job.imageUrl"
            :thumbnail="job.thumbnailUrl || job.imageUrl + '&thumbnail=1'"
            loading="lazy"
            alt=""
          /><span v-else><AppIcon name="image" /></span>
        </div>
        <div class="task-info">
          <strong class="task-name">{{ summarize(job.prompt) }}</strong>
          <div class="task-meta">
            <span class="task-status" :class="job.status">{{
              label(job.status)
            }}</span
            ><span>·</span><span>{{ time(job.createdAt) }}</span>
          </div>
          <div class="task-tags">
            <span>{{ jobRatio(job) }}</span
            ><span v-if="job.provider !== 'api'">{{
              store.qualityLabel(job)
            }}</span
            ><span>{{ job.mode === "img2img" ? "图像编辑" : "文生图" }}</span>
            <span :title="job.model">{{
              job.provider === "api" ? `${job.model} · API` : "本地 Qwen"
            }}</span>
          </div>
          <small v-if="job.connectionError" class="connection-warning">{{
            job.connectionError
          }}</small>
        </div>
        <button
          v-if="pending(job)"
          type="button"
          class="task-retry"
          :data-cancel-id="job.id"
          @click.stop="store.cancel(job)"
        >
          取消任务</button
        ><button
          v-else
          type="button"
          class="task-retry"
          :data-retry-id="job.id"
          :disabled="store.busy()"
          @click.stop="store.retry(job)"
        >
          {{ job.status === "completed" ? "重新生成" : "重试" }}</button
        ><button
          type="button"
          class="task-delete"
          :data-delete-id="job.id"
          aria-label="移除历史记录"
          title="只移除记录，图片文件保留"
          @click.stop="store.deleteJob(job.id)"
        >
          <AppIcon name="close" />
        </button>
      </article>
    </div>
    <button
      v-if="visible.length < jobs.length"
      class="ghost-button"
      @click="count += 50"
    >
      加载更多</button
    ><button
      id="clearHistory"
      class="clear-history"
      @click="store.clearHistory"
    >
      清除已结束记录
    </button>
  </aside>
</template>
