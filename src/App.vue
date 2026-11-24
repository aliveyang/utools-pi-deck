<script setup>
import { ref, computed, onMounted, onUnmounted, nextTick, watch } from 'vue'
import { loadGroups, saveGroups, loadActiveId, saveActiveId, loadDrafts, saveDrafts, TOOL_PRESETS } from './groups.js'
import { readCacheMeta, writeCache } from './storage.js'
import { isRiskyTool, activeRiskSummary, toolSummary } from './constants.js'
import Icon from './components/Icon.vue'
import Sidebar from './components/Sidebar.vue'
import TopRail from './components/TopRail.vue'
import StatusReadout from './components/StatusReadout.vue'
import TurnList from './components/TurnList.vue'
import Composer from './components/Composer.vue'
import EnvBanner from './components/EnvBanner.vue'
import HistoryDrawer from './components/HistoryDrawer.vue'
import SettingsModal from './components/SettingsModal.vue'
import {
  listSessions, getSession, createSession, updateSession, deleteSession,
  clearAllSessions, titleFromText, exportMarkdown,
} from './sessions.js'
import { useToast } from './composables/useToast.js'
import { usePrefs } from './composables/usePrefs.js'
import { usePiEnv } from './composables/usePiEnv.js'
import { useConfirm } from './composables/useConfirm.js'

const groups = ref(loadGroups())
const activeId = ref(loadActiveId())
const activeGroup = computed(() => groups.value.find(g => g.id === activeId.value) || groups.value[0])

const sessions = ref([])
const currentSession = ref(null)
const messages = computed(() => currentSession.value ? currentSession.value.messages : [])

const PAGE_SIZE = 60
const visibleCount = ref(PAGE_SIZE)
const hiddenCount = computed(() => Math.max(0, messages.value.length - visibleCount.value))
const visibleMessages = computed(() =>
  hiddenCount.value ? messages.value.slice(-visibleCount.value) : messages.value)
function showEarlier() {
  const el = chatEl.value
  const prevHeight = el ? el.scrollHeight : 0
  visibleCount.value += PAGE_SIZE
  nextTick(() => { if (el) el.scrollTop += el.scrollHeight - prevHeight })
}
function resetPaging() { visibleCount.value = PAGE_SIZE }

const inputText = ref('')
const images = ref([])
const attachedFiles = ref([])
const files = ref([])
const filesLoading = ref(false)
const running = ref(false)
const runPhase = ref('') // spawning | connecting | generating
const errorMsg = ref('')
const showSettings = ref(false)
const showHistory = ref(false)
const previewImage = ref('')

const settingsModalEl = ref(null)
const chatEl = ref(null)
const sidebarEl = ref(null)
const composerEl = ref(null)

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || '')
const historyKey = isMac ? '⌘K' : 'Ctrl K'

const { pendingKey: deleteConfirmId, confirm: confirmDelete, reset: resetDeleteConfirm } = useConfirm()
function requestDeleteSession(id) {
  confirmDelete(id, () => removeSession(id))
}

// 模型凭证状态
const defaultAuthOk = ref(null)
const needModelConfig = computed(() => {
  if (!piStatus.value || !piStatus.value.ok || !envInfo.value || !envInfo.value.ok) return false
  if (!envInfo.value.defaultModel && !(defaults.value && (defaults.value.modelId || defaults.value.modelName))) return true
  return defaultAuthOk.value === false
})

const onboardingState = computed(() => {
  if (!piStatus.value) return ''
  if (!piStatus.value.ok) {
    if (envInfo.value && envInfo.value.errorCode === 'NODE_MISSING') return 'need-node'
    return 'need-pi'
  }
  if (needModelConfig.value) return 'need-model'
  return ''
})

async function checkDefaultAuth(force) {
  const provider = (envInfo.value && envInfo.value.defaultProvider) || ''
  if (!provider || !window.piBridge || !window.piBridge.configAuthCheck) return
  const cacheKey = 'auth_' + provider.replace(/[^a-z0-9_-]/gi, '_')
  if (!force) {
    const cached = readCacheMeta(cacheKey)
    if (cached && cached.fresh && cached.data && cached.data.status) {
      const st = cached.data.status
      if (st === 'ready') { defaultAuthOk.value = true; return }
      if (st === 'not_ready' || st === 'invalid') { defaultAuthOk.value = false; return }
    }
  }
  try {
    const r = await window.piBridge.configAuthCheck(provider)
    const st = r && r.status
    if (st === 'ready') { defaultAuthOk.value = true; writeCache(cacheKey, { status: 'ready' }) }
    else if (st === 'not_ready' || st === 'invalid') { defaultAuthOk.value = false; writeCache(cacheKey, { status: st }) }
    else defaultAuthOk.value = null
  } catch (_) { defaultAuthOk.value = null }
}

function openSettingsTab(tabId, opts) {
  showSettings.value = true
  nextTick(() => {
    if (settingsModalEl.value && settingsModalEl.value.openTab) settingsModalEl.value.openTab(tabId, opts)
  })
}

function effectiveGroupCwd(g) {
  return (g && g.cwd) || defaultCwd.value || ''
}

const { toast, showToast, copyText } = useToast()
const {
  defaultCwd, setDefaultCwd, commitDefaultCwd, pickDefaultCwd,
  sendKeyMode, setSendKeyMode, displayCwd, clearCwdDisplayCache, layout, setLayout,
} = usePrefs({
  showToast,
  onCwdChange: () => {
    loadSkillsAsync()
    files.value = []
    if (engine.value === 'rpc') maybePrewarmRpc()
  },
})

const {
  models, skills, piStatus, engine, rpcStatus, defaults, envInfo, showEnvHelp,
  hydrateFromCache, loadDefaults, loadModelsAsync, refreshModels, loadSkillsAsync,
  loadEnvAsync, recheckEnv, installPi, prewarmActive, setEngine, openPath, openExternal,
  getLastSkillsCwd,
} = usePiEnv({
  getCwd: () => effectiveGroupCwd(activeGroup.value),
  getLean: () => ({ tool: toolForSend(activeGroup.value) }),
  showToast,
  copyText,
})

const activeCwdLabel = computed(() => displayCwd(activeGroup.value && activeGroup.value.cwd))

const sendKeyChip = computed(() => sendKeyMode.value === 'enter' ? 'Enter' : (isMac ? '⌘+↵' : 'Ctrl+↵'))
function toggleSendKey() {
  setSendKeyMode(sendKeyMode.value === 'enter' ? 'ctrl' : 'enter')
}
function maybePrewarmRpc() {
  if (engine.value !== 'rpc' || !window.piBridge || !window.piBridge.prewarmRpc) return
  prewarmActive().catch(() => {})
}

// 空态引导文案
const EMPTY_COPY = {
  chat: { desc: '纯文本对话，不带工具和项目规范', chips: ['解释这段代码', '给这个函数起个名字', '把这段话写得更简洁'] },
  translate: { desc: '自动识别中英文并互译，只输出译文', chips: ['帮我把下面这段技术文档翻成英文：\n', 'Translate the following paragraph:\n'] },
  agent: { desc: '默认只读工具，可在分组设置中按需放开编辑与命令执行', chips: ['看看这个项目的结构', '帮我定位这个报错', '写个脚本整理下载目录'] },
}
const emptyCopy = computed(() => {
  const g = activeGroup.value || {}
  const base = EMPTY_COPY[g.kind] || EMPTY_COPY.chat
  if (g.kind === 'translate' && g.targetLang && g.targetLang !== '中英互译') {
    return {
      desc: `把内容翻译成${g.targetLang}，只输出译文`,
      chips: [`把下面内容翻译成${g.targetLang}：\n`, '翻译下面这段话：\n'],
    }
  }
  return base
})
function fillChip(text) {
  inputText.value = text
  composerEl.value && composerEl.value.focusInput(text.length)
}

let currentAssistant = null
let runHandle = null
let cancelled = false
let finalized = false
let scrollScheduled = false
let historyFallbackNotified = false
let pendingConfigRestart = false

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
  if (pendingConfigRestart) {
    pendingConfigRestart = false
    restartEngineForConfig()
  }
}

function onEsc() {
  if (previewImage.value) { previewImage.value = ''; return }
  if (composerEl.value && composerEl.value.hasOpenMenu()) { composerEl.value.closeMenus(); return }
  if (showHistory.value) { showHistory.value = false; return }
  if (showSettings.value) {
    if (!(settingsModalEl.value && settingsModalEl.value.handleEsc())) showSettings.value = false
  }
}

function onEnterEvent(e) {
  const q = window.__pideckEnterQueue
  const i = q ? q.indexOf(e.detail) : -1
  if (i >= 0) q.splice(i, 1)
  handleEnter(e.detail || e)
}

let idleTimers = []
let unmounted = false
let initialMountDone = false

function scheduleIdle(fn, delay = 0) {
  const run = () => {
    if (unmounted) return
    if (typeof requestIdleCallback === 'function') {
      requestIdleCallback(() => { if (!unmounted) fn() }, { timeout: 1000 })
    } else {
      fn()
    }
  }
  const id = setTimeout(run, delay)
  idleTimers.push(id)
  return id
}

onMounted(() => {
  // T0：同步首帧水合与焦点就绪（零阻塞，不派生子进程、不扫描目录）
  if (window.piBridge && window.piBridge.getConfig) {
    engine.value = (window.piBridge.getConfig() || {}).engine || 'json'
  }
  window.addEventListener('pideck:enter', onEnterEvent)
  const queued = window.__pideckEnterQueue || []
  if (queued.length) {
    while (queued.length) onEnterEvent({ detail: queued[0] })
  } else {
    refreshSessions()
    restoreDraft()
  }
  const cacheState = hydrateFromCache()
  initialMountDone = true

  window.utools && window.utools.onPluginOut && window.utools.onPluginOut(isKill => {
    clearTimeout(draftTimer)
    saveCurrentDraft()
    if (isKill) {
      if (running.value) cancel()
      if (window.piBridge && window.piBridge.stopRpc) {
        try { window.piBridge.stopRpc() } catch (_) {}
      }
      rpcStatus.value = ''
      return
    }
    if (!running.value && window.piBridge && window.piBridge.stopRpc) {
      try { window.piBridge.stopRpc() } catch (_) {}
      rpcStatus.value = ''
    }
  })

  window.utools && window.utools.onDbPull && window.utools.onDbPull(() => {
    if (!running.value) sessions.value = listSessions(activeId.value)
  })

  composerEl.value && composerEl.value.focusInput()
  requestAnimationFrame(() => { composerEl.value && composerEl.value.focusInput() })
  window.addEventListener('keydown', onGlobalKey)

  // T1/T2：首帧绘制后异步探测环境，并按空闲优先级交错刷新，不争抢冷启动 CPU
  requestAnimationFrame(() => {
    setTimeout(async () => {
      if (unmounted) return
      await loadEnvAsync()
      if (unmounted) return

      if (envInfo.value && envInfo.value.ok) {
        if (engine.value === 'rpc') maybePrewarmRpc()
        if (!cacheState.skillsFresh) scheduleIdle(() => loadSkillsAsync(), 60)
        if (!cacheState.modelsFresh) scheduleIdle(() => loadModelsAsync(), engine.value === 'rpc' ? 280 : 120)
        if (!cacheState.defaultsFresh && !(defaults.value && (defaults.value.modelId || defaults.value.modelName))) {
          scheduleIdle(() => loadDefaults(), 450)
        }
        scheduleIdle(() => checkDefaultAuth(), 700)
      } else {
        if (!cacheState.skillsFresh) scheduleIdle(() => loadSkillsAsync(), 120)
      }
    }, 0)
  })
})

onUnmounted(() => {
  unmounted = true
  for (const id of idleTimers) clearTimeout(id)
  idleTimers = []
  window.removeEventListener('keydown', onGlobalKey)
  window.removeEventListener('pideck:enter', onEnterEvent)
  resetDeleteConfirm()
})

function onGlobalKey(e) {
  if (e.key === 'Escape') { onEsc(); return }
  const mod = e.ctrlKey || e.metaKey
  if (!mod) return
  if (e.key === 'k' || e.key === 'K') {
    e.preventDefault()
    if (layout.value === 'classic') { sidebarEl.value && sidebarEl.value.focusSearch(); return }
    if (showHistory.value) showHistory.value = false
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
let filesReqSeq = 0
async function refreshFiles() {
  if (!window.piBridge) return
  const seq = ++filesReqSeq
  const cwd = effectiveGroupCwd(activeGroup.value)
  if (window.piBridge.listFilesAsync) {
    filesLoading.value = true
    try {
      const list = await window.piBridge.listFilesAsync(cwd)
      if (seq === filesReqSeq) files.value = list || []
    } catch (_) {
      if (seq === filesReqSeq) files.value = []
    } finally {
      if (seq === filesReqSeq) filesLoading.value = false
    }
    return
  }
  if (window.piBridge.listFiles) {
    try { files.value = window.piBridge.listFiles(cwd) || [] } catch (_) { files.value = [] }
  }
}
function refreshSessions() {
  sessions.value = listSessions(activeId.value)
  currentSession.value = null
}

function handleEnter(action) {
  if (running.value) { showToast('当前回答生成中，请先停止'); return }
  const code = String(action.code || '')
  const type = String(action.type || '')
  const payload = action.payload

  if (code === 'translate') {
    const t = groups.value.find(g => g.kind === 'translate' || g.id === 'translate' || g.name === '翻译')
    if (t) selectGroup(t.id, { fromEnter: true })
    else showToast('未找到翻译分组，请在设置中创建')
  } else if (code === 'chat' || code === 'agent') {
    const t = groups.value.find(g => g.kind === code || g.id === code)
    if (t) selectGroup(t.id, { fromEnter: true })
  }

  sessionRiskConfirmed.value = false
  pendingRiskConfirm.value = false
  pendingRegenerate = false
  historyFallbackNotified = false
  files.value = []
  refreshSessions()
  resetPaging()
  showHistory.value = false
  if (initialMountDone && engine.value === 'rpc' && envInfo.value && envInfo.value.ok) maybePrewarmRpc()
  const curCwd = effectiveGroupCwd(activeGroup.value)
  if (getLastSkillsCwd && getLastSkillsCwd() !== null && getLastSkillsCwd() !== curCwd) {
    loadSkillsAsync()
  }

  inputText.value = ''
  const drafts = loadDrafts()
  if (drafts[activeId.value]) {
    drafts[activeId.value] = ''
    saveDrafts(drafts)
  }
  errorMsg.value = ''
  previewImage.value = ''
  images.value = []
  attachedFiles.value = []

  if ((type === 'over' || type === 'regex') && typeof payload === 'string') inputText.value = payload
  if (type === 'img' && payload) {
    const dataUrl = typeof payload === 'string'
      ? (payload.startsWith('data:') ? payload : payload.startsWith('file:') || /^[A-Za-z]:[\\/]/.test(payload) ? '' : 'data:image/png;base64,' + payload)
      : (payload.dataUrl || (payload.base64 ? 'data:image/png;base64,' + payload.base64 : ''))
    if (dataUrl) addImage(dataUrl)
    else if (typeof payload === 'string' && payload) addAttachedFile(payload)
  }
  if (type === 'files' && Array.isArray(payload)) {
    for (const p of payload) addAttachedFile(p && p.path ? p.path : p)
  }
  composerEl.value && composerEl.value.focusInput()
}

function selectGroup(id, opts) {
  const fromEnter = !!(opts && opts.fromEnter)
  if (running.value || id === activeId.value) {
    if (running.value && id !== activeId.value) showToast('先停止当前回答再切换分组')
    return
  }
  if (!fromEnter) saveCurrentDraft()
  activeId.value = id
  if (fromEnter) return
  sessionRiskConfirmed.value = false
  pendingRiskConfirm.value = false
  pendingRegenerate = false
  loadSkillsAsync()
  historyFallbackNotified = false
  files.value = []
  refreshSessions()
  restoreDraft()
  if (engine.value === 'rpc') maybePrewarmRpc()
}
watch(activeId, id => saveActiveId(id))

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

function loadSession(id) {
  if (running.value) return
  const s = getSession(id)
  if (!s) return
  currentSession.value = s
  errorMsg.value = ''
  sessionRiskConfirmed.value = false
  pendingRiskConfirm.value = false
  pendingRegenerate = false
  historyFallbackNotified = false
  resetPaging()
  showHistory.value = false
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
  const kept = !!(inputText.value.trim() || images.value.length || attachedFiles.value.length)
  currentSession.value = null
  resetPaging()
  errorMsg.value = ''
  sessionRiskConfirmed.value = false
  pendingRiskConfirm.value = false
  pendingRegenerate = false
  historyFallbackNotified = false
  showHistory.value = false
  if (kept) showToast('已开始新对话，输入内容已保留')
  composerEl.value && composerEl.value.focusInput()
}

function removeSession(id) {
  if (running.value) { showToast('请先停止当前回答'); return }
  const s = getSession(id)
  if (!s) return
  deleteSession(id)
  if (s.piSessionId && window.piBridge && window.piBridge.deletePiSession) {
    try { window.piBridge.deletePiSession(s.piSessionId) } catch (_) {}
  }
  sessions.value = listSessions(activeId.value)
  if (currentSession.value && currentSession.value.id === id) {
    currentSession.value = sessions.value.length ? getSession(sessions.value[0].id) : null
  }
  if (!sessions.value.length) showHistory.value = false
}

function exportCurrent() {
  if (!currentSession.value) return showToast('没有可导出的会话')
  const md = exportMarkdown(currentSession.value)
  const name = `${(currentSession.value.title || 'session').replace(/[\\/:*?"<>|]/g, '_')}.md`
  if (window.piBridge && window.piBridge.saveTextFile) {
    const r = window.piBridge.saveTextFile(name, md)
    if (r && r.ok) return showToast('已保存：' + r.path)
    if (r && r.canceled) return
    if (r && !r.unsupported) return showToast('保存失败：' + (r.error || '未知错误'))
  }
  const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url; a.download = name
  a.click()
  URL.revokeObjectURL(url)
  showToast('已导出 Markdown')
}

function addImage(dataUrl) {
  if (!dataUrl || images.value.some(i => i.dataUrl === dataUrl)) return
  images.value.push({ name: 'pasted-image', dataUrl })
}
function addAttachedFile(filePath) {
  const p = String(filePath || '').trim()
  if (p && !attachedFiles.value.includes(p)) attachedFiles.value.push(p)
}
let pendingImageReads = []
function readImageFile(file) {
  const MAX = 20 * 1024 * 1024
  if (file.size > MAX) { showToast(`图片过大（${(file.size / 1048576).toFixed(1)}MB），上限 20MB`); return }
  const readTask = new Promise(resolve => {
    const reader = new FileReader()
    reader.onload = () => { addImage(reader.result); resolve() }
    reader.onerror = () => { showToast('图片读取失败'); resolve() }
    reader.readAsDataURL(file)
  })
  pendingImageReads.push(readTask)
  readTask.finally(() => { pendingImageReads = pendingImageReads.filter(p => p !== readTask) })
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

const sessionRiskConfirmed = ref(false)
const pendingRiskConfirm = ref(false)
let pendingRegenerate = false
const riskSummaryText = computed(() => activeRiskSummary(activeGroup.value && activeGroup.value.tool))

function confirmRiskSend() {
  sessionRiskConfirmed.value = true
  pendingRiskConfirm.value = false
  if (pendingRegenerate) {
    pendingRegenerate = false
    regenerate()
  } else {
    send()
  }
}
function cancelRiskSend() {
  pendingRiskConfirm.value = false
  pendingRegenerate = false
}

function buildPromptText(g, userText) {
  let prefix = (g.prompt && g.prompt.trim()) ? g.prompt.trim() : ''
  const lang = (g.targetLang || '').trim()
  if (lang === '中英互译') prefix += '\n目标语言：若输入主要为中文则译为英文，若为外文则译为中文。'
  else if (lang) prefix += `\n目标语言：${lang}`
  return prefix
    ? `${prefix}\n\n---\n\n${userText || '请处理上方附带的内容。'}`
    : (userText || '请描述这张图片。')
}

function dispatchRun(session, g, { prompt, promptPreview, sendFiles, hadHistory }) {
  cancelled = false
  finalized = false
  running.value = true
  runPhase.value = 'spawning'
  scrollChat(true)
  composerEl.value && composerEl.value.focusInput()

  try {
    runHandle = window.piBridge.run(
      {
        prompt, model: g.model || '', thinking: g.thinking || '', cwd: g.cwd || '', files: sendFiles,
        sessionId: session.piSessionId,
        tool: g.tool,
        groupId: activeId.value,
        groupName: (activeGroup.value && activeGroup.value.name) || '',
        promptPreview,
        hasLocalHistory: hadHistory,
      },
      {
        onEvent: rec => {
          if (finalized) return
          if ((rec.type === 'agent_start' || rec.type === 'turn_start') && runPhase.value === 'spawning') {
            runPhase.value = 'connecting'
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
        onUsage: usage => { if (!finalized) session.usage = usage },
        onDone: payload => finalize(!!(payload && payload.aborted), ''),
        onError: msg => finalize(cancelled, cancelled ? '' : msg),
      },
    )
    if (runHandle && runHandle.mode === 'json' && engine.value === 'rpc' && hadHistory && !historyFallbackNotified) {
      historyFallbackNotified = true
      showToast(runHandle.sessionResumed === false
        ? '极速模式不跨会话保留上下文，本条作为新对话开始'
        : '历史会话已自动使用标准模式续接上下文')
    }
  } catch (e) {
    finalize(false, String(e.message || e))
  }
}

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
  if (isRiskyTool(activeGroup.value && activeGroup.value.tool) && !sessionRiskConfirmed.value) {
    pendingRegenerate = false
    pendingRiskConfirm.value = true
    return
  }
  pendingRiskConfirm.value = false
  const userText = inputText.value.trim()
  const outImages = [...images.value]
  const outFiles = [...attachedFiles.value]
  const g = snapshotConfig(activeGroup.value)

  const sendFiles = [...outFiles]
  const imagePaths = []
  for (const img of outImages) {
    try { const p = window.piBridge.saveImage(img.dataUrl); imagePaths.push(p); sendFiles.push(p) }
    catch (e) { errorMsg.value = String(e.message || e); return }
  }

  if (!currentSession.value || currentSession.value.groupId !== activeId.value) {
    currentSession.value = createSession(activeId.value, g)
    sessions.value = listSessions(activeId.value)
    resetPaging()
  }
  const session = currentSession.value
  const hadHistory = session.messages.length > 0

  const prompt = buildPromptText(g, userText)
  const fileNames = outFiles.map(f => String(f).split(/[\\/]/).pop()).filter(Boolean)
  const imageRefs = outImages.length ? { imageCount: outImages.length, imagePaths } : {}
  const fileRefs = fileNames.length ? { fileNames, filePaths: outFiles } : {}
  const fallbackUserText = outImages.length ? '(图片)' : '(附件)'
  session.messages.push({ role: 'user', text: userText || fallbackUserText, ...imageRefs, ...fileRefs })
  if (session.title === '新对话') session.title = titleFromText(userText || fallbackUserText)
  currentAssistant = { role: 'assistant', text: '', thinking: '', tools: [], error: '', aborted: false }
  session.messages.push(currentAssistant)
  updateSession(session.id, { config: { ...g }, messages: session.messages, title: session.title })

  inputText.value = ''
  images.value = []
  attachedFiles.value = []
  errorMsg.value = ''
  composerEl.value && composerEl.value.closeMenus()
  const d = loadDrafts()
  if (d[activeId.value]) { d[activeId.value] = ''; saveDrafts(d) }

  dispatchRun(session, g, {
    prompt,
    promptPreview: userText.slice(0, 80),
    sendFiles,
    hadHistory,
  })
}

function regenerate() {
  if (running.value || !currentSession.value) return
  if (!window.piBridge || !window.piBridge.run) return
  const msgs = currentSession.value.messages || []
  let userIdx = -1
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i] && msgs[i].role === 'user') { userIdx = i; break }
  }
  if (userIdx < 0) return
  if (isRiskyTool(activeGroup.value && activeGroup.value.tool) && !sessionRiskConfirmed.value) {
    pendingRegenerate = true
    pendingRiskConfirm.value = true
    return
  }
  const userMsg = msgs[userIdx]
  const rawUserText = (userMsg.text === '(图片)' || userMsg.text === '(附件)') ? '' : (userMsg.text || '')
  const sendFiles = [...new Set([
    ...(Array.isArray(userMsg.filePaths) ? userMsg.filePaths : []),
    ...(Array.isArray(userMsg.imagePaths) ? userMsg.imagePaths : []),
  ].filter(Boolean))]
  const g = snapshotConfig(activeGroup.value)

  // 移除上一轮末尾的 assistant 回复并新建一条占位
  currentSession.value.messages.splice(userIdx + 1)
  currentAssistant = { role: 'assistant', text: '', thinking: '', tools: [], error: '', aborted: false }
  currentSession.value.messages.push(currentAssistant)
  updateSession(currentSession.value.id, { config: { ...g }, messages: currentSession.value.messages })

  dispatchRun(currentSession.value, g, {
    prompt: buildPromptText(g, rawUserText),
    promptPreview: rawUserText.slice(0, 80),
    sendFiles,
    hadHistory: userIdx > 0,
  })
}

function persistCurrent() {
  if (currentSession.value) {
    updateSession(currentSession.value.id, { messages: currentSession.value.messages, usage: currentSession.value.usage })
  }
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
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80
    if (force || nearBottom) el.scrollTop = el.scrollHeight
  })
}
function scrollChatThrottled() {
  if (scrollScheduled) return
  scrollScheduled = true
  requestAnimationFrame(() => { scrollScheduled = false; scrollChat(false) })
}
const usageLine = computed(() => {
  const u = currentSession.value && currentSession.value.usage
  if (!u || !u.totalTokens) return ''
  const c = u.cost && Number(u.cost.total)
  const cost = c ? ` · $${c.toFixed(4)}` : ''
  return `${u.totalTokens} tokens${cost}`
})

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
    t.skillPaths = (t.skillNames || []).map(n => (pool.find(x => x.name === n) || {}).dir).filter(Boolean)
  } else {
    t.skillPaths = []
  }
  return t
}

function onSaveGroup(next, silent) {
  const idx = groups.value.findIndex(g => g.id === next.id)
  const prev = idx >= 0 ? groups.value[idx] : null
  const prevPerm = prev ? toolSummary(prev.tool) : ''
  const nextPerm = toolSummary(next.tool)
  const permChanged = !prev || prevPerm !== nextPerm
  const cwdChanged = !prev || (prev.cwd || '') !== (next.cwd || '')

  if (idx >= 0) groups.value.splice(idx, 1, next)
  else groups.value.push(next)
  saveGroups(groups.value)
  if (!silent) showToast('设置已保存')
  if (permChanged && window.piBridge && window.piBridge.auditRecord) {
    try {
      window.piBridge.auditRecord({ type: 'perm', groupId: next.id, groupName: next.name, perm: nextPerm })
    } catch (_) {}
  }
  if (cwdChanged || permChanged) {
    if (cwdChanged) clearCwdDisplayCache()
    loadSkillsAsync()
    files.value = []
  }
  if (next.id === activeId.value && (permChanged || cwdChanged)) {
    sessionRiskConfirmed.value = false
    pendingRiskConfirm.value = false
    if (engine.value === 'rpc') maybePrewarmRpc()
  }
}

function onQuickUpdateGroup(patch) {
  if (!activeGroup.value || running.value) return
  onSaveGroup({ ...activeGroup.value, ...patch }, true)
  showToast('已更新当前分组配置')
}

function pickGroupCwd() {
  if (!activeGroup.value || running.value) return
  if (window.utools && typeof window.utools.showOpenDialog === 'function' && window.piBridge && window.piBridge.pickFolder) {
    const dir = window.piBridge.pickFolder()
    if (dir) onQuickUpdateGroup({ cwd: dir })
    return
  }
  openSettingsTab('groups', { editGroupId: activeGroup.value.id })
}

function onDeleteGroup(g) {
  if (groups.value.length <= 1) return
  const list = listSessions(g.id)
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
  showSettings.value = false
}

function clearAllConversations() {
  if (running.value) { showToast('请先停止当前回答'); return }
  const list = clearAllSessions()
  for (const s of list) {
    if (s.piSessionId && window.piBridge && window.piBridge.deletePiSession) {
      try { window.piBridge.deletePiSession(s.piSessionId) } catch (_) {}
    }
  }
  currentSession.value = null
  sessions.value = []
  showHistory.value = false
  if (window.piBridge && window.piBridge.auditRecord) {
    try { window.piBridge.auditRecord({ type: 'data', action: 'clear-sessions' }) } catch (_) {}
  }
  showToast(`已清空 ${list.length} 个对话`)
}

function restartEngineForConfig() {
  if (window.piBridge && window.piBridge.stopRpc) { try { window.piBridge.stopRpc() } catch (_) {} }
  rpcStatus.value = ''
  refreshModels()
  loadDefaults(true)
  loadEnvAsync().then(() => {
    setTimeout(() => checkDefaultAuth(true), 250)
    if (engine.value === 'rpc') maybePrewarmRpc()
  })
}
function onConfigSaved() {
  if (running.value) {
    pendingConfigRestart = true
    showToast('新配置将在当前回答结束后生效')
    return
  }
  restartEngineForConfig()
}
</script>

<template>
  <div class="app" :class="'layout-' + layout">
    <EnvBanner
      :pi-status="piStatus"
      :env-info="envInfo"
      :show-env-help="showEnvHelp"
      :needs-config="needModelConfig"
      @toggle-help="showEnvHelp = !showEnvHelp"
      @recheck="recheckEnv"
      @install-pi="installPi"
      @config="openSettingsTab('diag')"
      @open-link="openExternal"
      @copy-cmd="copyText"
      @open-path="openPath"
    />

    <div class="shell">
      <Sidebar
        v-if="layout === 'classic'"
        ref="sidebarEl"
        :groups="groups"
        :active-id="activeId"
        :sessions="sessions"
        :current-session-id="currentSession ? currentSession.id : ''"
        :confirm-delete-id="deleteConfirmId"
        @new-chat="newChat"
        @select-group="selectGroup"
        @load-session="loadSession"
        @request-delete-session="requestDeleteSession"
        @export-current="exportCurrent"
        @open-settings="showSettings = true"
        @switch-layout="setLayout('console')"
      />

      <div class="shell-main">
        <TopRail
          v-if="layout === 'console'"
          :groups="groups"
          :active-id="activeId"
          :history-key="historyKey"
          @select-group="selectGroup"
          @new-chat="newChat"
          @open-history="openHistory"
          @export-current="exportCurrent"
          @switch-layout="setLayout('classic')"
          @open-settings="showSettings = true"
        />

        <header v-else class="panel-head">
          <span class="panel-title">{{ activeGroup && activeGroup.name }}</span>
          <StatusReadout
            v-if="activeGroup"
            variant="header"
            :group="activeGroup"
            :models="models"
            :defaults="defaults"
            :cwd-label="activeCwdLabel"
            :engine="engine"
            :rpc-status="rpcStatus"
            :disabled="running"
            @update-group="onQuickUpdateGroup"
            @pick-cwd="pickGroupCwd"
            @open-group-settings="openSettingsTab('groups', { editGroupId: activeGroup.id })"
          />
        </header>

        <div ref="chatEl" class="chat">
          <TurnList
            :variant="layout"
            :session-id="currentSession ? currentSession.id : ''"
            :visible="visibleMessages"
            :total="messages.length"
            :hidden-count="hiddenCount"
            :page-size="PAGE_SIZE"
            :running="running"
            :run-phase="runPhase"
            :usage="usageLine"
            :error="errorMsg"
            :empty-desc="emptyCopy.desc"
            :chips="emptyCopy.chips"
            :send-key-chip="sendKeyChip"
            :onboarding-state="onboardingState"
            :env-info="envInfo"
            @earlier="showEarlier"
            @chip="fillChip"
            @copy="copyText"
            @link="openExternal"
            @preview="previewImage = $event"
            @regenerate="regenerate"
            @install-pi="installPi"
            @open-config="openSettingsTab('diag')"
            @recheck-env="recheckEnv"
          />
        </div>

        <Composer
          ref="composerEl"
          v-model="inputText"
          :variant="layout"
          :images="images"
          :attached-files="attachedFiles"
          :skills="skills"
          :files="files"
          :files-loading="filesLoading"
          :active-group="activeGroup"
          :models="models"
          :defaults="defaults"
          :cwd-label="activeCwdLabel"
          :engine="engine"
          :rpc-status="rpcStatus"
          :running="running"
          :send-key-mode="sendKeyMode"
          :is-mac="isMac"
          :pending-risk-confirm="pendingRiskConfirm"
          :active-risk-summary="riskSummaryText"
          @send="send"
          @cancel="cancel"
          @confirm-risk="confirmRiskSend"
          @cancel-risk="cancelRiskSend"
          @read-image-file="readImageFile"
          @remove-image="images.splice($event, 1)"
          @add-file="addAttachedFile"
          @remove-file="attachedFiles.splice($event, 1)"
          @request-files="refreshFiles"
          @preview="previewImage = $event"
          @toggle-send-key="toggleSendKey"
          @update-group="onQuickUpdateGroup"
          @pick-cwd="pickGroupCwd"
          @open-group-settings="activeGroup && openSettingsTab('groups', { editGroupId: activeGroup.id })"
          @notify="showToast"
        />
      </div>
    </div>

    <HistoryDrawer
      v-if="showHistory"
      :show="showHistory"
      :sessions="sessions"
      :current-session-id="currentSession ? currentSession.id : ''"
      :confirm-delete-id="deleteConfirmId"
      @close="showHistory = false"
      @select="loadSession"
      @request-remove="requestDeleteSession"
    />

    <SettingsModal
      v-if="showSettings"
      ref="settingsModalEl"
      :show="showSettings"
      :groups="groups"
      :models="models"
      :skills="skills"
      :defaults="defaults"
      :env-info="envInfo"
      :engine="engine"
      :rpc-status="rpcStatus"
      :layout="layout"
      :default-cwd="defaultCwd"
      :send-key-mode="sendKeyMode"
      :is-mac="isMac"
      :display-cwd="displayCwd"
      @close="showSettings = false"
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
      @install-pi="installPi"
      @clear-all-sessions="clearAllConversations"
      @config-saved="onConfigSaved"
      @notify="showToast"
      @copy-cmd="copyText"
      @open-link="openExternal"
    />

    <div v-if="previewImage" class="lightbox" @click.self="previewImage = ''">
      <button class="lightbox-close" @click="previewImage = ''" title="关闭（Esc）"><Icon name="close" :size="16" /></button>
      <img :src="previewImage" alt="图片预览" @click.stop />
    </div>

    <div v-if="toast" class="toast">{{ toast }}</div>
  </div>
</template>

<style src="./main.css"></style>
