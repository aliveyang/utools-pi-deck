<script setup>
import { ref, computed, watch, nextTick } from 'vue'
import { relTime } from '../sessions.js'
import Icon from './Icon.vue'

const props = defineProps({
  show: { type: Boolean, default: false },
  sessions: { type: Array, default: () => [] },
  currentSessionId: { type: String, default: '' },
})
const emit = defineEmits(['close', 'select', 'remove'])

const searchEl = ref(null)
const sessionSearch = ref('')
const historyIndex = ref(0)

watch(() => props.show, val => {
  if (!val) return
  sessionSearch.value = ''
  historyIndex.value = 0
  nextTick(() => searchEl.value && searchEl.value.focus())
})
watch(sessionSearch, () => { historyIndex.value = 0 })

const filteredSessions = computed(() => {
  const q = sessionSearch.value.toLowerCase()
  return q ? props.sessions.filter(s => (s.title || '').toLowerCase().includes(q)) : props.sessions
})

const groupedSessions = computed(() => {
  const list = filteredSessions.value
  const now = new Date()
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const buckets = [
    { label: '今天', items: [] },
    { label: '昨天', items: [] },
    { label: '更早', items: [] },
  ]
  for (const s of list) {
    const t = s.updatedAt || 0
    if (t >= startOfToday) buckets[0].items.push(s)
    else if (t >= startOfToday - 86400000) buckets[1].items.push(s)
    else buckets[2].items.push(s)
  }
  return buckets.filter(b => b.items.length)
})

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
  <div v-if="show" class="drawer-mask" @click.self="emit('close')">
    <aside class="drawer" @keydown.down.prevent="moveHistory(1)" @keydown.up.prevent="moveHistory(-1)" @keydown.enter.prevent="openHistoryActive">
      <div class="drawer-head">
        <Icon name="search" :size="13" class="drawer-search-ico" />
        <input ref="searchEl" v-model="sessionSearch" class="drawer-search" placeholder="搜索会话" />
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
            <button class="h-del" title="删除" aria-label="删除会话" @click.stop="emit('remove', s.id)"><Icon name="close" :size="11" /></button>
          </div>
        </template>
        <div v-if="!filteredSessions.length" class="drawer-empty">{{ sessionSearch ? '没有匹配的会话' : '还没有对话' }}</div>
      </div>
      <div class="drawer-foot">
        <span><kbd>↑</kbd><kbd>↓</kbd> 选择</span>
        <span><kbd>↵</kbd> 打开</span>
        <span><kbd>Esc</kbd> 关闭</span>
      </div>
    </aside>
  </div>
</template>
