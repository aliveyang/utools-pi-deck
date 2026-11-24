<script setup>
// 经典布局：左侧栏（新建对话、分组切换、本地搜索历史、底部入口）
import { ref, toRef } from 'vue'
import { relTime } from '../sessions.js'
import { useSessionFilter } from '../composables/useSessionFilter.js'
import Icon from './Icon.vue'

const props = defineProps({
  groups: { type: Array, default: () => [] },
  activeId: { type: String, default: '' },
  sessions: { type: Array, default: () => [] },
  currentSessionId: { type: String, default: '' },
  confirmDeleteId: { type: String, default: '' },
})
const emit = defineEmits(['newChat', 'selectGroup', 'loadSession', 'requestDeleteSession', 'exportCurrent', 'openSettings', 'switchLayout'])

const searchEl = ref(null)
const { search, filteredSessions } = useSessionFilter(toRef(props, 'sessions'))

function focusSearch() {
  searchEl.value && searchEl.value.focus()
}
defineExpose({ focusSearch })
</script>

<template>
  <aside class="sidebar">
    <div class="side-head">
      <span class="side-logo"><Icon name="pi" :size="13" :stroke="1.9" /></span>
      <span class="side-brand">PiDeck</span>
    </div>
    <button class="new-chat-btn" @click="emit('newChat')"><Icon name="plus" :size="13" />新对话</button>

    <div class="side-section">
      <div class="side-label">分组</div>
      <button
        v-for="g in groups" :key="g.id" class="side-group"
        :class="{ active: g.id === activeId }" @click="emit('selectGroup', g.id)"
      >{{ g.name }}</button>
    </div>

    <div class="side-section history-section">
      <div class="side-label row">
        <span>最近对话</span>
        <button class="export-btn" title="导出当前会话" @click="emit('exportCurrent')"><Icon name="download" :size="12" /></button>
      </div>
      <label class="search-wrap">
        <Icon name="search" :size="12" class="search-ico" />
        <input ref="searchEl" v-model="search" class="session-search" placeholder="搜索会话" />
      </label>
      <div
        v-for="s in filteredSessions" :key="s.id" class="history-item"
        :class="{ active: currentSessionId === s.id }"
      >
        <span
          class="history-title" role="button" tabindex="0"
          @click="emit('loadSession', s.id)" @keydown.enter.prevent="emit('loadSession', s.id)"
        >{{ s.title }}</span>
        <span class="history-time">{{ relTime(s.updatedAt) }}</span>
        <button
          class="history-del" :class="{ confirming: confirmDeleteId === s.id }"
          :title="confirmDeleteId === s.id ? '再点一次确认删除' : '删除'"
          :aria-label="confirmDeleteId === s.id ? '确认删除会话' : '删除会话'"
          @click.stop="emit('requestDeleteSession', s.id)"
        >
          <span v-if="confirmDeleteId === s.id">确认</span><Icon v-else name="close" :size="11" />
        </button>
      </div>
      <div v-if="!filteredSessions.length" class="history-empty">{{ search ? '没有匹配的会话' : '暂无对话' }}</div>
    </div>

    <div class="side-spacer"></div>
    <div class="side-foot">
      <button class="side-settings" @click="emit('openSettings')"><Icon name="settings" :size="13" />设置</button>
      <button class="side-icon-btn" title="切换到控制台布局" @click="emit('switchLayout')"><Icon name="panel" :size="13" /></button>
    </div>
  </aside>
</template>

<style scoped>
.sidebar {
  width: 172px; flex: none; border-right: 1px solid var(--line); background: var(--surface);
  display: flex; flex-direction: column; padding: 14px 10px; gap: 14px;
}
.side-head { display: flex; align-items: center; gap: 8px; }
.side-logo {
  width: 24px; height: 24px; border-radius: 7px; background: var(--accent); color: var(--on-accent);
  display: flex; align-items: center; justify-content: center; flex: none;
}
.side-brand { font-size: 13px; font-weight: 500; }
.new-chat-btn {
  border: 1px solid var(--line-2); background: var(--paper); color: var(--ink);
  border-radius: var(--r-sm); padding: 7px 10px; font-size: 12px; text-align: left;
  display: flex; align-items: center; gap: 6px;
  transition: background .15s var(--ease), border-color .15s var(--ease), color .15s var(--ease);
}
.new-chat-btn:hover { background: var(--accent-soft); border-color: var(--accent); color: var(--accent); }
.side-section { display: flex; flex-direction: column; gap: 2px; }
.side-label { font-size: 10.5px; color: var(--ink-3); padding: 0 4px 5px; }
.side-label.row { display: flex; align-items: center; justify-content: space-between; }
.side-group {
  position: relative; text-align: left; padding: 6px 10px; border-radius: var(--r-sm);
  font-size: 12px; color: var(--ink-2); transition: background .14s var(--ease), color .14s var(--ease);
}
.side-group:hover { background: var(--surface-2); color: var(--ink); }
.side-group.active { background: var(--raised); color: var(--accent); font-weight: 500; }
.side-group.active::before {
  content: ''; position: absolute; left: 0; top: 50%; transform: translateY(-50%);
  width: 2px; height: 14px; border-radius: 2px; background: var(--accent);
}
.history-section { min-height: 0; overflow-y: auto; flex: 0 1 auto; }
.export-btn { color: var(--ink-3); padding: 3px; border-radius: 4px; display: flex; flex: none; }
.export-btn:hover { color: var(--accent); background: var(--surface-2); }
.search-wrap { position: relative; display: block; margin-bottom: 6px; }
.search-ico { position: absolute; left: 7px; top: 50%; transform: translateY(-50%); color: var(--ink-3); pointer-events: none; }
.session-search {
  width: 100%; border: 1px solid transparent; border-radius: var(--r-sm);
  padding: 5px 7px 5px 24px; font-size: 11px; background: var(--surface-2); color: var(--ink); outline: 0;
  transition: background .15s var(--ease), border-color .15s var(--ease);
}
.session-search::placeholder { color: var(--ink-3); }
.session-search:focus { border-color: var(--accent); background: var(--paper); }
.history-item {
  display: flex; align-items: center; gap: 4px; padding: 6px 6px 6px 10px;
  border-radius: var(--r-sm); font-size: 11.5px; color: var(--ink-2);
}
.history-item:hover { background: var(--surface-2); color: var(--ink); }
.history-item.active { background: var(--raised); color: var(--accent); font-weight: 500; }
.history-title { flex: 1; min-width: 0; cursor: pointer; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; outline: 0; }
.history-time { font-size: 10px; color: var(--ink-3); flex: none; }
.history-item:hover .history-time { display: none; }
.history-del {
  opacity: 0; width: 18px; height: 18px; border-radius: 4px; color: var(--ink-3);
  display: none; align-items: center; justify-content: center; flex: none;
}
.history-item:hover .history-del, .history-item:focus-within .history-del { display: flex; opacity: 1; }
.history-del:hover { color: var(--danger); background: var(--danger-soft); }
.history-del.confirming {
  display: flex; opacity: 1; width: auto; padding: 0 5px; font-size: 10px;
  color: var(--danger); background: var(--danger-soft);
}
.history-empty { font-size: 11px; color: var(--ink-3); padding: 4px 10px; }
.side-spacer { flex: 1; }
.side-foot { display: flex; align-items: center; gap: 4px; border-top: 1px solid var(--line); padding-top: 8px; }
.side-settings {
  flex: 1; padding: 4px 6px; border-radius: 4px; font-size: 12px; color: var(--ink-2);
  display: flex; align-items: center; gap: 6px; transition: color .14s var(--ease);
}
.side-settings:hover { color: var(--accent); }
.side-icon-btn {
  width: 24px; height: 24px; border-radius: 4px; color: var(--ink-3);
  display: flex; align-items: center; justify-content: center; flex: none;
}
.side-icon-btn:hover { background: var(--surface-2); color: var(--ink); }

@media (max-width: 720px) {
  .sidebar { width: 148px; padding: 12px 8px; }
}
</style>
