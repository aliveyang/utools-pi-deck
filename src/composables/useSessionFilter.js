// 共享会话搜索与时间分组（Sidebar 与 HistoryDrawer 共用）
import { ref, computed } from 'vue'

export function useSessionFilter(sessionsRef) {
  const search = ref('')

  const filteredSessions = computed(() => {
    const list = sessionsRef.value || []
    const q = search.value.trim().toLowerCase()
    return q ? list.filter(s => (s.title || '').toLowerCase().includes(q)) : list
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

  return { search, filteredSessions, groupedSessions }
}
