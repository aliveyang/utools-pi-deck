<script setup>
import { ref, computed, onMounted, onUnmounted, nextTick, watch } from 'vue'
import { loadGroups, saveGroups, loadActiveId, saveActiveId, loadDrafts, saveDrafts, PRESET_LABEL, TOOL_PRESETS, presetOf } from './groups.js'
import { readCache, read, write } from './storage.js'
import Icon from './components/Icon.vue'
import TurnList from './components/TurnList.vue'
import EnvBanner from './components/EnvBanner.vue'
import HistoryDrawer from './components/HistoryDrawer.vue'
import SettingsModal from './components/SettingsModal.vue'
import {
  listSessions, getSession, createSession, updateSession, deleteSession,
  titleFromText, exportMarkdown, relTime,
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
const settingsModalEl = ref(null)
const chatEl = ref(null)
const inputEl = ref(null)
const sideSearchEl = ref(null)
const previewImage = ref('')
function showPreview(src) { if (src) previewImage.value = src }
function closePreview() { previewImage.value = '' }

// 历史滑出面板
const showHistory = ref(false)
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

function effectiveGroupCwd(g) {
  return (g && g.cwd) || defaultCwd.value || ''
}

// ---- 组合式模块 ----
const { toast, showToast, copyText } = useToast()
const {
  defaultCwd, setDefaultCwd, commitDefaultCwd, pickDefaultCwd,
  sendKeyMode, setSendKeyMode, displayCwd, fmtSize,
  layout, setLayout,
} = usePrefs({
  showToast,
  onCwdChange: () => {
    detectContext()
    loadSkillsAsync()
    files.value = []
    if (engine.value === 'rpc') maybePrewarmRpc()
  },
})
const {
  models, skills, piStatus, engine, contextFiles, defaults, envInfo, showEnvHelp,
  loadDefaults, detectContext, loadModelsAsync, refreshModels, loadSkillsAsync,
  loadEnv, recheckEnv, prewarmActive, setEngine, openPath, openExternal,
} = usePiEnv({
  getCwd: () => effectiveGroupCwd(activeGroup.value),
  // 预热进程按分组的工具权限区分（不同配置不能复用同一进程）
  getLean: () => ({ tool: toolForSend(activeGroup.value) }),
  showToast,
})

const sendKeyChip = computed(() => sendKeyMode.value === 'enter' ? 'Enter' : (isMac ? '⌘+↵' : 'Ctrl+↵'))
function toggleSendKey() {
  setSendKeyMode(sendKeyMode.value === 'enter' ? 'ctrl' : 'enter')
}

// 后台预热 RPC 长驻进程（配置启用时）；关窗/重新进入时由 handleEnter 再次预热
function maybePrewarmRpc() {
  if (engine.value !== 'rpc' || !window.piBridge || !window.piBridge.prewarmRpc) return
  prewarmActive().catch(() => {})
}

// 空态：按分组给一句定位 + 可直接点的示例
const EMPTY_COPY = {
  chat: { desc: '纯文本对话，不带工具和项目规范', chips: ['解释这段代码', '给这个函数起个名字', '把这段话写得更简洁'] },
  translate: { desc: '把内容翻译成目标语言，只输出译文', chips: ['把下面内容翻译成目标语言：\n', '翻译下面这段话：\n'] },
  agent: { desc: '默认只读工具，可在分组设置中按需放开编辑与命令执行', chips: ['看看这个项目的结构', '帮我定位这个报错', '写个脚本整理下载目录'] },
}
const emptyCopy = computed(() => {
  const g = activeGroup.value || {}
  const base = EMPTY_COPY[g.kind] || EMPTY_COPY.chat
  if (g.kind === 'translate' && g.targetLang) {
    return {
      desc: `把内容翻译成${g.targetLang}，只输出译文`,
      chips: [`把下面内容翻译成${g.targetLang}：\n`, '翻译下面这段话：\n'],
    }
  }
  return base
})
function fillChip(text) {
  inputText.value = text
  nextTick(() => {
    const el = inputEl.value
    if (!el) return
    el.focus()
    el.selectionStart = el.selectionEnd = text.length
  })
}

const THINKING_LABELS = {
  off: '不思考', minimal: '极简', low: '低', medium: '中', high: '高', xhigh: '极高', max: '最高',
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
  if (showSettings.value) {
    if (!(settingsModalEl.value && settingsModalEl.value.handleEsc())) closeSettings()
    return
  }
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
    // 关窗时停掉长驻 RPC 进程，避免后台滞留（运行中不停，防止打断生成）
    if (!running.value && window.piBridge && window.piBridge.stopRpc) {
      try { window.piBridge.stopRpc() } catch (_) {}
    }
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
    maybePrewarmRpc()
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

function openHistory() {
  if (!sessions.value.length) { showToast('还没有对话'); return }
  showHistory.value = true
}
function closeHistory() { showHistory.value = false }

function copyCmd(text) { copyText(text) }
// 外链统一走系统浏览器（uTools 内 target=_blank 常被拦）
function openLink(url) { openExternal(url) }

function refreshFiles() {
  if (!window.piBridge || !window.piBridge.listFiles) return
  try { files.value = window.piBridge.listFiles(effectiveGroupCwd(activeGroup.value)) || [] } catch (_) { files.value = [] }
}
function refreshSessions() {
  // 每次打开默认新建对话（不续接上次），历史仍可点开
  sessions.value = listSessions(activeId.value)
  currentSession.value = null
}

function handleEnter(action) {
  if (running.value) {
    showToast('当前回答生成中，请先停止')
    return
  }
  const code = String(action.code || '')
  const type = String(action.type || '')
  const payload = action.payload

  // 先切分组，再清空输入与目标分组草稿（避免先清旧分组、切入后再把目标分组草稿恢复出来）
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

  // uTools 窗口复用，重新进入不会重新 mount：显式回到新对话态
  refreshSessions()
  resetPaging()
  closeHistory()
  maybePrewarmRpc()

  inputText.value = ''
  const drafts = loadDrafts(); drafts[activeId.value] = ''; saveDrafts(drafts)
  errorMsg.value = ''
  closePreview()
  images.value = []
  attachedFiles.value = []

  // uTools 中 type === 'text' 的 payload 是触发关键词本身（如 "pi"/"翻译"），仅 over/regex 才是匹配文本
  if ((type === 'over' || type === 'regex') && typeof payload === 'string') inputText.value = payload
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
  detectContext()
  files.value = []            // @ 文件改为懒加载，清空旧的
  refreshSessions()
  restoreDraft()              // 最后恢复【新 id】的草稿
  if (engine.value === 'rpc') maybePrewarmRpc()
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
    cwd: effectiveGroupCwd(g), targetLang: g.targetLang || '',
    tool: toolForSend(g),
  }
}
function newChat() {
  if (running.value) return
  saveCurrentDraft()
  // 懒创建：仅清空到新对话空态，首条消息发送时再落盘创建会话
  currentSession.value = null
  resetPaging()
  inputText.value = ''
  images.value = []
  attachedFiles.value = []
  errorMsg.value = ''
  closeHistory()
  nextTick(() => inputEl.value && inputEl.value.focus())
}
function removeSession(id) {
  if (running.value) { showToast('请先停止当前回答'); return }
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
  const readTask = new Promise(resolve => {
    const reader = new FileReader()
    reader.onload = () => { addImage(reader.result); resolve() }
    reader.onerror = () => { showToast('图片读取失败'); resolve() }
    reader.readAsDataURL(file)
  })
  pendingImageReads.push(readTask)
  readTask.finally(() => { pendingImageReads = pendingImageReads.filter(p => p !== readTask) })
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

function truncateToolResult(val) {
  if (val == null) return val
  const MAX = 16000
  if (typeof val === 'string') return val.length > MAX ? val.slice(0, MAX) + '\n…（输出过长已截断）' : val
  try {
    const s = JSON.stringify(val)
    if (s.length <= MAX) return val
    return s.slice(0, MAX) + '\n…（输出过长已截断）'
  } catch (_) {
    const s = String(val)
    return s.length > MAX ? s.slice(0, MAX) + '\n…（输出过长已截断）' : s
  }
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
  const outImages = [...images.value]
  const outFiles = [...attachedFiles.value]
  const g = snapshotConfig(activeGroup.value)

  // 局部命名 sendFiles：避免遮蔽外层 @ 文件菜单的 files ref
  let sendFiles = [...outFiles]
  const imagePaths = []
  for (const img of outImages) {
    try { const p = window.piBridge.saveImage(img.dataUrl); imagePaths.push(p); sendFiles.push(p) }
    catch (e) { errorMsg.value = String(e.message || e); return }
  }

  // 懒创建会话：图片落盘等前置校验通过后再创建会话并入库
  if (!currentSession.value || currentSession.value.groupId !== activeId.value) {
    const created = createSession(activeId.value, g)
    currentSession.value = created
    sessions.value = listSessions(activeId.value)
    resetPaging()
  }
  const session = currentSession.value
  // 始终使用分组当前配置：用户改模型/思考后应立刻对新消息生效
  updateSession(session.id, { config: { ...g } })

  // 提示词：分组前缀 + 翻译目标语言 + 用户输入
  let prefix = (g.prompt && g.prompt.trim()) ? g.prompt.trim() : ''
  if (g.targetLang && g.targetLang.trim()) prefix += `\n目标语言：${g.targetLang.trim()}`
  const prompt = prefix
    ? `${prefix}\n\n---\n\n${userText || '请处理上方附带的内容。'}`
    : (userText || '请描述这张图片。')

  const fileNames = outFiles.map(f => String(f).split(/[\\/]/).pop()).filter(Boolean)
  // 只存图片数量与本地路径引用，不存 base64（避免存储膨胀）
  const imageRefs = outImages.length ? { imageCount: outImages.length, imagePaths } : {}
  const fileRefs = fileNames.length ? { fileNames } : {}
  const fallbackUserText = outImages.length ? '(图片)' : '(附件)'
  session.messages.push({ role: 'user', text: userText || fallbackUserText, ...imageRefs, ...fileRefs })
  if (session.title === '新对话') session.title = titleFromText(userText || fallbackUserText)
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
        prompt, model: g.model || '', thinking: g.thinking || '', cwd: g.cwd || '', files: sendFiles,
        sessionId: session.piSessionId,
        tool: g.tool,
      },
      {
        onEvent: rec => {
          if (finalized) return
          if (rec.type === 'agent_start' || rec.type === 'turn_start') {
            if (runPhase.value === 'spawning') runPhase.value = 'connecting'
          }
        },
        onText: delta => {
          if (finalized || !currentAssistant) return
          runPhase.value = 'generating'
          currentAssistant.text += delta
          scrollChatThrottled()
        },
        onThinking: delta => {
          if (finalized || !currentAssistant) return
          if (runPhase.value !== 'generating') runPhase.value = 'generating'
          currentAssistant.thinking += delta
        },
        onTool: (phase, name, payload, id) => {
          if (finalized || !currentAssistant) return
          if (phase === 'start') {
            currentAssistant.tools.push({ id: id || ('t' + Date.now() + Math.random()), name, args: payload })
          } else {
            const t = id
              ? currentAssistant.tools.find(x => x.id === id && !x.result)
              : [...currentAssistant.tools].reverse().find(x => x.name === name && !x.result)
            if (t) t.result = truncateToolResult(payload)
          }
        },
        onUsage: usage => {
          if (finalized) return
          session.usage = usage
        },
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
  // 注意：finalize 会把 runHandle 置空，必须先缓存句柄，否则 RPC 模式的 cancel 永远走不到
  const handle = runHandle
  finalize(true, '')
  if (handle && handle.cancel) { try { handle.cancel() } catch (_) {} }
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
function usageText(session) {
  const u = session && session.usage
  if (!u || !u.totalTokens) return ''
  const c = u.cost && Number(u.cost.total)
  const cost = c ? ` · $${c.toFixed(4)}` : ''
  return `${u.totalTokens} tokens${cost}`
}
const usageLine = computed(() => usageText(currentSession.value))

function openSettings() { showSettings.value = true }
function closeSettings() { showSettings.value = false }

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
    let pool = skills.value
    if (g && g.cwd && (!activeGroup.value || g.cwd !== activeGroup.value.cwd) && window.piBridge && window.piBridge.listSkills) {
      try { pool = window.piBridge.listSkills(effectiveGroupCwd(g)) || pool } catch (_) {}
    }
    t.skillPaths = (t.skillNames || [])
      .map(n => (pool.find(x => x.name === n) || {}).dir)
      .filter(Boolean)
  } else {
    t.skillPaths = []
  }
  return t
}
const activePermLabel = computed(() => PRESET_LABEL[presetOf(activeGroup.value && activeGroup.value.tool)] || '自定义')
const activeHasExec = computed(() =>
  ((activeGroup.value && activeGroup.value.tool && activeGroup.value.tool.list) || [])
    .some(n => n === 'bash' || n === 'powershell'))

// 升级后一次性提示：工具权限默认收紧了
function noticePermOnce() {
  try {
    if (read('pideck.permNotice.v1', false)) return
    write('pideck.permNotice.v1', true)
    setTimeout(() => showToast('工具权限已默认设为「只读」，可在分组设置里放开'), 900)
  } catch (_) {}
}

function onSaveGroup(next) {
  const idx = groups.value.findIndex(g => g.id === next.id)
  if (idx >= 0) groups.value.splice(idx, 1, next)
  else groups.value.push(next)
  saveGroups(groups.value)
  showToast('设置已保存')
  loadSkillsAsync()
  detectContext()
  files.value = []
  if (next.id === activeId.value && engine.value === 'rpc') maybePrewarmRpc()
}

function onDeleteGroup(g) {
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
</script>

<template>
  <div class="app" :class="'layout-' + layout">
    <EnvBanner
      :pi-status="piStatus"
      :env-info="envInfo"
      :show-env-help="showEnvHelp"
      @toggle-help="showEnvHelp = !showEnvHelp"
      @recheck="recheckEnv"
      @open-link="openLink"
      @copy-cmd="copyCmd"
      @open-path="openPath"
    />

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
            <button class="history-del" title="删除" aria-label="删除会话" @click.stop="removeSession(s.id)"><Icon name="close" :size="11" /></button>
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
            <span class="meta-perm" :class="{ risky: activeHasExec }" :title="toolTitle(activeGroup && activeGroup.tool)">{{ activePermLabel }}</span>
            <span class="meta-sep meta-path-sep"></span>
            <span class="meta-path" :title="displayCwd(activeGroup && activeGroup.cwd)">{{ displayCwd(activeGroup && activeGroup.cwd) }}</span>
          </span>
        </header>

        <div ref="chatEl" class="chat">
          <TurnList
            :variant="layout"
            :session-id="currentSession ? currentSession.id : ''"
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
                <img :src="img.dataUrl" alt="已粘贴图片" title="点击放大" @click="showPreview(img.dataUrl)" /><button class="thumb-x" aria-label="移除图片" @click="removeImage(i)"><Icon name="close" :size="10" :stroke="2" /></button>
              </div>
              <div v-for="(f, i) in attachedFiles" :key="'f'+i" class="file-chip">
                {{ f.split(/[\\/]/).pop() }}<button class="thumb-x" aria-label="移除附件" @click="removeFile(i)"><Icon name="close" :size="10" :stroke="2" /></button>
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
                <span class="ro ro-perm" :class="{ risky: activeHasExec }" :title="toolTitle(activeGroup && activeGroup.tool)">{{ activePermLabel }}</span>
                <span class="ro-sep"></span>
                <span class="ro ro-model" :title="modelReadout">{{ modelReadout }}</span>
                <span class="ro-sep"></span>
                <span class="ro">{{ thinkReadout }}</span>
                <span class="ro-sep ro-path-sep"></span>
                <span class="ro ro-path" :title="displayCwd(activeGroup && activeGroup.cwd)">{{ displayCwd(activeGroup && activeGroup.cwd) }}</span>
              </div>
              <span class="spacer"></span>
              <button class="sendkey" @click="toggleSendKey" title="点击切换发送键">{{ sendKeyMode === 'enter' ? 'Enter 发送' : (isMac ? 'Cmd+回车 发送' : 'Ctrl+回车 发送') }}</button>
              <button v-if="running" class="send-btn stop" @click="cancel" title="停止"><Icon name="stop" :size="12" /></button>
              <button v-else class="send-btn" @click="send" :disabled="!inputText.trim() && !images.length && !attachedFiles.length" title="发送"><Icon name="send" :size="14" :stroke="1.9" /></button>
            </div>
          </div>
        </div>
      </div>
    </div>

    <HistoryDrawer
      :show="showHistory"
      :sessions="sessions"
      :current-session-id="currentSession ? currentSession.id : ''"
      @close="closeHistory"
      @select="loadSession"
      @remove="removeSession"
    />

    <SettingsModal
      ref="settingsModalEl"
      :show="showSettings"
      :groups="groups"
      :models="models"
      :skills="skills"
      :defaults="defaults"
      :env-info="envInfo"
      :engine="engine"
      :layout="layout"
      :default-cwd="defaultCwd"
      :send-key-mode="sendKeyMode"
      :is-mac="isMac"
      :display-cwd="displayCwd"
      :fmt-size="fmtSize"
      @close="closeSettings"
      @set-layout="setLayout"
      @set-engine="setEngine"
      @commit-default-cwd="commitDefaultCwd"
      @set-default-cwd="setDefaultCwd"
      @pick-default-cwd="pickDefaultCwd"
      @set-send-key-mode="setSendKeyMode"
      @save-group="onSaveGroup"
      @delete-group="onDeleteGroup"
      @refresh-models="refreshModels"
      @open-path="openPath"
      @recheck-env="recheckEnv"
    />

    <!-- 图片放大预览 -->
    <div v-if="previewImage" class="lightbox" @click.self="closePreview">
      <button class="lightbox-close" @click="closePreview" title="关闭（Esc）"><Icon name="close" :size="16" /></button>
      <img :src="previewImage" alt="图片预览" @click.stop />
    </div>

    <div v-if="toast" class="toast">{{ toast }}</div>
  </div>
</template>

<style src="./main.css"></style>
