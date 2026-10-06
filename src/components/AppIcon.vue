<script setup>
defineProps({ name: String });
const paths = {
  video: "M3 5h13v14H3zM16 10l5-3v10l-5-3M8 9l4 3-4 3z",
  folder: "M3 7h7l2-3h9v16H3zM3 7V4h7l2 3",
  home: "M3 10l9-7 9 7M5 9v12h14V9M10 21v-7h4v7",
  close: "M6 6l12 12M18 6L6 18",
  arrow: "M4 12h16m-6-6 6 6-6 6",
  chevron: "m7 10 5 5 5-5",
  image: "M4 4h16v16H4zM4 16l5-5 4 4 3-3 4 4M8 8h.01",
  grid: "M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z",
  refresh:
    "M20 7v5h-5M4 17v-5h5M6 7a7 7 0 0 1 12-1l2 6M4 12l2 6a7 7 0 0 0 12-1",
  expand: "M9 4H4v5m11-5h5v5M4 15v5h5m11-5v5h-5",
  edit: "m15 5 4 4M4 20l1-5L16 4a2 2 0 0 1 3 3L8 18z",
  link: "m10 13 4-4M8 16l-1 1a3 3 0 0 1-4-4l4-4a3 3 0 0 1 4 0m2 0 4-4a3 3 0 0 1 4 4l-4 4a3 3 0 0 1-4 0",
  download: "M12 3v12m-5-5 5 5 5-5M4 17v4h16v-4",
  upload: "M12 16V4m-5 5 5-5 5 5M4 17v4h16v-4",
  plus: "M12 5v14M5 12h14",
  check: "m5 12 4 4L19 6",
  settings: "M4 7h16M4 17h16M8 4v6M16 14v6",
  trash: "M4 7h16M9 3h6l1 4M6 7l1 14h10l1-14M10 11v6M14 11v6",
  undo: "M4 9h9a7 7 0 0 1 0 14M4 9l5-5M4 9l5 5",
};
</script>
<template>
  <svg
    class="app-icon"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.6"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <path :d="paths[name] || paths.image" />
  </svg>
</template>
