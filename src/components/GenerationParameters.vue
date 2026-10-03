<script setup>
import { ref, watch, nextTick, useId, onMounted, onBeforeUnmount } from "vue";
import AppIcon from "./AppIcon.vue";
defineProps({ model: Object, config: Object });
const open = ref(false),
  root = ref(),
  trigger = ref(),
  popover = ref();
const popupId = useId();
const position = ref({ visibility: "hidden" });
async function place() {
  await nextTick();
  if (!open.value || !trigger.value || !popover.value) return;
  const anchor = trigger.value.getBoundingClientRect();
  const width = Math.min(344, window.innerWidth - 32);
  const height = Math.min(popover.value.scrollHeight, window.innerHeight - 32);
  const top =
    anchor.top >= height + 12
      ? anchor.top - height - 10
      : Math.min(anchor.bottom + 10, window.innerHeight - height - 16);
  position.value = {
    left:
      Math.max(16, Math.min(anchor.left, window.innerWidth - width - 16)) +
      "px",
    top: Math.max(16, top) + "px",
    width: width + "px",
    maxHeight: window.innerHeight - 32 + "px",
  };
}
watch(open, (value) => {
  if (value) {
    position.value = { visibility: "hidden" };
    place().then(() => {
      if (open.value)
        popover.value
          ?.querySelector('[aria-checked="true"]')
          ?.focus({ preventScroll: true });
    });
  }
});
function close() {
  open.value = false;
  trigger.value?.focus();
}
function escape(event) {
  if (!open.value) return;
  event.preventDefault();
  event.stopPropagation();
  close();
}
function outside(event) {
  if (
    !root.value?.contains(event.target) &&
    !popover.value?.contains(event.target)
  )
    open.value = false;
}
function scroll(event) {
  if (!popover.value?.contains(event.target)) open.value = false;
}
function tab(event) {
  const buttons = [...popover.value.querySelectorAll("button")];
  const first = buttons[0],
    last = buttons.at(-1);
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}
onMounted(() => {
  document.addEventListener("pointerdown", outside, true);
  window.addEventListener("resize", place);
  document.addEventListener("wheel", scroll, { passive: true, capture: true });
  document.addEventListener("scroll", scroll, true);
});
onBeforeUnmount(() => {
  document.removeEventListener("pointerdown", outside, true);
  window.removeEventListener("resize", place);
  document.removeEventListener("wheel", scroll, true);
  document.removeEventListener("scroll", scroll, true);
});
defineExpose({ close });
</script>
<template>
  <div
    ref="root"
    class="generation-parameters"
    @keydown.esc="escape"
    @pointerdown.stop
  >
    <button
      ref="trigger"
      type="button"
      class="parameter-trigger"
      aria-label="生成参数"
      aria-haspopup="dialog"
      :aria-controls="popupId"
      :aria-expanded="open"
      @click="open = !open"
    >
      <span
        class="parameter-ratio-icon"
        :style="{ aspectRatio: model.ratio.replace(':', '/') }"
      ></span
      ><span
        >{{ model.ratio }} · {{ config.qualities[model.quality].label }}</span
      ><AppIcon name="chevron" :class="{ 'is-open': open }" />
    </button>
    <Teleport to="body">
      <section
        v-if="open"
        :id="popupId"
        ref="popover"
        :style="position"
        class="parameter-popover"
        role="dialog"
        aria-label="生成参数面板"
        @pointerdown.stop
        @keydown.stop
        @keydown.tab="tab"
        @keydown.esc.stop.prevent="close"
      >
        <div class="parameter-heading">
          <strong>生成参数</strong
          ><button
            type="button"
            class="quiet-icon"
            aria-label="关闭参数"
            @click="close"
          >
            <AppIcon name="close" />
          </button>
        </div>
        <span class="parameter-label">输出质量</span>
        <div class="parameter-options" role="radiogroup" aria-label="输出质量">
          <button
            v-for="(quality, key) in config.qualities"
            :key="key"
            type="button"
            role="radio"
            :aria-checked="model.quality === key"
            :class="{ 'is-selected': model.quality === key }"
            :data-quality="key"
            @click="model.quality = key"
          >
            {{ quality.label }}
          </button>
        </div>
        <span class="parameter-label">画面比例</span>
        <div
          class="parameter-options ratio-options"
          role="radiogroup"
          aria-label="画面比例"
        >
          <button
            v-for="ratio in ['1:1', '16:9', '9:16', '4:3', '3:4', '3:2']"
            :key="ratio"
            type="button"
            role="radio"
            :aria-checked="model.ratio === ratio"
            :class="{ 'is-selected': model.ratio === ratio }"
            :data-ratio="ratio"
            @click="model.ratio = ratio"
          >
            {{ ratio }}
          </button>
        </div>
        <small class="parameter-output"
          >{{ config.ratios[model.ratio][model.quality].join(" × ") }} px</small
        >
      </section>
    </Teleport>
  </div>
</template>
