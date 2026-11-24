<script setup>
// 统一图标系统：24 网格 / stroke 1.6 / 圆头圆角 / 几何化
defineProps({
  name: { type: String, required: true },
  size: { type: [Number, String], default: 16 },
  stroke: { type: [Number, String], default: 1.6 },
})

const PATHS = {
  plus: 'M12 5v14M5 12h14',
  search: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14ZM16.5 16.5 21 21',
  settings: 'M4 8h8M16 8h4M4 16h4M12 16h8',
  trash: 'M4 7h16M9 7V4.8h6V7M6.5 7l1 13h9l1-13M10 11v5.5M14 11v5.5',
  download: 'M12 4v10M7.5 9.5 12 14l4.5-4.5M5 20h14',
  copy: 'M9.5 9.5h8a1.5 1.5 0 0 1 1.5 1.5v8a1.5 1.5 0 0 1-1.5 1.5h-8A1.5 1.5 0 0 1 8 19v-8a1.5 1.5 0 0 1 1.5-1.5ZM5 15V5a1.5 1.5 0 0 1 1.5-1.5h10',
  send: 'M12 19V5M6 11l6-6 6 6',
  stop: 'M8 8h8v8H8z',
  chevron: 'M9.5 6.5 15 12l-5.5 5.5',
  chevronDown: 'M6.5 9.5 12 15l5.5-5.5',
  close: 'M6.5 6.5l11 11M17.5 6.5l-11 11',
  refresh: 'M20 12a8 8 0 1 1-2.6-5.9M20 4.5V10h-5.5',
  folder: 'M3.5 7.5h5.2l2 2h9.8v8.5a1.5 1.5 0 0 1-1.5 1.5H5a1.5 1.5 0 0 1-1.5-1.5V7.5Z',
  external: 'M14 4.5h5.5V10M19.5 4.5 11 13M17.5 14v5a1.5 1.5 0 0 1-1.5 1.5H5A1.5 1.5 0 0 1 3.5 19V8A1.5 1.5 0 0 1 5 6.5h5',
  check: 'M5.5 12.5 10 17l8.5-9',
  pi: 'M4.5 9h15M9 9v10M16 9v10',
  history: 'M12 4.2a7.8 7.8 0 1 0 0 15.6 7.8 7.8 0 0 0 0-15.6ZM12 8v4.3l3 1.8',
  back: 'M15 6.5 9.5 12 15 17.5',
  panel: 'M4 5.5h16v13H4zM10 5.5v13',
  paperclip: 'M15.5 7.5 9 14a2.8 2.8 0 1 0 4 4l7.2-7.2a4.5 4.5 0 1 0-6.4-6.4L6.3 12a6.2 6.2 0 1 0 8.8 8.8l6.4-6.4',
  retry: 'M4 12a8 8 0 0 1 13.7-5.6L20 8.8M20 4v4.8h-4.8M20 12a8 8 0 0 1-13.7 5.6L4 15.2M4 20v-4.8h4.8',
  terminal: 'M4.5 6.5h15a1.5 1.5 0 0 1 1.5 1.5v8a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 16V8a1.5 1.5 0 0 1 1.5-1.5ZM7.5 10l2.5 2-2.5 2M12.5 14h4',
}
</script>

<template>
  <svg
    class="ico" :width="size" :height="size" viewBox="0 0 24 24"
    fill="none" :stroke-width="stroke" stroke="currentColor"
    stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"
  >
    <path :d="PATHS[name] || ''" />
  </svg>
</template>

<style scoped>
.ico { display: block; flex: none; }
</style>
