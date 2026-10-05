<script setup>
import { ref, computed, onBeforeUnmount } from "vue";
import AppIcon from "./AppIcon.vue";
const props = defineProps({ node: Object });
const emit = defineEmits(["cancel", "retry", "delete"]);
const player = ref();
const playbackError = ref(false);
const now = ref(Date.now());
const timer = setInterval(() => (now.value = Date.now()), 1000);
onBeforeUnmount(() => clearInterval(timer));
const elapsed = computed(() => {
  const seconds = Math.max(
    0,
    Math.floor((now.value - (props.node.createdAt || now.value)) / 1000),
  );
  return `${Math.floor(seconds / 60)}分${seconds % 60}秒`;
});
function retryPlayback() {
  playbackError.value = false;
  player.value?.load();
}
</script>
<template>
  <div class="video-result-heading node-heading">
    <span><AppIcon name="video" />{{ node.quality }} 视频</span
    ><button
      class="quiet-icon"
      aria-label="移除视频节点"
      @click="emit('delete')"
    >
      <AppIcon name="close" />
    </button>
  </div>
  <div
    v-if="node.status === 'done'"
    class="video-player"
    :style="{
      aspectRatio:
        node.width && node.height
          ? `${node.width} / ${node.height}`
          : (node.ratio || '16:9').replace(':', ' / '),
    }"
    @pointerdown.stop
    @dblclick.stop
  >
    <video
      ref="player"
      :src="node.url"
      controls
      playsinline
      preload="metadata"
      @error="playbackError = true"
      @loadedmetadata="playbackError = false"
      :aria-label="node.dialogue || node.prompt || '生成的视频'"
    ></video>
    <div v-if="playbackError" class="video-playback-error">
      视频暂时无法播放<button class="ghost-button" @click="retryPlayback">
        重试播放
      </button>
    </div>
  </div>
  <div v-else class="board-node-status" aria-live="polite">
    <span v-if="node.status === 'loading'" class="loading-ring"></span
    ><strong>{{
      node.status === "failed"
        ? node.jobStatus === "cancelled"
          ? "视频已取消"
          : "视频生成失败"
        : node.preparing
          ? "准备参考图…"
          : node.jobStatus === "queued"
            ? "视频排队中…"
            : node.stage === "decoding"
              ? "正在解码画面与声音…"
              : node.stage === "encoding"
                ? "正在保存 MP4…"
                : node.jobStatus === "running"
                  ? "正在生成视频…"
                  : "正在提交视频…"
    }}</strong
    ><span
      v-if="node.status === 'loading' && node.sampleTotal"
      class="video-step-count"
      >采样 {{ node.sampleStep }} / {{ node.sampleTotal }} 步</span
    ><small>{{
      node.error ||
      node.connectionError ||
      (node.status === "loading" ? `已等待 ${elapsed} · 完成后可直接播放` : "")
    }}</small>
  </div>
  <p v-if="node.dialogue" class="video-result-dialogue">
    “{{ node.dialogue }}”
  </p>
  <div class="video-result-footer" @pointerdown.stop>
    <span
      >{{ node.ratio || "16:9" }} · {{ node.width }} × {{ node.height
      }}<template v-if="node.duration">
        · {{ node.duration.toFixed(1) }}s</template
      ></span
    ><a
      v-if="node.status === 'done'"
      class="ghost-button"
      :href="node.downloadUrl || node.url"
      download
      ><AppIcon name="download" />下载</a
    ><button
      v-else-if="node.status === 'loading' && node.jobId"
      class="ghost-button"
      @click="emit('cancel')"
    >
      取消任务</button
    ><button
      v-else-if="node.status === 'failed'"
      class="ghost-button"
      @click="emit('retry')"
    >
      重新生成
    </button>
  </div>
</template>
