<script setup>
import { ref, toRef, watch, nextTick, onMounted } from 'vue'
import { relTime } from '../sessions.js'
import { useSessionFilter } from '../composables/useSessionFilter.js'
import Icon from './Icon.vue'

const props = defineProps({
  sessions: { type: Array, default: () => [] },
  currentSessionId: { type: String, default: '' },
  confirmDeleteId: { type: String, default: '' },
})
const emit = defineEmits(['close', 'select', 'requestRemove'])

const searchEl = ref(null)
const historyIndex = ref(0)
const { search, filteredSessions, groupedSessions } = useSessionFilter(toRef(props, 'sessions'))

onMounted(() => { nextTick(() => searchEl.value && searchEl.value.focus()) })
watch(search, () => { historyIndex.value = 0 })

function moveHistory(delta) {
  const n = filteredSessions.value.length
  if (!n) return
  historyIndex.value = Math.min(n - 1, Math.max(0, historyIndex.value + delta))
  nextTick(() => {
    const el = document.querySelector('.h-row.focus')
    if (el && el.scrollIntoView) el.scrollIntoView({ block: 'nearest' })
  })
}

function openHistoryActive() {
  const s = filteredSessions.value[historyIndex.value]
  if (s) emit('select', s.id)
}

function isFocusedSession(s) {
  const cur = filteredSessions.value[historyIndex.value]
  return !!(cur && cur.id === s.id)
}
</script>

<template>
  <div class="drawer-mask" @click.self="emit('close')">
    <aside class="drawer" @keydown.down.prevent="moveHistory(1)" @keydown.up.prevent="moveHistory(-1)" @keydown.enter.prevent="openHistoryActive">
      <div class="drawer-head">
        <Icon name="search" :size="13" class="drawer-search-ico" />
        <input ref="searchEl" v-model="search" class="drawer-search" placeholder="搜索会话" />
        <button class="icon-btn" @click="emit('close')" title="关闭"><Icon name="close" :size="12" /></button>
      </div>
      <div class="drawer-list">
        <template v-for="bucket in groupedSessions" :key="bucket.label">
          <div class="drawer-label">{{ bucket.label }}</div>
          <div
            v-for="s in bucket.items" :key="s.id" class="h-row" role="button" tabindex="0"
            :class="{ active: currentSessionId === s.id, focus: isFocusedSession(s) }"
            @click="emit('select', s.id)" @keydown.enter.stop.prevent="emit('select', s.id)"
          >
            <span class="h-title">{{ s.title }}</span>
            <span class="h-time">{{ relTime(s.updatedAt) }}</span>
            <button
              class="h-del" :class="{ confirming: confirmDeleteId === s.id }"
              :title="confirmDeleteId === s.id ? '再点一次确认删除' : '删除'"
              :aria-label="confirmDeleteId === s.id ? '确认删除会话' : '删除会话'"
              @click.stop="emit('requestRemove', s.id)"
            >
              <span v-if="confirmDeleteId === s.id">确认</span><Icon v-else name="close" :size="11" />
            </button>
          </div>
        </template>
        <div v-if="!filteredSessions.length" class="drawer-empty">{{ search ? '没有匹配的会话' : '还没有对话' }}</div>
      </div>
      <div class="drawer-foot">
        <span><kbd>↑</kbd><kbd>↓</kbd> 选择</span>
        <span><kbd>↵</kbd> 打开</span>
        <span><kbd>Esc</kbd> 关闭</span>
      </div>
    </aside>
  </div>
</template>

<style scoped>
.drawer-mask { position: fixed; inset: 0; z-index: 10; background: transparent; }
.drawer {
  position: fixed; top: 0; right: 0; bottom: 0; width: 336px; max-width: 88vw;
  background: var(--paper); border-left: 1px solid var(--line);
  display: flex; flex-direction: column; animation: drawer-in .16s var(--ease);
}
@keyframes drawer-in { from { transform: translateX(12px); opacity: 0 } to { transform: none; opacity: 1 } }
.drawer-head { display: flex; align-items: center; gap: 8px; padding: 10px 10px 10px 12px; border-bottom: 1px solid var(--line); }
.drawer-search-ico { color: var(--ink-3); flex: none; }
.drawer-search { flex: 1; min-width: 0; border: 0; outline: 0; background: transparent; font-size: 12.5px; padding: 2px 0; }
.drawer-search::placeholder { color: var(--ink-3); }
.drawer-list { flex: 1; min-height: 0; overflow-y: auto; padding: 6px 8px 10px; }
.drawer-label { font-size: 10.5px; color: var(--ink-3); padding: 10px 6px 4px; }
.h-row {
  display: flex; align-items: center; gap: 8px; padding: 7px 8px; border-radius: 5px;
  font-size: 12.5px; color: var(--ink-2); cursor: pointer; outline: 0;
}
.h-row:hover, .h-row.focus { background: var(--surface); }
.h-row.active { color: var(--accent); }
.h-row:focus-visible { box-shadow: inset 0 0 0 1px var(--accent); }
.h-title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.h-time { font-size: 10.5px; color: var(--ink-3); flex: none; }
.h-del {
  opacity: 0; width: 18px; height: 18px; border-radius: 4px; color: var(--ink-3);
  display: flex; align-items: center; justify-content: center; flex: none;
}
.h-row:hover .h-del, .h-row:focus-within .h-del { opacity: 1; }
.h-del:hover { color: var(--danger); background: var(--danger-soft); }
.h-del.confirming {
  opacity: 1; width: auto; padding: 0 5px; font-size: 10px;
  color: var(--danger); background: var(--danger-soft);
}
.drawer-empty { padding: 24px 8px; text-align: center; font-size: 11.5px; color: var(--ink-3); }
.drawer-foot {
  display: flex; gap: 14px; padding: 8px 12px; border-top: 1px solid var(--line);
  font-size: 10.5px; color: var(--ink-3);
}
.drawer-foot kbd {
  font-size: 10px; color: var(--ink-2); border: 1px solid var(--line-2);
  border-radius: 3px; padding: 0 3px; line-height: 14px;
}
</style>
