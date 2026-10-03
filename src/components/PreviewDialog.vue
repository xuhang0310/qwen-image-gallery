<script setup>
import { onMounted, onBeforeUnmount, ref, watch, nextTick } from "vue";
import SafeImage from "./SafeImage.vue";
const props = defineProps({ preview: Object });
const emit = defineEmits(["close"]);
const closeButton = ref();
let previousFocus;
watch(
  () => props.preview,
  async (value) => {
    document.body.classList.toggle("preview-open", !!value);
    if (value) {
      previousFocus = document.activeElement;
      await nextTick();
      closeButton.value?.focus();
    } else previousFocus?.focus();
  },
);
function key(event) {
  if (props.preview && event.key === "Escape") {
    event.stopImmediatePropagation();
    emit("close");
  }
  if (props.preview && event.key === "Tab") {
    event.preventDefault();
    closeButton.value?.focus();
  }
}
onMounted(() => document.addEventListener("keydown", key, true));
onBeforeUnmount(() => {
  document.removeEventListener("keydown", key, true);
  document.body.classList.remove("preview-open");
});
</script>
<template>
  <div
    id="imagePreview"
    class="image-preview"
    :class="{ hidden: !preview }"
    role="dialog"
    aria-modal="true"
    aria-labelledby="previewCaption"
  >
    <div
      class="preview-backdrop"
      data-close-preview
      @click="emit('close')"
    ></div>
    <div class="preview-dialog">
      <button
        id="previewClose"
        ref="closeButton"
        class="preview-close"
        aria-label="关闭图片预览"
        @click="emit('close')"
      >
        ×</button
      ><SafeImage id="previewImage" :src="preview?.url" alt="放大预览" />
      <p id="previewCaption">{{ preview?.caption }}</p>
    </div>
  </div>
</template>
