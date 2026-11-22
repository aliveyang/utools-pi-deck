<script setup>
// 统一图标系统：24 网格 / stroke 1.6 / 圆头圆角 / 几何化
// 用一组克制、可扫读的线条符号替代文字符号（↑ × ✕ + −）
const props = defineProps({
  name: { type: String, required: true },
  size: { type: [Number, String], default: 16 },
  stroke: { type: [Number, String], default: 1.6 },
})

const PATHS = {
  plus: 'M12 5v14M5 12h14',
  search: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14ZM16.5 16.5 21 21',
  // 滑杆式"设置"，比齿轮更轻、更现代
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
  alert: 'M12 4.5 21 20H3L12 4.5ZM12 10v4.5M12 17.2v.3',
  // π：PiDeck 的识别符号（顶横 + 双竖，腿在横线内侧才读作 π）
  pi: 'M4.5 9h15M9 9v10M16 9v10',
  history: 'M12 4.2a7.8 7.8 0 1 0 0 15.6 7.8 7.8 0 0 0 0-15.6ZM12 8v4.3l3 1.8',
  back: 'M15 6.5 9.5 12 15 17.5',
  // 布局切换：一条竖分隔，暗示"侧栏"
  panel: 'M4 5.5h16v13H4zM10 5.5v13',
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
