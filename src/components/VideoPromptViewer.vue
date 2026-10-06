<script setup>
import { computed, ref, watch, nextTick, onBeforeUnmount } from "vue";
import AppIcon from "./AppIcon.vue";
const props = defineProps({
  open: Boolean,
  initialView: { type: String, default: "original" },
  original: { type: String, default: null },
  current: { type: String, default: "" },
});
const emit = defineEmits(["close"]);
const view = ref(props.initialView),
  panel = ref(),
  closeButton = ref();
const content = computed(() =>
  view.value === "original" ? props.original : props.current,
);
let previous;
watch(
  () => props.open,
  async (open) => {
    if (!open) {
      previous?.focus();
      return;
    }
    previous = document.activeElement;
    view.value = props.initialView;
    await nextTick();
    closeButton.value?.focus();
  },
);
onBeforeUnmount(() => {
  if (props.open) previous?.focus();
});
function key(event) {
  event.stopPropagation();
  if (event.key === "Escape") {
    event.preventDefault();
    emit("close");
  }
  if (event.key === "Tab") {
    const items = [...panel.value.querySelectorAll("button,textarea")].filter(
      (el) => !el.disabled,
    );
    if (event.shiftKey && document.activeElement === items[0]) {
      event.preventDefault();
      items.at(-1)?.focus();
    } else if (!event.shiftKey && document.activeElement === items.at(-1)) {
      event.preventDefault();
      items[0]?.focus();
    }
  }
}
</script>
<template>
  <Teleport to="body">
    <div
      v-if="open"
      class="video-prompt-viewer-layer"
      @keydown="key"
      @pointerdown.stop
      @wheel.stop
    >
      <div class="video-prompt-viewer-backdrop" @click="emit('close')"></div>
      <section
        ref="panel"
        class="video-prompt-viewer"
        role="dialog"
        aria-modal="true"
        aria-label="提示词审核"
      >
        <header>
          <div>
            <span class="video-prompt-viewer-kicker">视频生成</span>
            <h2>提示词审核</h2>
          </div>
          <button
            ref="closeButton"
            class="icon-button"
            type="button"
            aria-label="关闭提示词审核"
            @click="emit('close')"
          >
            <AppIcon name="close" />
          </button>
        </header>
        <div class="video-prompt-viewer-caption">
          <span>{{ content?.length || 0 }} 字</span>
        </div>
        <textarea
          v-if="content !== null"
          :aria-label="
            view === 'original' ? '原始提示词内容' : '当前提示词内容'
          "
          :value="content"
          readonly
          spellcheck="false"
        ></textarea>
        <div v-else class="video-prompt-viewer-empty" role="status">
          <strong>未保存原始提示词</strong>
          <p>
            这个节点在旧版本中已优化，优化前的原文无法还原。新节点会自动保存 AI
            优化前的提示词。
          </p>
        </div>
        <footer>
          <span>只读审核 · 可选择文字复制</span
          ><button type="button" class="ghost-button" @click="emit('close')">
            关闭
          </button>
        </footer>
      </section>
    </div>
  </Teleport>
</template>
