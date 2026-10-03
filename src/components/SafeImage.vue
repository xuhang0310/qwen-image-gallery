<script setup>
import { computed, ref, watch } from "vue";
defineOptions({ inheritAttrs: false });
const props = defineProps({ src: String, thumbnail: String, alt: String });
const original = ref(false);
const failed = ref(false);
const attempt = ref(0);
watch(
  () => [props.src, props.thumbnail],
  () => {
    original.value = false;
    failed.value = false;
    attempt.value = 0;
  },
);
const url = computed(() => {
  const source = original.value ? props.src : props.thumbnail || props.src;
  return source && attempt.value ? `${source}&retry=${attempt.value}` : source;
});
function error() {
  if (!original.value && props.thumbnail && props.thumbnail !== props.src)
    original.value = true;
  else failed.value = true;
}
function retry() {
  attempt.value++;
  original.value = false;
  failed.value = false;
}
</script>
<template>
  <img
    v-if="src && !failed"
    v-bind="$attrs"
    :src="url"
    :alt="alt || ''"
    @error="error"
  />
  <div
    v-else-if="failed"
    v-bind="$attrs"
    class="image-load-error"
    role="status"
  >
    <span>图片暂时无法读取</span>
    <button type="button" @pointerdown.stop @click.stop="retry">
      重新加载
    </button>
  </div>
</template>
