<script setup>
// 设置 -> 操作记录（本地脱敏 JSONL 审计）
import { ref, computed, onMounted } from 'vue'
import { useConfirm } from '../composables/useConfirm.js'
import Icon from './Icon.vue'

const emit = defineEmits(['notify', 'openPath'])

const auditRows = ref([])
const auditRiskOnly = ref(false)
const { isConfirming, confirm } = useConfirm()

function loadAudit() {
  try {
    auditRows.value = (window.piBridge && window.piBridge.auditTail) ? (window.piBridge.auditTail(200) || []) : []
  } catch (_) { auditRows.value = [] }
}

const auditVisible = computed(() =>
  auditRiskOnly.value
    ? auditRows.value.filter(r => r.risk || r.type === 'perm' || r.type === 'data')
    : auditRows.value)

const auditStats = computed(() => {
  let writes = 0, execs = 0
  for (const r of auditRows.value) {
    if (r.type !== 'tool' || !r.tool) continue
    if (r.tool.name === 'edit' || r.tool.name === 'write') writes++
    if (r.tool.name === 'bash' || r.tool.name === 'powershell') execs++
  }
  return { writes, execs }
})

function fmtAuditTime(ts) {
  if (!ts) return ''
  const d = new Date(ts)
  const p = n => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}
function auditKind(r) {
  if (r.type === 'tool') return (r.tool && r.tool.name) || 'tool'
  if (r.type === 'run') return '对话'
  if (r.type === 'perm') return '权限'
  if (r.type === 'data') return '数据'
  if (r.type === 'config') return '配置'
  return r.type || ''
}
function isAuditRisk(r) {
  return !!(r.risk || r.type === 'perm' || r.type === 'data')
}

function exportAudit() {
  if (!window.piBridge || !window.piBridge.auditExport) return
  const md = window.piBridge.auditExport(30)
  const r = window.piBridge.saveTextFile && window.piBridge.saveTextFile('PiDeck-操作记录.md', md)
  if (r && r.ok) emit('notify', '已导出：' + r.path)
  else if (r && r.canceled) return
  else emit('notify', '导出失败')
}

function openAuditDir() {
  const dir = window.piBridge && window.piBridge.auditDir && window.piBridge.auditDir()
  if (dir) emit('openPath', dir)
  else emit('notify', '当前环境无法打开记录目录')
}

function clearAudit() {
  confirm('clearAudit', () => {
    const r = window.piBridge && window.piBridge.auditClear ? window.piBridge.auditClear() : null
    loadAudit()
    if (r && r.failed) emit('notify', `清空完成，${r.failed} 个文件未能删除`)
    else emit('notify', '操作记录已清空')
  })
}

onMounted(loadAudit)
</script>

<template>
  <div class="pane">
    <div class="audit-summary">
      <span>最近 {{ auditRows.length }} 条</span>
      <span class="audit-stat risk">{{ auditStats.writes }} 次改文件</span>
      <span class="audit-stat risk">{{ auditStats.execs }} 次执行命令</span>
      <span class="spacer"></span>
      <label class="audit-filter"><input type="checkbox" v-model="auditRiskOnly" />只看风险</label>
      <button class="mini-btn" @click="loadAudit"><Icon name="refresh" :size="12" />刷新</button>
    </div>
    <div v-if="!auditVisible.length" class="audit-empty">{{ auditRows.length ? '没有符合条件的记录' : '还没有操作记录' }}</div>
    <div v-else class="audit-list">
      <div v-for="(r, i) in auditVisible" :key="i" class="audit-row" :class="{ risk: isAuditRisk(r) }">
        <span class="audit-time">{{ fmtAuditTime(r.ts) }}</span>
        <span class="audit-kind">{{ auditKind(r) }}</span>
        <span class="audit-desc">{{ r.summary }}</span>
        <span class="audit-group">{{ r.groupName || '' }}</span>
      </div>
    </div>
    <div class="audit-actions">
      <button class="mini-btn" @click="openAuditDir"><Icon name="folder" :size="12" />打开记录目录</button>
      <button class="mini-btn" @click="exportAudit"><Icon name="download" :size="12" />导出 Markdown</button>
      <button class="mini-btn danger" @click="clearAudit">{{ isConfirming('clearAudit') ? '再点一次确认清空' : '清空记录' }}</button>
    </div>
    <span class="hint">只保存在本机，不上传；不记录对话全文、完整文件内容与密钥（工具参数/结果仅保留截断摘要）。仅保留最近 30 天。</span>
  </div>
</template>

<style scoped>
.pane { display: flex; flex-direction: column; gap: 9px; }
.audit-summary { display: flex; align-items: center; gap: 10px; font-size: 11px; color: var(--ink-3); }
.audit-stat.risk { color: var(--danger); }
.audit-filter { display: inline-flex; align-items: center; gap: 4px; font-size: 11px; color: var(--ink-2); cursor: pointer; }
.audit-empty { padding: 22px 8px; text-align: center; font-size: 11.5px; color: var(--ink-3); background: var(--surface); border-radius: var(--r-sm); }
.audit-list { display: flex; flex-direction: column; max-height: 300px; overflow-y: auto; border: 1px solid var(--line); border-radius: var(--r-sm); }
.audit-row {
  display: grid; grid-template-columns: 84px 62px minmax(0, 1fr) auto; gap: 8px; align-items: baseline;
  padding: 6px 8px; font-size: 11px; color: var(--ink-2); border-top: 1px solid var(--line);
}
.audit-row:first-child { border-top: 0; }
.audit-row.risk { color: var(--ink); background: var(--danger-soft); }
.audit-time { color: var(--ink-3); font-family: var(--mono); font-size: 10.5px; }
.audit-kind { font-family: var(--mono); font-size: 10.5px; color: var(--ink-2); }
.audit-row.risk .audit-kind { color: var(--danger); }
.audit-desc { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.audit-group { color: var(--ink-3); font-size: 10.5px; max-width: 90px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.audit-actions { display: flex; flex-wrap: wrap; gap: 6px; }
</style>
