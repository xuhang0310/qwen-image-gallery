<script setup>
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import AppIcon from "./AppIcon.vue";
import SafeImage from "./SafeImage.vue";
import { assetOnBoard } from "../../shared/media-library.mjs";
import { summarize } from "../domain";

const props = defineProps({ store: Object });
const { s } = props.store;
const search = ref("");
const type = ref("all");
const provider = ref("all");
const order = ref("newest");
const limit = ref(24);
const selected = ref(null);
const dialog = ref();
const player = ref();
const playbackError = ref(false);
const videoFailures = ref(new Set());
const assets = computed(() => props.store.assets.value);
const imageCount = computed(
  () => assets.value.filter((asset) => asset.mediaType === "image").length,
);
const videoCount = computed(() => assets.value.length - imageCount.value);
const tabs = computed(() => [
  { id: "all", label: "全部", count: assets.value.length },
  { id: "image", label: "图片", count: imageCount.value },
  { id: "video", label: "视频", count: videoCount.value },
]);
const filtered = computed(() => {
  const query = search.value.trim().toLowerCase();
  const list = assets.value.filter(
    (asset) =>
      (type.value === "all" || asset.mediaType === type.value) &&
      (provider.value === "all" ||
        (asset.provider || "local") === provider.value) &&
      (!query ||
        [asset.prompt, asset.dialogue, asset.model].some((value) =>
          String(value || "")
            .toLowerCase()
            .includes(query),
        )),
  );
  return order.value === "oldest" ? list.reverse() : list;
});
const visible = computed(() => filtered.value.slice(0, limit.value));
const dimensions = (asset) => {
  const width = asset.finalWidth || asset.width;
  const height = asset.finalHeight || asset.height;
  return width && height ? `${width} × ${height}` : asset.ratio || "";
};
const modelName = (asset) =>
  asset.mediaType === "video"
    ? asset.model || "MiniMax H3"
    : asset.provider === "api"
      ? asset.model
      : "Qwen Image 2.1";
const time = (timestamp) =>
  new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(timestamp);
const inCanvas = (asset) => !!assetOnBoard(asset, s.board.nodes);
watch([search, type, provider, order], () => {
  limit.value = 24;
});
watch(selected, async (asset) => {
  playbackError.value = false;
  document.body.classList.toggle("library-preview-open", !!asset);
  if (asset) {
    await nextTick();
    if (selected.value === asset && dialog.value && !dialog.value.open)
      dialog.value.showModal();
  } else dialog.value?.close();
});
function closePreview() {
  player.value?.pause();
  selected.value = null;
}
function place(asset) {
  closePreview();
  props.store.placeAsset(asset);
}
function retryPlayback() {
  playbackError.value = false;
  player.value?.load();
}
function resetFilters() {
  search.value = "";
  type.value = "all";
  provider.value = "all";
}
onBeforeUnmount(() => {
  player.value?.pause();
  dialog.value?.close();
  document.body.classList.remove("library-preview-open");
});
</script>

<template>
  <main class="library-page">
    <div class="page-intro">
      <div>
        <h2>全部素材</h2>
        <p>所有项目生成的图片与视频，统一查看和复用。</p>
      </div>
      <button
        class="ghost-button"
        :disabled="s.libraryLoading || !s.ready"
        @click="store.refreshLibrary"
      >
        <AppIcon name="refresh" />{{
          s.libraryLoading ? "正在更新…" : "刷新素材"
        }}
      </button>
    </div>

    <div class="library-toolbar">
      <div class="library-tabs" role="group" aria-label="素材类型">
        <button
          v-for="tab in tabs"
          :key="tab.id"
          :aria-pressed="type === tab.id"
          :class="{ active: type === tab.id }"
          @click="type = tab.id"
        >
          {{ tab.label }}<span>{{ tab.count }}</span>
        </button>
      </div>
      <div class="library-filters">
        <input
          v-model="search"
          type="search"
          aria-label="搜索素材"
          placeholder="搜索提示词或模型"
        />
        <select v-model="provider" aria-label="素材来源">
          <option value="all">全部来源</option>
          <option value="local">本地生成</option>
          <option value="api">API 生成</option>
        </select>
        <select v-model="order" aria-label="素材排序">
          <option value="newest">最新优先</option>
          <option value="oldest">最早优先</option>
        </select>
      </div>
    </div>
    <div class="library-summary">
      <span role="status">{{
        s.ready ? `${filtered.length} 个素材` : "正在加载素材…"
      }}</span>
      <span
        >加入画布：<strong>{{ s.currentProject.name }}</strong></span
      >
    </div>
    <div v-if="s.libraryError" class="library-load-error" role="alert">
      <span>{{ s.libraryError }}</span>
      <button
        class="ghost-button"
        :disabled="s.libraryLoading"
        @click="store.refreshLibrary"
      >
        重新加载
      </button>
    </div>
    <div v-if="s.ready && !filtered.length" class="library-empty">
      <AppIcon name="library" />
      <h3>{{ assets.length ? "没有找到匹配的素材" : "素材库还是空的" }}</h3>
      <p>
        {{
          assets.length
            ? "换个关键词，或调整类型和来源筛选。"
            : "生成完成的图片和视频会自动出现在这里。"
        }}
      </p>
      <button v-if="assets.length" class="ghost-button" @click="resetFilters">
        清除筛选
      </button>
      <button v-else class="ghost-button" @click="store.navigate('workbench')">
        去工作台生成<AppIcon name="arrow" />
      </button>
    </div>

    <div class="library-grid" :aria-busy="s.libraryLoading || !s.ready">
      <article
        v-for="asset in visible"
        :key="asset.assetId"
        class="media-card"
        :data-asset-id="asset.assetId"
      >
        <div class="media-cover">
          <SafeImage
            v-if="asset.mediaType === 'image'"
            :src="asset.imageUrl"
            :thumbnail="asset.thumbnailUrl"
            :alt="summarize(asset.prompt)"
            loading="lazy"
          />
          <template v-else>
            <video
              v-if="!videoFailures.has(asset.assetId)"
              :src="asset.videoUrl"
              muted
              playsinline
              preload="metadata"
              aria-hidden="true"
              tabindex="-1"
              @error="videoFailures.add(asset.assetId)"
            ></video>
            <span class="media-video-mark"><AppIcon name="video" /></span>
          </template>
          <span class="media-type-badge"
            >{{ asset.mediaType === "video" ? "视频" : "图片"
            }}<template v-if="asset.mediaType === 'video' && asset.duration">
              · {{ Number(asset.duration).toFixed(1) }}s</template
            ></span
          >
          <button
            class="media-open"
            :aria-label="'预览素材 ' + summarize(asset.prompt)"
            @click="selected = asset"
          >
            <span><AppIcon name="expand" />预览</span>
          </button>
        </div>
        <div class="media-card-body">
          <h3 :title="asset.prompt">{{ summarize(asset.prompt, 80) }}</h3>
          <div class="media-card-meta">
            <span>{{ dimensions(asset) }}</span
            ><span :title="asset.model">{{ modelName(asset) }}</span>
          </div>
          <div class="media-card-footer">
            <time :datetime="new Date(asset.createdAt).toISOString()">{{
              time(asset.createdAt)
            }}</time>
            <a
              class="icon-button"
              :href="asset.downloadUrl"
              download
              :aria-label="'下载素材 ' + summarize(asset.prompt)"
              title="下载原文件"
              ><AppIcon name="download"
            /></a>
            <button
              class="media-add"
              :disabled="!s.ready || s.projectBusy"
              @click="place(asset)"
            >
              {{ inCanvas(asset) ? "定位节点" : "加入画布"
              }}<AppIcon name="arrow" />
            </button>
          </div>
        </div>
      </article>
    </div>
    <div v-if="visible.length < filtered.length" class="library-more">
      <button class="ghost-button" @click="limit += 24">
        加载更多（{{ filtered.length - visible.length }}）
      </button>
    </div>
  </main>

  <dialog
    ref="dialog"
    class="media-detail-dialog"
    aria-labelledby="mediaDetailTitle"
    @cancel.prevent="closePreview"
    @close="selected = null"
    @click="
      (event) => {
        if (event.target === dialog) closePreview();
      }
    "
  >
    <template v-if="selected">
      <button
        class="media-detail-close icon-button"
        autofocus
        aria-label="关闭素材预览"
        @click="closePreview"
      >
        <AppIcon name="close" />
      </button>
      <div class="media-detail-layout">
        <div class="media-detail-preview">
          <SafeImage
            v-if="selected.mediaType === 'image'"
            :src="selected.imageUrl"
            :alt="summarize(selected.prompt)"
          />
          <template v-else>
            <video
              ref="player"
              :src="selected.videoUrl"
              controls
              playsinline
              preload="metadata"
              aria-label="素材视频预览"
              @error="playbackError = true"
              @loadedmetadata="playbackError = false"
            ></video>
            <div
              v-if="playbackError"
              class="media-playback-error"
              role="status"
            >
              视频暂时无法播放<button
                class="ghost-button"
                @click="retryPlayback"
              >
                重试播放</button
              ><a class="ghost-button" :href="selected.downloadUrl" download
                >下载视频</a
              >
            </div>
          </template>
        </div>
        <div class="media-detail-info">
          <span class="media-detail-type">{{
            selected.mediaType === "video" ? "视频素材" : "图片素材"
          }}</span>
          <h2 id="mediaDetailTitle">素材详情</h2>
          <dl>
            <dt>生成时间</dt>
            <dd>{{ time(selected.createdAt) }}</dd>
            <dt>模型</dt>
            <dd>{{ modelName(selected) }}</dd>
            <dt>来源</dt>
            <dd>{{ selected.provider === "api" ? "API 生成" : "本地生成" }}</dd>
            <dt>尺寸</dt>
            <dd>{{ dimensions(selected) || "—" }}</dd>
            <template v-if="selected.mediaType === 'video' && selected.duration"
              ><dt>时长</dt>
              <dd>{{ Number(selected.duration).toFixed(1) }} 秒</dd></template
            >
          </dl>
          <h3>提示词</h3>
          <p class="media-detail-prompt">{{ selected.prompt }}</p>
          <template v-if="selected.dialogue"
            ><h3>台词</h3>
            <p class="media-detail-prompt">{{ selected.dialogue }}</p></template
          >
          <div class="media-detail-actions">
            <a class="ghost-button" :href="selected.downloadUrl" download
              ><AppIcon name="download" />下载原文件</a
            ><button
              class="primary-button"
              :disabled="!s.ready || s.projectBusy"
              @click="place(selected)"
            >
              {{ inCanvas(selected) ? "定位节点" : "加入画布"
              }}<AppIcon name="arrow" />
            </button>
          </div>
        </div>
      </div>
    </template>
  </dialog>
</template>
