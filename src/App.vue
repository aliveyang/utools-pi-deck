<script setup>
import { ref, computed, onMounted, onUnmounted, nextTick, watch } from 'vue'
import { loadGroups, saveGroups, loadActiveId, saveActiveId, loadDrafts, saveDrafts, newGroup, PRESET_LIST, PRESET_LABEL, TOOL_PRESETS, TOOL_NAMES, presetOf } from './groups.js'
import { readCache, read, write } from './storage.js'
import Icon from './components/Icon.vue'
import TurnList from './components/TurnList.vue'
import {
  listSessions, getSession, createSession, updateSession, deleteSession,
  titleFromText, exportMarkdown,
} from './sessions.js'
import { useToast } from './composables/useToast.js'
import { usePrefs } from './composables/usePrefs.js'
import { usePiEnv } from './composables/usePiEnv.js'

const groups = ref(loadGroups())
const activeId = ref(loadActiveId())
const activeGroup = computed(() => groups.value.find(g => g.id === activeId.value) || groups.value[0])

const sessions = ref([])
const currentSession = ref(null)
const messages = computed(() => currentSession.value ? currentSession.value.messages : [])
// 长会话分页渲染：只挂载最近若干条，避免数百条消息的 DOM 拖慢滚动
const PAGE_SIZE = 60
const visibleCount = ref(PAGE_SIZE)
const hiddenCount = computed(() => Math.max(0, messages.value.length - visibleCount.value))
const visibleMessages = computed(() =>
  hiddenCount.value ? messages.value.slice(-visibleCount.value) : messages.value)
function showEarlier() {
  const el = chatEl.value
  const prevHeight = el ? el.scrollHeight : 0
  visibleCount.value += PAGE_SIZE
  // 保持视觉位置：加载后把滚动位置下移新增高度
  nextTick(() => { if (el) el.scrollTop += el.scrollHeight - prevHeight })
}
function resetPaging() { visibleCount.value = PAGE_SIZE }

const inputText = ref('')
const images = ref([])
const attachedFiles = ref([])
const running = ref(false)
const runPhase = ref('')        // spawning | connecting | generating
const errorMsg = ref('')
const showSettings = ref(false)
const settingsTab = ref('general')
const chatEl = ref(null)
const inputEl = ref(null)
const sideSearchEl = ref(null)
const previewImage = ref('')
function showPreview(src) { if (src) previewImage.value = src }
function closePreview() { previewImage.value = '' }

// 历史滑出面板
const showHistory = ref(false)
const historySearchEl = ref(null)
const historyIndex = ref(0)
const sessionSearch = ref('')

// 输入候选菜单（技能 / 文件）
const showSkillMenu = ref(false)
const skillFilter = ref('')
const files = ref([])
const showFileMenu = ref(false)
const fileFilter = ref('')
const menuIndex = ref(0)

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || '')
const historyKey = isMac ? '⌘K' : 'Ctrl K'

// ---- 组合式模块 ----
const { toast, showToast, copyText } = useToast()
const {
  defaultCwd, setDefaultCwd, commitDefaultCwd, pickDefaultCwd,
  sendKeyMode, setSendKeyMode, displayCwd, fmtSize,
  layout, setLayout, toggleLayout,
} = usePrefs({ showToast, onCwdChange: () => detectContext() })
const {
  models, skills, piStatus, engine, rpcStatus, contextFiles, defaults, envInfo, showEnvHelp,
  loadDefaults, detectContext, loadModelsAsync, refreshModels, loadSkillsAsync,
  loadEnv, recheckEnv, prewarmActive, setEngine, openPath, openExternal, ctxLabel,
} = usePiEnv({
  getCwd: () => activeGroup.value && activeGroup.value.cwd,
  // 预热进程按分组的工具权限区分（不同配置不能复用同一进程）
  getLean: () => ({ tool: toolForSend(activeGroup.value) }),
  showToast,
})

const sendKeyChip = computed(() => sendKeyMode.value === 'enter' ? 'Enter' : 'Ctrl+↵')
function toggleSendKey() {
  setSendKeyMode(sendKeyMode.value === 'enter' ? 'ctrl' : 'enter')
}

// 空态：按分组给一句定位 + 三条可直接点的示例
const EMPTY_COPY = {
  chat: { desc: '纯文本对话，不带工具和项目规范', chips: ['解释这段代码', '给这个函数起个名字', '把这段话写得更简洁'] },
  translate: { desc: '把内容翻译成目标语言，只输出译文', chips: ['把上面的话翻译成英文', '这段英文翻译成中文', '润色成地道的英文'] },
  agent: { desc: '带工具的完整智能体，可读写文件、执行命令', chips: ['看看这个项目的结构', '帮我定位这个报错', '写个脚本整理下载目录'] },
}
const emptyCopy = computed(() => {
  const g = activeGroup.value || {}
  const base = EMPTY_COPY[g.kind] || EMPTY_COPY.chat
  if (g.kind === 'translate' && g.targetLang) {
    return { desc: `把内容翻译成${g.targetLang}，只输出译文`, chips: base.chips }
  }
  return base
})
function fillChip(text) {
  inputText.value = text
  nextTick(() => inputEl.value && inputEl.value.focus())
}

const modelReadout = computed(() => {
  const g = activeGroup.value || {}
  if (g.model) return String(g.model).split('/').pop()
  const raw = (defaults.value && (defaults.value.modelName || defaults.value.modelId)) || ''
  return raw ? String(raw).split('·')[0].trim() : '默认模型'
})
const thinkReadout = computed(() => {
  const g = activeGroup.value || {}
  if (g.thinking) return THINKING_LABELS[g.thinking] || g.thinking
  const lv = (defaults.value || {}).thinkingLevel
  return lv ? (THINKING_LABELS[lv] || lv) : '默认思考'
})

const menuItems = computed(() =>
  showSkillMenu.value ? filteredSkills.value : showFileMenu.value ? filteredFiles.value : [])

function onComposerKeydown(e) {
  // 输入法组合中（中文拼音选词）按 Enter 是确认候选，不能当发送
  if (e.isComposing || e.keyCode === 229) return
  // 候选菜单优先接管方向键与确认键
  if (showSkillMenu.value || showFileMenu.value) {
    if (e.key === 'ArrowDown') { e.preventDefault(); moveMenu(1); return }
    if (e.key === 'ArrowUp') { e.preventDefault(); moveMenu(-1); return }
    if (e.key === 'Escape') { e.preventDefault(); closeMenus(); return }
    if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
      const item = menuItems.value[menuIndex.value]
      if (item) {
        e.preventDefault()
        if (showSkillMenu.value) insertSkill(item)
        else insertFile(item)
        return
      }
    }
  }
  const isCtrl = e.ctrlKey || e.metaKey
  if (sendKeyMode.value === 'enter') {
    // Enter 发送，Shift+Enter 换行
    if (e.key === 'Enter' && !e.shiftKey && !isCtrl) { e.preventDefault(); send() }
  } else {
    if (e.key === 'Enter' && isCtrl) { e.preventDefault(); send() }
  }
}
function moveMenu(delta) {
  const n = menuItems.value.length
  if (!n) return
  menuIndex.value = Math.min(n - 1, Math.max(0, menuIndex.value + delta))
  nextTick(() => {
    const el = document.querySelector('.suggest-item.active')
    if (el && el.scrollIntoView) el.scrollIntoView({ block: 'nearest' })
  })
}
function closeMenus() {
  showSkillMenu.value = false
  showFileMenu.value = false
}

let currentAssistant = null
let runHandle = null
let cancelled = false
let finalized = false
let scrollScheduled = false

// 统一终态收口（幂等）：onDone / onError / cancel 都走这里，避免空指针与重复 persist
function finalize(aborted, error) {
  if (finalized) return
  finalized = true
  if (currentAssistant) {
    if (aborted) currentAssistant.aborted = true
    else if (error) currentAssistant.error = error
  } else if (error) {
    errorMsg.value = error
  }
  running.value = false
  runPhase.value = ''
  currentAssistant = null
  runHandle = null
  persistCurrent()
  refreshSessionsKeep()
  scrollChat()
}

function onEsc() {
  if (previewImage.value) { closePreview(); return }
  if (showSkillMenu.value || showFileMenu.value) { closeMenus(); return }
  if (showHistory.value) { closeHistory(); return }
  if (editing.value) { editing.value = null; return }
  if (showSettings.value) { closeSettings(); return }
}

const TARGET_LANGS = ['', '英文', '中文', '日文', '韩文', '法文', '德文', '西班牙文', '俄文']
const THINKING_LEVELS = ['', 'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
const THINKING_LABELS = {
  off: '不思考', minimal: '极简', low: '低', medium: '中', high: '高', xhigh: '极高', max: '最高',
}
function thinkingLabel(lv) {
  if (!lv) return defaultThinkingLabel()
  return THINKING_LABELS[lv] ? `${THINKING_LABELS[lv]}（${lv}）` : lv
}

const filteredSkills = computed(() => {
  const q = skillFilter.value.toLowerCase()
  return q ? skills.value.filter(s => s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q)) : skills.value
})
const filteredFiles = computed(() => {
  const q = fileFilter.value.toLowerCase()
  return q ? files.value.filter(f => f.path.toLowerCase().includes(q)).slice(0, 40) : files.value.slice(0, 40)
})
const filteredSessions = computed(() => {
  const q = sessionSearch.value.toLowerCase()
  return q ? sessions.value.filter(s => (s.title || '').toLowerCase().includes(q)) : sessions.value
})

function onEnterEvent(e) {
  const q = window.__pideckEnterQueue
  const i = q ? q.indexOf(e.detail) : -1
  if (i >= 0) q.splice(i, 1)
  handleEnter(e.detail || e)
}

onMounted(async () => {
  // T0 输入层：只做同步必需项，保证 <100ms 可输入
  models.value = readCache('models') || []
  skills.value = readCache('skills') || []
  piStatus.value = null
  refreshSessions()
  restoreDraft()
  noticePermOnce()
  window.addEventListener('pideck:enter', onEnterEvent)
  // 早于本组件挂载的进入事件由 preload 缓存在这里，补放一次
  const queued = window.__pideckEnterQueue || []
  while (queued.length) onEnterEvent({ detail: queued[0] })
  // 随用即走：关窗时立即强制存草稿，不依赖 500ms 防抖
  window.utools && window.utools.onPluginOut && window.utools.onPluginOut(() => {
    clearTimeout(draftTimer)
    saveCurrentDraft()
  })
  nextTick(() => inputEl.value && inputEl.value.focus())
  // 读取运行引擎配置
  if (window.piBridge && window.piBridge.getConfig) {
    engine.value = (window.piBridge.getConfig() || {}).engine || 'json'
  }
  window.addEventListener('keydown', onGlobalKey)
  // T1/T2 后台：延迟到输入就绪后异步刷新，不阻塞首屏
  setTimeout(() => {
    loadModelsAsync()
    loadSkillsAsync()
    if (window.piBridge && window.piBridge.resolvePi) piStatus.value = window.piBridge.resolvePi()
    // 打开时后台预热 RPC 长驻进程（配置启用时）
    if (engine.value === 'rpc' && window.piBridge && window.piBridge.prewarmRpc) {
      rpcStatus.value = 'warming'
      prewarmActive().then(ok => {
        rpcStatus.value = ok ? 'ready' : 'failed'
      })
    }
    detectContext()
    loadDefaults()
    loadEnv()
  }, 200)
})

onUnmounted(() => {
  window.removeEventListener('keydown', onGlobalKey)
  window.removeEventListener('pideck:enter', onEnterEvent)
})

function onGlobalKey(e) {
  if (e.key === 'Escape') { onEsc(); return }
  const mod = e.ctrlKey || e.metaKey
  if (!mod) return
  if (e.key === 'k' || e.key === 'K') {
    e.preventDefault()
    // 经典布局没有滑出面板：直接聚焦侧栏搜索
    if (layout.value === 'classic') { sideSearchEl.value && sideSearchEl.value.focus(); return }
    if (showHistory.value) closeHistory()
    else openHistory()
    return
  }
  if (/^[1-9]$/.test(e.key)) {
    const g = groups.value[Number(e.key) - 1]
    if (g) { e.preventDefault(); selectGroup(g.id) }
  }
}

// ---- 历史面板 ----
function openHistory() {
  if (!sessions.value.length) { showToast('还没有对话'); return }
  showHistory.value = true
  sessionSearch.value = ''
  historyIndex.value = 0
  nextTick(() => historySearchEl.value && historySearchEl.value.focus())
}
function closeHistory() { showHistory.value = false }
watch(sessionSearch, () => { historyIndex.value = 0 })

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
function relTime(ts) {
  if (!ts) return ''
  const diff = Date.now() - ts
  if (diff < 60000) return '刚刚'
  if (diff < 3600000) return `${Math.floor(diff / 60000)} 分钟前`
  const now = new Date(), t = new Date(ts)
  if (now.toDateString() === t.toDateString()) return `${Math.floor(diff / 3600000)} 小时前`
  const y = new Date(now.getTime() - 86400000)
  if (y.toDateString() === t.toDateString()) return '昨天'
  return `${t.getMonth() + 1} 月 ${t.getDate()} 日`
}
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
  if (s) loadSession(s.id)
}
function isFocusedSession(s) {
  const cur = filteredSessions.value[historyIndex.value]
  return !!(cur && cur.id === s.id)
}

const INSTALL_CMDS = {
  pi: 'npm i -g @earendil-works/pi-coding-agent',
}
function installCmd(kind) { return INSTALL_CMDS[kind] || '' }
function copyCmd(text) { copyText(text) }
// 外链统一走系统浏览器（uTools 内 target=_blank 常被拦）
function openLink(url) { openExternal(url) }

function refreshFiles() {
  if (!window.piBridge || !window.piBridge.listFiles) return
  try { files.value = window.piBridge.listFiles(activeGroup.value && activeGroup.value.cwd) || [] } catch (_) { files.value = [] }
}
function refreshSessions() {
  // 每次打开默认新建对话（不续接上次），历史仍可点开
  sessions.value = listSessions(activeId.value)
  currentSession.value = null
}

function handleEnter(action) {
  const code = String(action.code || '')
  const type = String(action.type || '')
  const payload = action.payload
  // uTools 窗口复用，重新进入不会重新 mount：这里必须显式回到新对话态
  // 否则上次会话（含图片消息）还挂在 currentSession 上，看起来像没换对话
  if (!running.value) { refreshSessions(); resetPaging(); closeHistory() }
  inputText.value = ''
  const drafts = loadDrafts(); drafts[activeId.value] = ''; saveDrafts(drafts)
  errorMsg.value = ''
  closePreview()
  images.value = []
  attachedFiles.value = []
  if (code === 'translate') {
    const t = groups.value.find(g => g.kind === 'translate' || g.id === 'translate' || g.name === '翻译')
    if (t) selectGroup(t.id)
    else showToast('未找到翻译分组，请在设置中创建')
  } else if (code === 'chat') {
    const t = groups.value.find(g => g.kind === 'chat' || g.id === 'chat')
    if (t) selectGroup(t.id)
  } else if (code === 'agent') {
    const t = groups.value.find(g => g.kind === 'agent' || g.id === 'agent')
    if (t) selectGroup(t.id)
  }
  if ((type === 'over' || type === 'regex' || type === 'text') && typeof payload === 'string') inputText.value = payload
  if (type === 'img' && payload) {
    const dataUrl = typeof payload === 'string'
      ? (payload.startsWith('data:') ? payload : payload.startsWith('file:') || /^[A-Za-z]:[\\/]/.test(payload) ? '' : 'data:image/png;base64,' + payload)
      : (payload.dataUrl || (payload.base64 ? 'data:image/png;base64,' + payload.base64 : ''))
    if (dataUrl) addImage(dataUrl)
    else if (typeof payload === 'string' && payload) attachedFiles.value.push(payload)
  }
  if (type === 'files' && Array.isArray(payload)) attachedFiles.value = payload.map(p => p.path || p).filter(Boolean)
  nextTick(() => inputEl.value && inputEl.value.focus())
}

function selectGroup(id) {
  if (running.value || id === activeId.value) {
    if (running.value && id !== activeId.value) showToast('先停止当前回答再切换分组')
    return
  }
  saveCurrentDraft()          // 先用【旧 id】保存当前草稿
  activeId.value = id         // 再切换
  loadSkillsAsync()           // 异步，不阻塞切换
  files.value = []            // @ 文件改为懒加载，清空旧的
  refreshSessions()
  restoreDraft()              // 最后恢复【新 id】的草稿
}
// activeId 持久化统一由 watch 处理，避免重复写
watch(activeId, id => saveActiveId(id))

// 草稿节流持久化
let draftTimer = null
watch(inputText, () => {
  clearTimeout(draftTimer)
  draftTimer = setTimeout(saveCurrentDraft, 500)
})
function saveCurrentDraft() {
  const d = loadDrafts()
  d[activeId.value] = inputText.value || ''
  saveDrafts(d)
}
function restoreDraft() {
  const d = loadDrafts()
  inputText.value = d[activeId.value] || ''
}

// 会话操作
function loadSession(id) {
  if (running.value) return
  const s = getSession(id)
  if (!s) return
  currentSession.value = s
  errorMsg.value = ''
  resetPaging()
  closeHistory()
  nextTick(() => scrollChat(true))
}
function snapshotConfig(g) {
  return {
    prompt: g.prompt || '', model: g.model || '', thinking: g.thinking || '',
    cwd: g.cwd || defaultCwd.value || '', targetLang: g.targetLang || '', lean: { ...(g.lean || {}) },
    tool: toolForSend(g),
  }
}
function newChat() {
  if (running.value) return
  saveCurrentDraft()
  const s = createSession(activeId.value, snapshotConfig(activeGroup.value))
  currentSession.value = s
  sessions.value = listSessions(activeId.value)
  resetPaging()
  inputText.value = ''
  images.value = []
  attachedFiles.value = []
  errorMsg.value = ''
  closeHistory()
  nextTick(() => inputEl.value && inputEl.value.focus())
}
function removeSession(id) {
  const s = getSession(id)
  if (!s) return
  deleteSession(id)
  // 同步删除 pi 侧会话文件，避免在 ~/.pi/agent/sessions 下堆积
  if (s.piSessionId && window.piBridge && window.piBridge.deletePiSession) {
    try { window.piBridge.deletePiSession(s.piSessionId) } catch (_) {}
  }
  sessions.value = listSessions(activeId.value)
  if (currentSession.value && currentSession.value.id === id) {
    currentSession.value = sessions.value.length ? getSession(sessions.value[0].id) : null
  }
  if (!sessions.value.length) closeHistory()
}
function exportCurrent() {
  if (!currentSession.value) return showToast('没有可导出的会话')
  const md = exportMarkdown(currentSession.value)
  const name = `${(currentSession.value.title || 'session').replace(/[\\/:*?"<>|]/g, '_')}.md`
  // 优先走 uTools 原生保存（Electron 下 a[download] 行为不可靠）
  if (window.piBridge && window.piBridge.saveTextFile) {
    const r = window.piBridge.saveTextFile(name, md)
    if (r && r.ok) return showToast('已保存：' + r.path)
    if (r && r.canceled) return
    if (r && !r.unsupported) return showToast('保存失败：' + (r.error || '未知错误'))
  }
  // 降级：浏览器 Blob 下载
  const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url; a.download = name
  a.click()
  URL.revokeObjectURL(url)
  showToast('已导出 Markdown')
}

// 输入
// 同一张图可能被 uTools 预置 + 手动粘贴各加一次，按 dataUrl 去重
function addImage(dataUrl) {
  if (!dataUrl || images.value.some(i => i.dataUrl === dataUrl)) return
  images.value.push({ name: 'pasted-image', dataUrl })
}
let pendingImageReads = []
function onPaste(e) {
  const items = e.clipboardData && e.clipboardData.items
  if (!items) return
  for (const it of items) {
    if (it.type && it.type.startsWith('image/')) {
      const file = it.getAsFile()
      if (file) readImageFile(file)
    }
  }
}
function readImageFile(file) {
  const MAX = 20 * 1024 * 1024
  if (file.size > MAX) { showToast(`图片过大（${(file.size / 1048576).toFixed(1)}MB），上限 20MB`); return }
  // FileReader 异步：粘贴后立刻发送必须等读完成，否则这一轮发出去的是空图
  const read = new Promise(resolve => {
    const reader = new FileReader()
    reader.onload = () => { addImage(reader.result); resolve() }
    reader.onerror = () => { showToast('图片读取失败'); resolve() }
    reader.readAsDataURL(file)
  })
  pendingImageReads.push(read)
  read.finally(() => { pendingImageReads = pendingImageReads.filter(p => p !== read) })
}
function removeImage(i) { images.value.splice(i, 1) }
function removeFile(i) { attachedFiles.value.splice(i, 1) }

function onInput(e) {
  const before = inputText.value.slice(0, e.target.selectionStart)
  const skillM = /(?:^|[\s(（])\/([a-zA-Z0-9-]*)$/.exec(before)
  const fileM = /(?:^|[\s(（])@([^\s]*)$/.exec(before)
  if (skillM) {
    showSkillMenu.value = true; showFileMenu.value = false
    skillFilter.value = skillM[1]; menuIndex.value = 0
  } else if (fileM) {
    showFileMenu.value = true; showSkillMenu.value = false
    fileFilter.value = fileM[1]; menuIndex.value = 0
    if (!files.value.length) refreshFiles()   // 懒加载：首次输入 @ 才扫描工作区
  } else { closeMenus() }
}
function insertSkill(skill) {
  const el = inputEl.value
  const v = inputText.value
  const caret = el ? el.selectionStart : v.length
  const before = v.slice(0, caret), after = v.slice(caret)
  const m = /(?:^|[\s(（])\/[a-zA-Z0-9-]*$/.exec(before)
  const start = m ? before.indexOf('/', m.index) : caret
  const prefix = (m && /[\s(（]/.test(before[m.index])) ? before.slice(0, m.index + 1) : before.slice(0, start)
  inputText.value = `${prefix}/skill:${skill.name} ${after}`
  closeMenus(); skillFilter.value = ''
  const pos = (prefix + `/skill:${skill.name} `).length
  nextTick(() => { el.focus(); el.selectionStart = el.selectionEnd = pos })
}
function insertFile(f) {
  const el = inputEl.value
  const v = inputText.value
  const caret = el ? el.selectionStart : v.length
  const before = v.slice(0, caret), after = v.slice(caret)
  const m = /(?:^|[\s(（])@[^\s]*$/.exec(before)
  const start = m ? before.indexOf('@', m.index) : caret
  const prefix = (m && /[\s(（]/.test(before[m.index])) ? before.slice(0, m.index + 1) : before.slice(0, start)
  const token = `@${f.path} `
  inputText.value = `${prefix}${token}${after}`
  closeMenus(); fileFilter.value = ''
  const pos = (prefix + token).length
  nextTick(() => { el.focus(); el.selectionStart = el.selectionEnd = pos })
}

// 调用 pi
let sending = false
async function send() {
  if (running.value || sending) return
  if (pendingImageReads.length) {
    sending = true
    try { await Promise.all(pendingImageReads) } finally { sending = false }
    if (running.value) return
  }
  if (!inputText.value.trim() && !images.value.length && !attachedFiles.value.length) return
  if (!window.piBridge || !window.piBridge.run) {
    errorMsg.value = 'preload 桥未加载，需在 uTools 中运行'
    return
  }
  const userText = inputText.value.trim()
  // newChat() 会清空输入框和附件：先快照，否则首条消息（无会话时）的图片会被清掉
  const outImages = [...images.value]
  const outFiles = [...attachedFiles.value]
  if (!currentSession.value || currentSession.value.groupId !== activeId.value) newChat()
  const session = currentSession.value
  // 始终使用分组当前配置：用户改模型/思考后应立刻对新消息生效
  // （历史消息已落库不受影响；会话仍用自身 piSessionId 续接上下文）
  const g = snapshotConfig(activeGroup.value)
  updateSession(session.id, { config: { ...g } })

  let files = [...outFiles]
  const imagePaths = []
  for (const img of outImages) {
    try { const p = window.piBridge.saveImage(img.dataUrl); imagePaths.push(p); files.push(p) }
    catch (e) { errorMsg.value = String(e.message || e); return }
  }
  // 提示词：分组前缀 + 翻译目标语言 + 用户输入
  let prefix = (g.prompt && g.prompt.trim()) ? g.prompt.trim() : ''
  if (g.targetLang && g.targetLang.trim()) prefix += `\n目标语言：${g.targetLang.trim()}`
  const prompt = prefix
    ? `${prefix}\n\n---\n\n${userText || '请处理上方附带的内容。'}`
    : (userText || '请描述这张图片。')

  // 只存图片数量引用，不存 base64（避免存储膨胀）
  const imageRefs = outImages.length ? { imageCount: outImages.length, imagePaths } : {}
  session.messages.push({ role: 'user', text: userText || '(图片)', ...imageRefs })
  if (session.title === '新对话') session.title = titleFromText(userText || '(图片)')
  currentAssistant = { role: 'assistant', text: '', thinking: '', tools: [], error: '', aborted: false }
  session.messages.push(currentAssistant)
  updateSession(session.id, { messages: session.messages, title: session.title })

  inputText.value = ''
  images.value = []
  attachedFiles.value = []
  errorMsg.value = ''
  closeMenus()
  const d = loadDrafts(); d[activeId.value] = ''; saveDrafts(d)
  cancelled = false
  finalized = false
  running.value = true
  runPhase.value = 'spawning'
  scrollChat(true)
  // 发送后保持输入焦点，便于连续对话
  nextTick(() => inputEl.value && inputEl.value.focus())

  try {
    runHandle = window.piBridge.run(
      {
        prompt, model: g.model || '', thinking: g.thinking || '', cwd: g.cwd || '', files,
        sessionId: session.piSessionId,
        tool: g.tool,
        ...(g.lean || {}),
      },
      {
        onEvent: rec => {
          if (rec.type === 'agent_start' || rec.type === 'turn_start') {
            if (runPhase.value === 'spawning') runPhase.value = 'connecting'
          }
        },
        onText: delta => { runPhase.value = 'generating'; currentAssistant.text += delta; scrollChatThrottled() },
        onThinking: delta => { if (runPhase.value !== 'generating') runPhase.value = 'generating'; currentAssistant.thinking += delta },
        onTool: (phase, name, payload, id) => {
          if (phase === 'start') currentAssistant.tools.push({ id: id || ('t' + Date.now() + Math.random()), name, args: payload, expanded: false })
          else {
            const t = id ? currentAssistant.tools.find(x => x.id === id && !x.result) : [...currentAssistant.tools].reverse().find(x => x.name === name && !x.result)
            if (t) t.result = payload
          }
        },
        onUsage: usage => { session.usage = usage },
        onDone: payload => finalize(!!(payload && payload.aborted), ''),
        onError: msg => finalize(cancelled, cancelled ? '' : msg),
      }
    )
  } catch (e) {
    finalize(false, String(e.message || e))
  }
}

function persistCurrent() {
  if (currentSession.value) updateSession(currentSession.value.id, { messages: currentSession.value.messages, usage: currentSession.value.usage })
}
function refreshSessionsKeep() {
  const id = currentSession.value && currentSession.value.id
  sessions.value = listSessions(activeId.value)
  if (id) {
    const fresh = getSession(id)
    if (fresh) currentSession.value = fresh
  }
}
function cancel() {
  cancelled = true
  // 先 finalize（此时 currentAssistant 仍在，能正确标记 aborted），再 kill 子进程
  finalize(true, '')
  if (runHandle && runHandle.cancel) { try { runHandle.cancel() } catch (_) {} }
  else if (window.piBridge && window.piBridge.cancel) window.piBridge.cancel()
  showToast('已停止')
}
function scrollChat(force) {
  nextTick(() => {
    const el = chatEl.value
    if (!el) return
    // 用户上滑查看历史时不强制拽回底部（除非明确要求）
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80
    if (force || nearBottom) el.scrollTop = el.scrollHeight
  })
}
function scrollChatThrottled() {
  if (scrollScheduled) return
  scrollScheduled = true
  requestAnimationFrame(() => { scrollScheduled = false; scrollChat(false) })
}
// 折叠件：未手动操作时，最后一条在生成中自动展开
function usageText(session) {
  const u = session && session.usage
  if (!u || !u.totalTokens) return ''
  const c = u.cost && Number(u.cost.total)
  const cost = c ? ` · $${c.toFixed(4)}` : ''
  return `${u.totalTokens} tokens${cost}`
}
const usageLine = computed(() => usageText(currentSession.value))

function defaultModelLabel() {
  const d = defaults.value || {}
  const raw = d.modelName || d.modelId
  if (!raw) return '默认（继承 pi 设置）'
  // "DeepSeek V4.1 Flash · routing group" → 取 · 前的主名称
  const name = String(raw).split('·')[0].trim()
  return `默认（${name}）`
}
function defaultThinkingLabel() {
  const lv = (defaults.value || {}).thinkingLevel
  if (!lv) return '默认（继承 pi 设置）'
  return `默认（${THINKING_LABELS[lv] || lv}）`
}

// 分组管理
const editing = ref(null)
const SETTINGS_TABS = [
  { id: 'general', label: '对话默认' },
  { id: 'groups', label: '分组' },
  { id: 'diag', label: '诊断' },
]
function openSettings() { editing.value = null; settingsTab.value = 'general'; showSettings.value = true }
function closeSettings() { showSettings.value = false; editing.value = null }
function editGroup(g) {
  const base = g.tool || TOOL_PRESETS.read
  editing.value = {
    ...g,
    lean: { noContextFiles: false, noSkills: false, noMcp: false, noTools: false, ...(g.lean || {}) },
    tool: {
      ...base,
      list: (base.list || []).slice(),
      mcpServers: base.mcpServers || '',
      skillNames: (base.skillNames || []).slice(),
    },
  }
  showSettings.value = true
  detectContext()
}
function addGroup() {
  editing.value = newGroup()
  showSettings.value = true
  detectContext()
}
function saveGroup() {
  const e = editing.value
  if (!e || !e.name.trim()) return
  const tool = {
    ...(e.tool || TOOL_PRESETS.read),
    list: ((e.tool && e.tool.list) || []).slice(),
    skillNames: ((e.tool && e.tool.skillNames) || []).slice(),
  }
  const next = {
    ...e, tool,
    lean: {
      ...(e.lean || {}),
      noTools: tool.list.length === 0,
      noMcp: tool.mcp === 'off',
      noSkills: tool.skills === 'off',
      noContextFiles: !tool.context,
      noPromptTemplates: !tool.templates,
    },
  }
  const idx = groups.value.findIndex(g => g.id === next.id)
  if (idx >= 0) groups.value.splice(idx, 1, next)
  else groups.value.push(next)
  saveGroups(groups.value)
  editing.value = null
  showToast('设置已保存')
  loadSkillsAsync()
  files.value = []
}
// 设置行里的分组摘要：每项独立成段，用 1px 竖线分隔（不用 · 串联）
function groupSummary(g) {
  const parts = []
  if (g.kind === 'translate' && g.targetLang) parts.push(`译为${g.targetLang}`)
  parts.push(PRESET_LABEL[presetOf(g.tool)] || '自定义')
  const tl = (g.tool && g.tool.list) || []
  if (tl.length && tl.length < TOOL_NAMES.length) parts.push(tl.length + ' 个工具')
  if (g.tool && g.tool.mcp && g.tool.mcp !== 'off') parts.push('MCP 开')
  parts.push(g.model ? String(g.model).split('/').pop() : '默认模型')
  if (g.thinking) parts.push(THINKING_LABELS[g.thinking] || g.thinking)
  parts.push(displayCwd(g.cwd))
  return parts
}
// 权限档位的风险说明：这是给用户看的唯一"安全文案"，必须具体
// 内置工具清单：分成"读"与"写/执行"，后者勾选后要显著提示
const TOOL_META = [
  { id: 'read', label: 'read', note: '读取文件内容' },
  { id: 'grep', label: 'grep', note: '按内容搜索文件' },
  { id: 'find', label: 'find', note: '按名称找路径' },
  { id: 'ls', label: 'ls', note: '列目录' },
  { id: 'edit', label: 'edit', note: '按片段修改文件', risk: true },
  { id: 'write', label: 'write', note: '新建或覆盖文件', risk: true },
  { id: 'bash', label: 'bash', note: '执行 shell 命令', risk: true },
  { id: 'powershell', label: 'pwsh', note: '执行 PowerShell（仅 Windows）', risk: true },
]
const editTool = computed(() => (editing.value && editing.value.tool) || TOOL_PRESETS.read)
const editPreset = computed(() => presetOf(editing.value && editing.value.tool))
function applyPreset(id) {
  const e = editing.value
  if (!e) return
  const preset = TOOL_PRESETS[id]
  e.tool = {
    ...preset, list: preset.list.slice(), mcpServers: '', skillNames: [], trust: false,
  }
}
function hasTool(id) { return (editTool.value.list || []).includes(id) }
function toggleTool(id) {
  const t = editing.value && editing.value.tool
  if (!t) return
  const list = (t.list || []).slice()
  const i = list.indexOf(id)
  if (i >= 0) list.splice(i, 1)
  else list.push(id)
  t.list = list.sort((a, b) => TOOL_NAMES.indexOf(a) - TOOL_NAMES.indexOf(b))
}
function hasSkill(name) { return (editTool.value.skillNames || []).includes(name) }
function toggleSkill(name) {
  const t = editing.value && editing.value.tool
  if (!t) return
  const names = (t.skillNames || []).slice()
  const i = names.indexOf(name)
  if (i >= 0) names.splice(i, 1)
  else names.push(name)
  t.skillNames = names
}
// 组合后的真实后果：白名单之外 MCP / 扩展仍可能带工具，必须说清
const editRisk = computed(() => {
  const t = editing.value && editing.value.tool
  if (!t) return []
  const out = []
  const list = t.list || []
  if (!list.length) return ['不暴露任何工具']
  if (list.some(n => n === 'edit' || n === 'write')) out.push('可改文件')
  if (list.some(n => n === 'bash' || n === 'powershell')) out.push('可执行命令')
  if (t.mcp === 'all') out.push('MCP 全部（不受白名单约束）')
  if (t.mcp === 'servers') {
    out.push(String(t.mcpServers || '').trim() ? 'MCP 指定（不受白名单约束）' : 'MCP 未填 server，按关闭处理')
  }
  if (t.ext) out.push('扩展可能自带工具')
  return out
})
const editHasExec = computed(() => {
  const t = editing.value && editing.value.tool
  if (!t) return false
  return (t.list || []).some(n => n === 'bash' || n === 'powershell')
})
function toolTitle(t) {
  if (!t) return ''
  const bits = []
  bits.push((t.list || []).length ? (t.list || []).join(', ') : '无工具')
  bits.push(t.mcp === 'off' ? 'MCP 关' : t.mcp === 'all' ? 'MCP 全部' : 'MCP ' + (t.mcpServers || '未指定'))
  if (t.ext) bits.push('扩展开')
  if (t.skills === 'off') bits.push('技能关')
  else if (t.skills === 'some') bits.push('技能 ' + (t.skillNames || []).length + ' 个')
  if (t.context) bits.push('项目规范')
  if (t.trust) bits.push('项目配置')
  return bits.join(' · ')
}
// 发送时把技能名解析成目录，供 pi 的 --skill 显式加载
function toolForSend(g) {
  const src = (g && g.tool) || TOOL_PRESETS.read
  const t = {
    ...src,
    list: (src.list || []).slice(),
    mcpServers: src.mcpServers || '',
    skillNames: (src.skillNames || []).slice(),
  }
  if (t.skills === 'some') {
    t.skillPaths = (t.skillNames || [])
      .map(n => (skills.value.find(x => x.name === n) || {}).dir)
      .filter(Boolean)
  } else {
    t.skillPaths = []
  }
  return t
}
const activePermLabel = computed(() => PRESET_LABEL[presetOf(activeGroup.value && activeGroup.value.tool)] || '自定义')
// 升级后一次性提示：工具权限默认收紧了
function noticePermOnce() {
  try {
    if (read('pideck.permNotice.v1', false)) return
    write('pideck.permNotice.v1', true)
    setTimeout(() => showToast('工具权限已默认设为「只读」，可在分组设置里放开'), 900)
  } catch (_) {}
}
function deleteGroup(g) {
  if (groups.value.length <= 1) return
  const list = listSessions(g.id)
  const count = list.length
  if (count && !confirm(`删除「${g.name}」将同时删除其 ${count} 个会话（含 pi 侧会话文件）。确认删除？`)) return
  // 连带清理该分组的会话与 pi 会话文件，避免堆积
  for (const s of list) {
    deleteSession(s.id)
    if (s.piSessionId && window.piBridge && window.piBridge.deletePiSession) {
      try { window.piBridge.deletePiSession(s.piSessionId) } catch (_) {}
    }
  }
  groups.value = groups.value.filter(x => x.id !== g.id)
  saveGroups(groups.value)
  if (activeId.value === g.id) { activeId.value = groups.value[0].id; saveActiveId(activeId.value); refreshSessions() }
  else sessions.value = listSessions(activeId.value)
  closeSettings()
}
function pickCwd() {
  if (!window.piBridge || !window.piBridge.pickFolder) return
  const dir = window.piBridge.pickFolder()
  if (dir && editing.value) editing.value.cwd = dir
}

</script>

<template>
  <div class="app" :class="'layout-' + layout">
    <!-- 环境未就绪：分步安装引导 -->
    <div v-if="piStatus && !piStatus.ok" class="env-banner">
      <div class="env-banner-head">
        <span class="env-dot err"></span>
        <strong>Pi 环境未就绪</strong>
        <span class="env-sub">{{ envInfo && envInfo.errorCode === 'NODE_MISSING' ? '缺少 Node.js' : envInfo && envInfo.errorCode === 'PI_MISSING' ? '未安装 pi CLI' : '无法启动 Pi' }}</span>
        <span class="spacer"></span>
        <button class="mini-btn" @click="showEnvHelp = !showEnvHelp">{{ showEnvHelp ? '收起' : '如何安装' }}</button>
        <button class="mini-btn" @click="recheckEnv"><Icon name="refresh" :size="12" />重新检测</button>
      </div>
      <div v-if="showEnvHelp" class="env-steps">
        <div class="env-step" :class="{ done: envInfo && envInfo.nodePath }">
          <div class="env-step-title">1. 安装 Node.js <b>≥ 22.19</b></div>
          <div class="env-step-body">
            下载：<a href="#" class="env-link" @click.prevent="openLink('https://nodejs.org')">nodejs.org<Icon name="external" :size="11" /></a>
            <span v-if="envInfo && envInfo.nodeVersion" class="env-ok">已检测 {{ envInfo.nodeVersion }}</span>
            <span v-else class="env-miss">未检测到</span>
          </div>
        </div>
        <div class="env-step" :class="{ done: envInfo && envInfo.piPath }">
          <div class="env-step-title">2. 安装 pi CLI</div>
          <div class="env-step-body">
            <code class="cmd">{{ installCmd('pi') }}</code>
            <button class="mini-btn" @click="copyCmd(installCmd('pi'))">复制</button>
            <span v-if="envInfo && envInfo.piVersion" class="env-ok">已安装 v{{ envInfo.piVersion }}</span>
            <span v-else class="env-miss">未检测到</span>
          </div>
        </div>
        <div class="env-step" :class="{ done: envInfo && envInfo.configs && envInfo.configs.find(c => c.name === 'auth.json' && c.exists) }">
          <div class="env-step-title">3. 配置模型与 API 凭证</div>
          <div class="env-step-body">
            运行 <code class="cmd">pi</code> 进入交互界面，按提示登录/配置模型；或编辑
            <code>{{ (envInfo && envInfo.agentDir) || '~/.pi/agent' }}</code>
            <button class="mini-btn" @click="openPath(envInfo && envInfo.agentDir)"><Icon name="folder" :size="12" />打开目录</button>
          </div>
        </div>
        <div class="env-tip">装好后点「重新检测」。若仍失败，重启 uTools 让环境变量生效。</div>
      </div>
    </div>

    <div class="shell">
      <!-- 经典布局：左侧栏 -->
      <aside v-if="layout === 'classic'" class="sidebar">
        <div class="side-head">
          <span class="side-logo"><Icon name="pi" :size="13" :stroke="1.9" /></span>
          <span class="side-brand">PiDeck</span>
        </div>
        <button class="new-chat-btn" @click="newChat"><Icon name="plus" :size="13" />新对话</button>

        <div class="side-section">
          <div class="side-label">分组</div>
          <button
            v-for="g in groups" :key="g.id" class="side-group"
            :class="{ active: g.id === activeId }" @click="selectGroup(g.id)"
          >{{ g.name }}</button>
        </div>

        <div class="side-section history-section">
          <div class="side-label row">
            <span>最近对话</span>
            <button class="export-btn" title="导出当前会话" @click="exportCurrent"><Icon name="download" :size="12" /></button>
          </div>
          <label class="search-wrap">
            <Icon name="search" :size="12" class="search-ico" />
            <input ref="sideSearchEl" v-model="sessionSearch" class="session-search" placeholder="搜索会话" />
          </label>
          <div
            v-for="s in filteredSessions" :key="s.id" class="history-item"
            :class="{ active: currentSession && currentSession.id === s.id }"
          >
            <span class="history-title" role="button" tabindex="0" @click="loadSession(s.id)" @keydown.enter.prevent="loadSession(s.id)">{{ s.title }}</span>
            <span class="history-time">{{ relTime(s.updatedAt) }}</span>
            <button class="history-del" title="删除" @click.stop="removeSession(s.id)"><Icon name="close" :size="11" /></button>
          </div>
          <div v-if="!filteredSessions.length" class="history-empty">{{ sessionSearch ? '没有匹配的会话' : '暂无对话' }}</div>
        </div>

        <div class="side-spacer"></div>
        <div class="side-foot">
          <button class="side-settings" @click="openSettings"><Icon name="settings" :size="13" />设置</button>
          <button class="side-icon-btn" title="切换到控制台布局" @click="setLayout('console')"><Icon name="panel" :size="13" /></button>
        </div>
      </aside>

      <div class="shell-main">
        <!-- 控制台布局：顶栏 -->
        <header v-if="layout === 'console'" class="rail">
          <span class="brand-mark"><Icon name="pi" :size="11" :stroke="2" /></span>
          <span class="brand-name">PiDeck</span>
          <nav class="rail-tabs" role="tablist">
            <button
              v-for="g in groups" :key="g.id" class="tab" role="tab"
              :class="{ active: g.id === activeId }" :aria-selected="g.id === activeId"
              @click="selectGroup(g.id)"
            >{{ g.name }}</button>
          </nav>
          <div class="rail-actions">
            <button class="rail-btn" @click="newChat" title="新对话">
              <Icon name="plus" :size="13" /><span class="rb-label">新对话</span>
            </button>
            <button class="rail-btn" @click="openHistory" title="历史对话">
              <Icon name="history" :size="13" /><span class="rb-label">历史</span><kbd class="rb-kbd">{{ historyKey }}</kbd>
            </button>
            <button class="rail-btn icon-only" title="切换到经典布局" @click="setLayout('classic')"><Icon name="panel" :size="13" /></button>
            <button class="rail-btn icon-only" @click="openSettings" title="设置"><Icon name="settings" :size="14" /></button>
          </div>
        </header>

        <!-- 经典布局：标题条 -->
        <header v-else class="panel-head">
          <span class="panel-title">{{ activeGroup && activeGroup.name }}</span>
          <span class="panel-meta">
            <span class="meta-model">{{ modelReadout }}</span>
            <span class="meta-sep"></span>
            <span>{{ thinkReadout }}</span>
            <span class="meta-sep"></span>
            <span class="meta-perm" :class="{ risky: (activeGroup && activeGroup.tool || {}).list && (activeGroup.tool.list || []).some(n => n === 'bash' || n === 'powershell') }" :title="toolTitle(activeGroup && activeGroup.tool)">{{ activePermLabel }}</span>
            <span class="meta-sep meta-path-sep"></span>
            <span class="meta-path" :title="displayCwd(activeGroup && activeGroup.cwd)">{{ displayCwd(activeGroup && activeGroup.cwd) }}</span>
          </span>
        </header>

        <div ref="chatEl" class="chat">
          <TurnList
            :variant="layout"
            :visible="visibleMessages" :total="messages.length"
            :hidden-count="hiddenCount" :page-size="PAGE_SIZE"
            :running="running" :run-phase="runPhase" :usage="usageLine"
            :error="errorMsg" :empty-desc="emptyCopy.desc" :chips="emptyCopy.chips"
            :send-key-chip="sendKeyChip"
            @earlier="showEarlier" @chip="fillChip" @copy="copyText" @link="openLink" @preview="showPreview"
          />
        </div>

      <!-- 输入区：命令行形态，读数与发送键同一行 -->
      <div class="composer">
        <div class="composer-inner">
          <div v-if="images.length || attachedFiles.length" class="attachments">
            <div v-for="(img, i) in images" :key="'i'+i" class="thumb">
              <img :src="img.dataUrl" title="点击放大" @click="showPreview(img.dataUrl)" /><button class="thumb-x" @click="removeImage(i)"><Icon name="close" :size="10" :stroke="2" /></button>
            </div>
            <div v-for="(f, i) in attachedFiles" :key="'f'+i" class="file-chip">
              {{ f.split(/[\\/]/).pop() }}<button class="thumb-x" @click="removeFile(i)"><Icon name="close" :size="10" :stroke="2" /></button>
            </div>
          </div>

          <div v-if="showSkillMenu" class="suggest-menu">
            <div class="suggest-head">技能</div>
            <button
              v-for="(s, si) in filteredSkills" :key="s.name" class="suggest-item"
              :class="{ active: si === menuIndex }" @click="insertSkill(s)" @mouseenter="menuIndex = si"
            >
              <span class="suggest-name">/skill:{{ s.name }}</span>
              <span class="suggest-desc">{{ s.description }}</span>
            </button>
            <div v-if="!filteredSkills.length" class="suggest-empty">无匹配技能</div>
          </div>
          <div v-if="showFileMenu" class="suggest-menu">
            <div class="suggest-head">文件<span class="suggest-path">{{ displayCwd(activeGroup && activeGroup.cwd) }}</span></div>
            <button
              v-for="(f, fi) in filteredFiles" :key="f.path" class="suggest-item"
              :class="{ active: fi === menuIndex }" @click="insertFile(f)" @mouseenter="menuIndex = fi"
            >
              <span class="suggest-name">{{ f.dir ? '[目录] ' : '' }}{{ f.path }}</span>
            </button>
            <div v-if="!filteredFiles.length" class="suggest-empty">无匹配文件</div>
          </div>

          <div class="prompt-row">
            <span class="prompt-caret">›</span>
            <textarea
              ref="inputEl" v-model="inputText" class="input" rows="2"
              placeholder="给 pi 发消息，/ 技能，@ 文件"
              @paste="onPaste" @input="onInput" @keydown="onComposerKeydown"
            />
          </div>
          <div class="composer-bar">
            <div class="readout">
              <span class="ro ro-perm" :class="{ risky: editHasExec }" :title="toolTitle(activeGroup && activeGroup.tool)">{{ activePermLabel }}</span>
              <span class="ro-sep"></span>
              <span class="ro ro-model" :title="modelReadout">{{ modelReadout }}</span>
              <span class="ro-sep"></span>
              <span class="ro">{{ thinkReadout }}</span>
              <span class="ro-sep ro-path-sep"></span>
              <span class="ro ro-path" :title="displayCwd(activeGroup && activeGroup.cwd)">{{ displayCwd(activeGroup && activeGroup.cwd) }}</span>
            </div>
            <span class="spacer"></span>
            <button class="sendkey" @click="toggleSendKey" title="点击切换发送键">{{ sendKeyMode === 'enter' ? 'Enter 发送' : 'Ctrl+回车 发送' }}</button>
            <button v-if="running" class="send-btn stop" @click="cancel" title="停止"><Icon name="stop" :size="12" /></button>
            <button v-else class="send-btn" @click="send" :disabled="!inputText.trim() && !images.length && !attachedFiles.length" title="发送"><Icon name="send" :size="14" :stroke="1.9" /></button>
          </div>
        </div>
      </div>
      </div>
    </div>


    <!-- 历史滑出面板 -->
    <div v-if="showHistory" class="drawer-mask" @click.self="closeHistory">
      <aside class="drawer" @keydown.down.prevent="moveHistory(1)" @keydown.up.prevent="moveHistory(-1)" @keydown.enter.prevent="openHistoryActive">
        <div class="drawer-head">
          <Icon name="search" :size="13" class="drawer-search-ico" />
          <input ref="historySearchEl" v-model="sessionSearch" class="drawer-search" placeholder="搜索会话" />
          <button class="icon-btn" @click="closeHistory" title="关闭"><Icon name="close" :size="12" /></button>
        </div>
        <div class="drawer-list">
          <template v-for="bucket in groupedSessions" :key="bucket.label">
            <div class="drawer-label">{{ bucket.label }}</div>
            <div
              v-for="s in bucket.items" :key="s.id" class="h-row" role="button" tabindex="0"
              :class="{ active: currentSession && currentSession.id === s.id, focus: isFocusedSession(s) }"
              @click="loadSession(s.id)" @keydown.enter.stop.prevent="loadSession(s.id)"
            >
              <span class="h-title">{{ s.title }}</span>
              <span class="h-time">{{ relTime(s.updatedAt) }}</span>
              <button class="h-del" title="删除" @click.stop="removeSession(s.id)"><Icon name="close" :size="11" /></button>
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

    <!-- 设置 -->
    <div v-if="showSettings" class="modal-mask" @click.self="closeSettings">
      <div class="modal" :class="{ wide: settingsTab === 'groups' && !editing }">
        <div class="modal-head">
          <button v-if="editing" class="back-btn" @click="editing = null" title="返回分组列表"><Icon name="back" :size="13" /></button>
          <strong>{{ editing ? '编辑分组 · ' + (editing.name || '未命名') : '设置' }}</strong>
          <span class="spacer"></span>
          <button class="icon-btn" @click="closeSettings" title="关闭"><Icon name="close" :size="13" /></button>
        </div>

        <!-- 分组编辑：整窗切换，不再从长列表底部开始 -->
        <div v-if="editing" class="group-form">
          <label><span>分组名称</span><input v-model="editing.name" type="text" placeholder="如：代码审查" /></label>
          <label><span>提示词（作为每次对话前缀）</span><textarea v-model="editing.prompt" rows="4" placeholder="定义该分组的角色、语气、输出格式…"></textarea></label>
          <div class="form-grid">
            <label>
              <span>模型
                <button class="refresh-link" @click="refreshModels"><Icon name="refresh" :size="11" />刷新</button>
              </span>
              <select v-model="editing.model">
                <option value="">{{ defaultModelLabel() }}</option>
                <option v-for="m in models" :key="m.display" :value="m.model">{{ m.display }}</option>
              </select>
              <span v-if="!models.length" class="hint">未获取到模型列表（Pi 未就绪或未配置模型）</span>
            </label>
            <label><span>思考强度</span>
              <select v-model="editing.thinking">
                <option v-for="lv in THINKING_LEVELS" :key="lv" :value="lv">{{ thinkingLabel(lv) }}</option>
              </select>
            </label>
            <label><span>目标语言（翻译类分组用）</span>
              <select v-model="editing.targetLang">
                <option v-for="l in TARGET_LANGS" :key="l" :value="l">{{ l || '不指定' }}</option>
              </select>
            </label>
          </div>
          <label>
            <span>工作文件夹（留空则用全局默认）</span>
            <div class="cwd-row">
              <input v-model="editing.cwd" type="text" :placeholder="`留空 = ${displayCwd('')}`" />
              <button class="mini-btn" @click="pickCwd">选择</button>
            </div>
            <span class="hint accent">当前生效：{{ displayCwd(editing.cwd) }}{{ editing.cwd ? '' : '（默认值）' }}</span>
          </label>
          <div class="perm-section">
            <div class="lean-title">工具权限</div>
            <div class="perm-row">
              <button
                v-for="p in PRESET_LIST" :key="p.id" class="choice"
                :class="{ on: editPreset === p.id, risk: p.id === 'full' && editPreset === 'full' }"
                @click="applyPreset(p.id)"
              >{{ p.label }}</button>
              <span v-if="editPreset === 'custom'" class="choice on custom">自定义</span>
            </div>

            <div class="tool-label">读与搜索</div>
            <div class="tool-chips">
              <label
                v-for="t in TOOL_META.filter(x => !x.risk)" :key="t.id"
                class="tool-chip" :class="{ on: hasTool(t.id) }" :title="t.note"
              >
                <input type="checkbox" :checked="hasTool(t.id)" @change="toggleTool(t.id)" />
                <span>{{ t.label }}</span>
              </label>
            </div>

            <div class="tool-label">写入与执行 <small>勾选后可以改动磁盘或运行命令</small></div>
            <div class="tool-chips">
              <label
                v-for="t in TOOL_META.filter(x => x.risk)" :key="t.id"
                class="tool-chip risk" :class="{ on: hasTool(t.id) }" :title="t.note"
              >
                <input type="checkbox" :checked="hasTool(t.id)" @change="toggleTool(t.id)" />
                <span>{{ t.label }}</span>
              </label>
            </div>

            <span class="hint" :class="{ warn: editHasExec }">工具影响：{{ editRisk.join('、') }}</span>
          </div>

          <div class="ctx-section">
            <div class="lean-title">资源与上下文</div>

            <div class="seg-row">
              <span class="seg-name">MCP</span>
              <div class="seg">
                <button :class="{ on: editTool.mcp === 'off' }" @click="editTool.mcp = 'off'">关</button>
                <button :class="{ on: editTool.mcp === 'all' }" @click="editTool.mcp = 'all'">全部</button>
                <button :class="{ on: editTool.mcp === 'servers' }" @click="editTool.mcp = 'servers'">指定</button>
              </div>
            </div>
            <input
              v-if="editTool.mcp === 'servers'" v-model="editTool.mcpServers" class="mini-input"
              placeholder="server 名，逗号分隔，如 radius, github"
            />

            <div class="seg-row">
              <span class="seg-name">技能</span>
              <div class="seg">
                <button :class="{ on: editTool.skills === 'off' }" @click="editTool.skills = 'off'">关</button>
                <button :class="{ on: editTool.skills === 'all' }" @click="editTool.skills = 'all'">全部</button>
                <button :class="{ on: editTool.skills === 'some' }" @click="editTool.skills = 'some'">指定</button>
              </div>
            </div>
            <div v-if="editTool.skills === 'some'" class="skill-pick">
              <label v-for="s in skills" :key="s.name" class="tool-chip" :class="{ on: hasSkill(s.name) }" :title="s.description">
                <input type="checkbox" :checked="hasSkill(s.name)" @change="toggleSkill(s.name)" />
                <span>{{ s.name }}</span>
              </label>
              <span v-if="!skills.length" class="hint">未检测到技能</span>
            </div>

            <label class="switch-row">
              <span class="switch-label">扩展<small>加载 ~/.pi 扩展；扩展可自带工具</small></span>
              <input class="switch" type="checkbox" :checked="editTool.ext" @change="editTool.ext = $event.target.checked" />
            </label>
            <label class="switch-row">
              <span class="switch-label">项目规范<small>注入 AGENTS.md / CLAUDE.md</small></span>
              <input class="switch" type="checkbox" :checked="editTool.context" @change="editTool.context = $event.target.checked" />
            </label>
            <label class="switch-row">
              <span class="switch-label">提示词模板<small>加载 prompt templates</small></span>
              <input class="switch" type="checkbox" :checked="editTool.templates" @change="editTool.templates = $event.target.checked" />
            </label>
            <label class="switch-row">
              <span class="switch-label">项目级 .pi 配置<small>项目扩展 / 项目 MCP / 项目技能</small></span>
              <input class="switch" type="checkbox" :checked="editTool.trust" @change="editTool.trust = $event.target.checked" />
            </label>
            <span class="hint">全局 ~/.pi 配置始终生效；项目级配置需要信任，非交互模式不会弹窗</span>
            <div v-if="contextFiles.length" class="ctx-info">
              检测到规范文件：
              <div v-for="c in contextFiles" :key="c.path" class="ctx-row">
                <span class="ctx-tag">{{ ctxLabel(c) }}</span>{{ c.path }} · {{ fmtSize(c.size) }}
              </div>
            </div>
            <div v-else class="ctx-info muted">未检测到 AGENTS.md / CLAUDE.md</div>
          </div>
          <div class="form-actions">
            <button v-if="groups.length > 1" class="danger-link" @click="deleteGroup(editing)"><Icon name="trash" :size="12" />删除这个分组</button>
            <span class="spacer"></span>
            <button class="mini-btn" @click="editing = null">取消</button>
            <button class="primary-btn" @click="saveGroup">保存</button>
          </div>
        </div>

        <template v-else>
          <div class="tabs">
            <button
              v-for="t in SETTINGS_TABS" :key="t.id" class="tab sub"
              :class="{ active: settingsTab === t.id }" @click="settingsTab = t.id"
            >{{ t.label }}</button>
          </div>

          <div v-if="settingsTab === 'general'" class="pane">
            <div class="field-label">界面布局</div>
            <div class="engine-row">
              <button class="layout-opt" :class="{ on: layout === 'classic' }" @click="setLayout('classic')">
                <span>经典<small>左侧栏 + 对话气泡</small></span>
              </button>
              <button class="layout-opt" :class="{ on: layout === 'console' }" @click="setLayout('console')">
                <span>控制台<small>顶栏分组 + 转录式对话</small></span>
              </button>
            </div>
            <div class="field-label">运行引擎</div>
            <div class="engine-row">
              <label class="engine-opt">
                <input type="radio" name="engine" value="json" :checked="engine === 'json'" @change="setEngine('json')" />
                <span>单次调用 <small>稳定，每次启动约 1.5s</small></span>
              </label>
              <label class="engine-opt">
                <input type="radio" name="engine" value="rpc" :checked="engine === 'rpc'" @change="setEngine('rpc')" />
                <span>长驻预热 <small>更快，打开即后台预热</small></span>
              </label>
            </div>
            <div class="field-label">默认工作目录</div>
            <div class="cwd-row">
              <input :value="defaultCwd" type="text" placeholder="留空 = MyPiDeck（用户主目录下）" @change="commitDefaultCwd($event.target.value)" />
              <button class="mini-btn" @click="pickDefaultCwd">选择</button>
              <button v-if="defaultCwd" class="mini-btn" @click="setDefaultCwd('')">清除</button>
            </div>
            <span class="hint accent">分组未单独设置时使用：{{ displayCwd('') }}</span>
            <div class="field-label">发送后</div>
            <div class="engine-row">
              <button class="choice" :class="{ on: sendKeyMode === 'enter' }" @click="setSendKeyMode('enter')">Enter 发送</button>
              <button class="choice" :class="{ on: sendKeyMode === 'ctrl' }" @click="setSendKeyMode('ctrl')">Ctrl+回车 发送</button>
            </div>
          </div>

          <div v-else-if="settingsTab === 'groups'" class="pane">
            <button v-for="g in groups" :key="g.id" class="g-row" @click="editGroup(g)">
              <span class="g-name">{{ g.name }}</span>
              <span class="g-sum">
                <span v-for="(p, pi) in groupSummary(g)" :key="pi" class="sum-i">{{ p }}</span>
              </span>
              <Icon name="chevron" :size="12" class="g-chev" />
            </button>
            <button class="add-row" @click="addGroup"><Icon name="plus" :size="12" />新建分组</button>
          </div>

          <div v-else class="pane">
            <div v-if="envInfo && envInfo.ok" class="env-grid">
              <div class="env-row"><span>Node</span><code>{{ envInfo.nodeVersion || '—' }}</code></div>
              <div class="env-row"><span>pi CLI</span><code>{{ envInfo.piVersion ? 'v' + envInfo.piVersion : '—' }}</code></div>
              <div class="env-row"><span>默认模型</span><code>{{ envInfo.defaultModel || '—' }}</code></div>
              <div class="env-row"><span>默认思考</span><code>{{ envInfo.defaultThinking || '—' }}</code></div>
              <div class="env-row"><span>pi 路径</span><code class="path" :title="envInfo.piPath">{{ envInfo.piPath }}</code></div>
            </div>
            <div v-else class="env-warn">未检测到可用的 Pi 环境。点顶部提示按步骤安装。</div>
            <div class="env-configs">
              <div v-for="c in (envInfo && envInfo.configs) || []" :key="c.name" class="env-config-row">
                <span class="env-config-name">{{ c.name }}</span>
                <span class="env-config-label">{{ c.label }}</span>
                <span class="spacer"></span>
                <span class="env-config-state" :class="c.exists ? 'on' : 'off'">{{ c.exists ? fmtSize(c.size) : '未创建' }}</span>
                <button class="mini-btn icon-only" :disabled="!c.exists" @click="openPath(c.path)" title="在文件管理器中定位"><Icon name="external" :size="12" /></button>
              </div>
            </div>
            <div class="env-actions">
              <button class="mini-btn" @click="openPath(envInfo && envInfo.agentDir)"><Icon name="folder" :size="12" />打开配置目录</button>
              <button class="mini-btn" @click="recheckEnv"><Icon name="refresh" :size="12" />重新检测</button>
            </div>
          </div>
        </template>
      </div>
    </div>

    <!-- 图片放大预览 -->
    <div v-if="previewImage" class="lightbox" @click.self="closePreview">
      <button class="lightbox-close" @click="closePreview" title="关闭（Esc）"><Icon name="close" :size="16" /></button>
      <img :src="previewImage" alt="图片预览" @click.stop />
    </div>

    <div v-if="toast" class="toast">{{ toast }}</div>
  </div>
</template>

<style src="./main.css"></style>
