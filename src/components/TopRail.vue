<script setup>
// 控制台布局：顶栏分组切换 + 快捷操作
import Icon from './Icon.vue'

defineProps({
  groups: { type: Array, default: () => [] },
  activeId: { type: String, default: '' },
  historyKey: { type: String, default: 'Ctrl K' },
})
const emit = defineEmits(['selectGroup', 'newChat', 'openHistory', 'exportCurrent', 'switchLayout', 'openSettings'])
</script>

<template>
  <header class="rail">
    <span class="brand-mark"><Icon name="pi" :size="11" :stroke="2" /></span>
    <span class="brand-name">PiDeck</span>
    <nav class="rail-tabs" role="tablist">
      <button
        v-for="g in groups" :key="g.id" class="tab" role="tab"
        :class="{ active: g.id === activeId }" :aria-selected="g.id === activeId"
        @click="emit('selectGroup', g.id)"
      >{{ g.name }}</button>
    </nav>
    <div class="rail-actions">
      <button class="rail-btn" @click="emit('newChat')" title="新对话">
        <Icon name="plus" :size="13" /><span class="rb-label">新对话</span>
      </button>
      <button class="rail-btn" @click="emit('openHistory')" title="历史对话">
        <Icon name="history" :size="13" /><span class="rb-label">历史</span><kbd class="rb-kbd">{{ historyKey }}</kbd>
      </button>
      <button class="rail-btn icon-only" @click="emit('exportCurrent')" title="导出当前会话"><Icon name="download" :size="13" /></button>
      <button class="rail-btn icon-only" title="切换到经典布局" @click="emit('switchLayout')"><Icon name="panel" :size="13" /></button>
      <button class="rail-btn icon-only" @click="emit('openSettings')" title="设置"><Icon name="settings" :size="14" /></button>
    </div>
  </header>
</template>

<style scoped>
.rail {
  flex: none; height: 40px; display: flex; align-items: center; gap: 8px;
  padding: 0 12px; border-bottom: 1px solid var(--line);
}
.brand-mark {
  width: 18px; height: 18px; border-radius: 5px; background: var(--accent); color: var(--on-accent);
  display: flex; align-items: center; justify-content: center; flex: none;
}
.brand-name { font-size: 11.5px; font-weight: 500; letter-spacing: .01em; padding-right: 4px; }
.rail-tabs { display: flex; align-items: stretch; gap: 1px; overflow-x: auto; scrollbar-width: none; }
.rail-tabs::-webkit-scrollbar { display: none; }
.rail-actions { display: flex; align-items: center; gap: 1px; margin-left: auto; }
.rail-btn {
  height: 26px; padding: 0 7px; border-radius: var(--r-sm); display: inline-flex; align-items: center; gap: 5px;
  font-size: 11.5px; color: var(--ink-2); transition: background .14s var(--ease), color .14s var(--ease);
}
.rail-btn:hover { background: var(--surface-2); color: var(--ink); }
.rail-btn.icon-only { padding: 0 6px; }
.rb-kbd {
  font-size: 10.5px; color: var(--ink-3); border: 1px solid var(--line-2);
  border-radius: 4px; padding: 0 3px; line-height: 14px;
}
.rail-btn:hover .rb-kbd { color: var(--ink-2); }

@media (max-width: 720px) {
  .brand-name, .rb-label, .rb-kbd { display: none; }
  .rail { gap: 4px; }
  .rail-actions { gap: 0; }
}
</style>
