<script setup>
import { computed, ref, onMounted, onBeforeUnmount } from "vue";
import { summarize } from "../domain";
import SafeImage from "./SafeImage.vue";
import GenerationComposer from "./GenerationComposer.vue";
import AppIcon from "./AppIcon.vue";
const props = defineProps({
  node: Object,
  selected: Boolean,
  disabled: Boolean,
  config: Object,
  reference: Object,
  referenceCount: Number,
});
const emit = defineEmits(["action", "size"]);
const element = ref();
let observer;
onMounted(() => {
  observer = new ResizeObserver((entries) =>
    emit("size", props.node.id, entries[0].contentRect.height),
  );
  observer.observe(element.value);
});
onBeforeUnmount(() => observer?.disconnect());
const pending = computed(() =>
  ["loading", "failed"].includes(props.node.status),
);
function action(name) {
  emit("action", name, props.node);
}
</script>
<template>
  <article
    ref="element"
    class="board-node"
    :class="{
      'is-selected': selected,
      'is-loading': node.status === 'loading',
      'is-failed': node.status === 'failed',
      'is-empty': node.status === 'empty',
      'is-text': node.status === 'text',
    }"
    :data-node-id="node.id"
    :style="{ left: node.x + 'px', top: node.y + 'px' }"
  >
    <div v-if="node.status === 'text'" class="node-heading">
      <span><AppIcon name="edit" />文字节点</span
      ><button
        class="quiet-icon"
        aria-label="从画布移除文字节点"
        @click="action('delete')"
      >
        <AppIcon name="close" />
      </button>
    </div>
    <div v-if="node.status === 'loading'" class="board-node-status">
      <span class="loading-ring"></span
      ><span>{{
        node.uploading
          ? "上传中…"
          : node.preparing
            ? "准备参考图…"
            : node.jobStatus === "queued"
              ? "排队中…"
              : node.jobStatus === "running"
                ? "生成中…"
                : "提交中…"
      }}</span>
    </div>
    <div v-else-if="node.status === 'failed'" class="board-node-status">
      <span>{{
        node.jobStatus === "cancelled" ? "任务已取消" : "生成失败"
      }}</span
      ><small>{{ node.error }}</small>
    </div>
    <button
      v-else-if="node.status === 'empty'"
      type="button"
      class="board-node-pick"
      data-action="pick"
      @click="action('pick')"
    >
      <span class="board-node-pick-plus">＋</span><span>上传图片</span
      ><small v-if="node.error">{{ node.error }}</small>
    </button>
    <GenerationComposer
      v-else-if="node.status === 'text'"
      :model="node"
      :node-id="node.id"
      :config="config"
      :reference="reference"
      :reference-count="referenceCount"
      :disabled="disabled"
      @submit="action('run')"
      @remove-reference="action('unlink')"
    />
    <SafeImage
      v-else
      :src="node.url"
      :thumbnail="node.thumbnailUrl || node.url + '&thumbnail=1'"
      :alt="summarize(node.prompt)"
      draggable="false"
      loading="lazy"
      :style="
        node.width && node.height
          ? {
              aspectRatio: `${node.width}/${node.height}`,
              objectFit: 'contain',
            }
          : {}
      "
    />
    <div v-if="node.status !== 'text'" class="board-node-meta">
      <span>{{
        node.status === "text" ? "文本节点" : summarize(node.prompt, 20)
      }}</span
      ><span>{{
        node.ratio && node.quality
          ? `${node.ratio} · ${node.quality}`
          : node.status === "empty"
            ? "待上传"
            : "已上传"
      }}</span>
    </div>
    <div v-if="node.status !== 'text'" class="board-node-actions">
      <template v-if="!pending && !['empty', 'text'].includes(node.status)"
        ><button
          data-action="zoom"
          title="放大预览"
          aria-label="放大预览"
          @click="action('zoom')"
        >
          <AppIcon name="expand" /></button
        ><button
          data-action="edit"
          title="基于这张图编辑"
          aria-label="基于这张图编辑"
          @click="action('edit')"
        >
          <AppIcon name="edit" /></button></template
      ><button
        data-action="delete"
        aria-label="从画布移除"
        @click="action('delete')"
      >
        <AppIcon name="close" />
      </button>
    </div>
    <button
      class="board-port board-port-left"
      data-port="left"
      aria-label="从左侧连线"
    ></button
    ><button
      class="board-port board-port-right"
      data-port="right"
      aria-label="从右侧连线"
    ></button>
  </article>
</template>
