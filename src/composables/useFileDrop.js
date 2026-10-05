import { ref, onMounted, onBeforeUnmount } from "vue";

export const hasFiles = (event) =>
  Array.from(event.dataTransfer?.types || []).includes("Files");

export function useFileDrop(receive) {
  const active = ref(false);
  let depth = 0;
  function reset() {
    depth = 0;
    active.value = false;
  }
  function enter(event) {
    if (!hasFiles(event)) return;
    event.preventDefault();
    depth++;
    active.value = true;
  }
  function over(event) {
    if (!hasFiles(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    active.value = true;
  }
  function leave() {
    depth = Math.max(0, depth - 1);
    if (!depth) active.value = false;
  }
  function drop(event) {
    reset();
    if (!hasFiles(event)) return;
    event.preventDefault();
    event.stopPropagation();
    receive(Array.from(event.dataTransfer.files), event);
  }
  function preventNavigation(event) {
    if (hasFiles(event)) event.preventDefault();
    if (event.type === "drop") reset();
  }
  onMounted(() => {
    window.addEventListener("dragover", preventNavigation);
    window.addEventListener("drop", preventNavigation);
    window.addEventListener("dragend", reset);
    window.addEventListener("blur", reset);
  });
  onBeforeUnmount(() => {
    window.removeEventListener("dragover", preventNavigation);
    window.removeEventListener("drop", preventNavigation);
    window.removeEventListener("dragend", reset);
    window.removeEventListener("blur", reset);
  });
  return { active, enter, over, leave, drop, reset };
}
