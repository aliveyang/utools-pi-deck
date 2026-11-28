<script setup>
import { ref, computed, onMounted, onUnmounted, nextTick, watch } from 'vue'
import { loadGroups, saveGroups, saveActiveId, loadDrafts, saveDrafts, TOOL_PRESETS } from './groups.js'
import { readCacheMetaAsync, readLocalAsync, writeCache, loadPrefsBundle, savePrefsBundle } from './storage.js'
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
  clearAllSessions, collectSessionImagePaths, titleFromText, exportMarkdown,
} from './sessions.js'
import { useToast } from './composables/useToast.js'
import { usePrefs } from './composables/usePrefs.js'
import { usePiEnv } from './composables/usePiEnv.js'
import { useConfirm } from './composables/useConfirm.js'

const groups = ref(loadGroups())
const { prefs: initialPrefs, needsMigration: prefsNeedMigration } = loadPrefsBundle()

function matchGroupIdForEnterCode(code, list) {
  if (code === 'translate') {
    const t = list.find(g => g.kind === 'translate' || g.id === 'translate' || g.name === '翻译')
    return t ? t.id : ''
  }
  if (code === 'chat' || code === 'agent') {
    const t = list.find(g => g.kind === code || g.id === code)
    return t ? t.id : ''
  }
  return ''
}

const queuedEnterInit = typeof window !== 'undefined' ? window.__pideckEnterQueue : null
const initEnterTarget = (queuedEnterInit && queuedEnterInit.length)
  ? matchGroupIdForEnterCode(String((queuedEnterInit[queuedEnterInit.length - 1] || {}).code || ''), groups.value)
  : ''
const resolvedInitId = initEnterTarget || (groups.value.some(g => g.id === initialPrefs.activeId) ? initialPrefs.activeId : (groups.value[0] && groups.value[0].id) || 'chat')
const activeId = ref(resolvedInitId)
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
    const cached = await readCacheMetaAsync(cacheKey)
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
const workspaceAuthRev = ref(0)
function bumpWorkspaceAuth() { workspaceAuthRev.value++ }
const {
  defaultCwd, setDefaultCwd, pickDefaultCwd,
  sendKeyMode, setSendKeyMode, displayCwd, clearCwdDisplayCache, layout, setLayout,
} = usePrefs({
  initialPrefs,
  showToast,
  onCwdChange: () => {
    bumpWorkspaceAuth()
    if (errorMsg.value && errorMsg.value.includes('尚未在本机授权')) errorMsg.value = ''
    loadSkillsAsync()
    files.value = []
    if (engine.value === 'rpc') maybePrewarmRpc()
  },
})

const {
  models, skills, piStatus, engine, rpcStatus, defaults, envInfo, showEnvHelp,
  hydrateFromCacheAsync, loadDefaults, loadModelsAsync, refreshModels, loadSkillsAsync,
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
let pendingTextDelta = ''
let pendingThinkingDelta = ''
let deltaRafId = 0

function flushStreamDeltas() {
  if (deltaRafId) {
    if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(deltaRafId)
    else clearTimeout(deltaRafId)
    deltaRafId = 0
  }
  if (!currentAssistant) {
    pendingTextDelta = ''
    pendingThinkingDelta = ''
    return
  }
  if (pendingTextDelta) {
    currentAssistant.text += pendingTextDelta
    pendingTextDelta = ''
    scrollChatThrottled()
  }
  if (pendingThinkingDelta) {
    currentAssistant.thinking += pendingThinkingDelta
    pendingThinkingDelta = ''
  }
}

function scheduleDeltaFlush() {
  if (deltaRafId) return
  if (typeof requestAnimationFrame === 'function') {
    deltaRafId = requestAnimationFrame(() => {
      deltaRafId = 0
      flushStreamDeltas()
    })
  } else {
    deltaRafId = setTimeout(() => {
      deltaRafId = 0
      flushStreamDeltas()
    }, 16)
  }
}

function finalize(aborted, error) {
  if (finalized) return
  finalized = true
  flushStreamDeltas()
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

function onEnterEvent(e, opts) {
  const q = window.__pideckEnterQueue
  const i = q ? q.indexOf(e.detail) : -1
  if (i >= 0) q.splice(i, 1)
  handleEnter(e.detail || e, opts)
}

let idleTimers = []
let unmounted = false
let initialMountDone = false
let enteredOnMount = false
let enteredGroupId = ''
let userTouchedInput = false
let restoringDraft = false

function perfNow() {
  return (typeof performance !== 'undefined' && typeof performance.now === 'function') ? performance.now() : Date.now()
}

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
  // T0：仅做内存态就绪与聚焦（零同步磁盘 I/O、零额外同步 IPC）
  window.addEventListener('pideck:enter', onEnterEvent)
  const queued = window.__pideckEnterQueue || []
  if (queued.length) {
    enteredOnMount = true
    while (queued.length) onEnterEvent({ detail: queued[0] }, { deferIo: true })
    enteredGroupId = activeId.value
  }

  window.utools && window.utools.onPluginOut && window.utools.onPluginOut(isKill => {
    syncDraftInMemory()
    flushDraft()
    if (isKill) {
      if (running.value) cancel()
      if (window.piBridge && window.piBridge.stopRpc) {
        try { window.piBridge.stopRpc() } catch (_) {}
      }
      rpcStatus.value = ''
    }
    // 窗口失焦隐藏（isKill=false）时保留空闲 RPC 进程，交由 5 分钟 IDLE_TTL 自动回收
  })

  window.utools && window.utools.onDbPull && window.utools.onDbPull(() => {
    if (!running.value) sessions.value = listSessions(activeId.value)
  })

  composerEl.value && composerEl.value.focusInput()
  requestAnimationFrame(() => { composerEl.value && composerEl.value.focusInput() })
  window.addEventListener('keydown', onGlobalKey)
  document.addEventListener('visibilitychange', onVisibilityChange)
  window.addEventListener('beforeunload', onBeforeUnload)
  initialMountDone = true

  // T1/T2：首帧绘制后异步水合会话、草稿、缓存与环境，不阻塞 did-finish-load
  requestAnimationFrame(() => {
    const perf = window.__pideckPerf = window.__pideckPerf || {}
    perf.firstPaint = perfNow()
    if (typeof perf.preloadStart === 'number') {
      perf.toFirstPaintMs = Number((perf.firstPaint - perf.preloadStart).toFixed(2))
    }

    setTimeout(async () => {
      if (unmounted) return

      if (prefsNeedMigration) {
        savePrefsBundle({
          defaultCwd: defaultCwd.value,
          sendKey: sendKeyMode.value,
          layout: layout.value,
          activeId: activeId.value,
        })
      } else if (activeId.value !== initialPrefs.activeId) {
        saveActiveId(activeId.value)
      }

      const [cfg, cacheState, drafts] = await Promise.all([
        (window.piBridge && window.piBridge.getConfigAsync)
          ? window.piBridge.getConfigAsync().catch(() => ({}))
          : Promise.resolve((window.piBridge && window.piBridge.getConfig) ? (window.piBridge.getConfig() || {}) : {}),
        hydrateFromCacheAsync(),
        readLocalAsync('pideck.drafts.v1', {}),
      ])
      if (unmounted) return

      engine.value = (cfg && cfg.engine) || 'json'
      // 仅刷新索引列表，不重置 currentSession，避免用户首帧已开始对话时被清屏
      sessions.value = listSessions(activeId.value)

      const baseDrafts = (drafts && typeof drafts === 'object' && !Array.isArray(drafts)) ? drafts : {}
      draftCache = draftLoaded ? { ...baseDrafts, ...draftCache } : { ...baseDrafts }
      draftLoaded = true

      if (enteredOnMount) {
        const targetDraftId = enteredGroupId || activeId.value
        if (draftCache[targetDraftId]) {
          draftCache[targetDraftId] = ''
          draftDirty = true
          flushDraft()
        }
      } else if (!userTouchedInput && !inputText.value && draftCache[activeId.value]) {
        restoringDraft = true
        inputText.value = draftCache[activeId.value]
        restoringDraft = false
      }

      perf.hydrated = perfNow()
      if (typeof perf.preloadStart === 'number') {
        perf.toHydratedMs = Number((perf.hydrated - perf.preloadStart).toFixed(2))
      }

      await loadEnvAsync()
      if (unmounted) return

      perf.envReady = perfNow()
      if (typeof perf.preloadStart === 'number') {
        perf.toEnvReadyMs = Number((perf.envReady - perf.preloadStart).toFixed(2))
      }

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

function onVisibilityChange() {
  if (document.hidden) {
    syncDraftInMemory()
    flushDraft()
  }
}
function onBeforeUnload() {
  syncDraftInMemory()
  flushDraft()
}

onUnmounted(() => {
  unmounted = true
  for (const id of idleTimers) clearTimeout(id)
  idleTimers = []
  if (deltaRafId) {
    if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(deltaRafId)
    else clearTimeout(deltaRafId)
    deltaRafId = 0
  }
  clearTimeout(draftTimer)
  draftTimer = null
  syncDraftInMemory()
  flushDraft()
  window.removeEventListener('keydown', onGlobalKey)
  document.removeEventListener('visibilitychange', onVisibilityChange)
  window.removeEventListener('beforeunload', onBeforeUnload)
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
  if (!window.piBridge || !window.piBridge.listFilesAsync) return
  const seq = ++filesReqSeq
  const cwd = effectiveGroupCwd(activeGroup.value)
  filesLoading.value = true
  try {
    const list = await window.piBridge.listFilesAsync(cwd)
    if (seq === filesReqSeq) files.value = list || []
  } catch (_) {
    if (seq === filesReqSeq) files.value = []
  } finally {
    if (seq === filesReqSeq) filesLoading.value = false
  }
}
function refreshSessions() {
  sessions.value = listSessions(activeId.value)
  currentSession.value = null
}

function handleEnter(action, opts) {
  if (running.value) { showToast('当前回答生成中，请先停止'); return }
  const deferIo = !!(opts && opts.deferIo)
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
  if (!deferIo) refreshSessions()
  resetPaging()
  showHistory.value = false
  if (initialMountDone && engine.value === 'rpc' && envInfo.value && envInfo.value.ok) maybePrewarmRpc()
  const curCwd = effectiveGroupCwd(activeGroup.value)
  if (getLastSkillsCwd && getLastSkillsCwd() !== null && getLastSkillsCwd() !== curCwd) {
    loadSkillsAsync()
  }

  inputText.value = ''
  if (!deferIo) {
    const cache = ensureDraftCache()
    if (cache[activeId.value]) {
      cache[activeId.value] = ''
      draftDirty = true
      flushDraft()
    }
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
  if (!fromEnter) {
    syncDraftInMemory()
    flushDraft()
  }
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
watch(activeId, id => {
  if (!initialMountDone) return
  saveActiveId(id)
})

const DRAFT_DEBOUNCE_MS = 5000
let draftTimer = null
let draftCache = {}
let draftLoaded = false
let draftDirty = false

function ensureDraftCache() {
  if (!draftLoaded) {
    draftCache = { ...loadDrafts() }
    draftLoaded = true
  }
  return draftCache
}
function syncDraftInMemory() {
  const cache = ensureDraftCache()
  const nextVal = inputText.value || ''
  if ((cache[activeId.value] || '') !== nextVal) {
    cache[activeId.value] = nextVal
    draftDirty = true
  }
}
function flushDraft() {
  clearTimeout(draftTimer)
  draftTimer = null
  if (!draftDirty) return
  draftDirty = false
  saveDrafts({ ...ensureDraftCache() })
}

watch(inputText, () => {
  if (restoringDraft) return
  if (initialMountDone) userTouchedInput = true
  syncDraftInMemory()
  if (!draftDirty) return
  clearTimeout(draftTimer)
  draftTimer = setTimeout(flushDraft, DRAFT_DEBOUNCE_MS)
})
function restoreDraft() {
  const cache = ensureDraftCache()
  restoringDraft = true
  inputText.value = cache[activeId.value] || ''
  restoringDraft = false
}

function loadSession(id) {
  if (running.value) return
  const s = getSession(id)
  if (!s) return
  syncDraftInMemory()
  flushDraft()
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
  syncDraftInMemory()
  flushDraft()
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
  const imgPaths = collectSessionImagePaths(s)
  if (imgPaths.length && window.piBridge && window.piBridge.deleteImages) {
    try { window.piBridge.deleteImages(imgPaths) } catch (_) {}
  }
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

function dispatchRun(session, g, { prompt, promptPreview, sendFiles, hadHistory }, opts) {
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
          pendingTextDelta += delta
          scheduleDeltaFlush()
        },
        onThinking: delta => {
          if (finalized || !currentAssistant) return
          if (runPhase.value !== 'generating') runPhase.value = 'generating'
          pendingThinkingDelta += delta
          scheduleDeltaFlush()
        },
        onTool: (phase, name, payload, id) => {
          if (finalized || !currentAssistant) return
          flushStreamDeltas()
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
    return true
  } catch (e) {
    if (opts && opts.rollbackOnSyncError) {
      running.value = false
      runPhase.value = ''
      currentAssistant = null
      runHandle = null
      errorMsg.value = String(e.message || e)
      return false
    }
    finalize(false, String(e.message || e))
    return false
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
  const targetCwd = effectiveGroupCwd(activeGroup.value)
  if (targetCwd && window.piBridge.isWorkspaceApproved && !window.piBridge.isWorkspaceApproved(targetCwd)) {
    errorMsg.value = `工作目录「${targetCwd}」尚未在本机授权，请点击顶部目录或设置中的「选择」重新授权`
    showToast('工作目录尚未在本机授权，请重新选择')
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
    catch (e) {
      if (imagePaths.length && window.piBridge && window.piBridge.deleteImages) {
        try { window.piBridge.deleteImages(imagePaths) } catch (_) {}
      }
      errorMsg.value = String(e.message || e)
      return
    }
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
  session.messages.push({ role: 'assistant', text: '', thinking: '', tools: [], error: '', aborted: false })
  currentAssistant = session.messages[session.messages.length - 1]
  updateSession(session.id, { config: { ...g }, messages: session.messages, title: session.title })

  inputText.value = ''
  images.value = []
  attachedFiles.value = []
  errorMsg.value = ''
  composerEl.value && composerEl.value.closeMenus()
  const cache = ensureDraftCache()
  if (cache[activeId.value]) {
    cache[activeId.value] = ''
    draftDirty = true
    flushDraft()
  }

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
  const targetCwd = effectiveGroupCwd(activeGroup.value)
  if (targetCwd && window.piBridge.isWorkspaceApproved && !window.piBridge.isWorkspaceApproved(targetCwd)) {
    errorMsg.value = `工作目录「${targetCwd}」尚未在本机授权，请点击顶部目录或设置中的「选择」重新授权`
    showToast('工作目录尚未在本机授权，请重新选择')
    return
  }
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

  // 先尝试启动运行，同步校验失败时恢复原回答，避免误删历史结果
  const prevTail = currentSession.value.messages.slice(userIdx + 1)
  currentSession.value.messages.splice(userIdx + 1)
  currentSession.value.messages.push({ role: 'assistant', text: '', thinking: '', tools: [], error: '', aborted: false })
  currentAssistant = currentSession.value.messages[currentSession.value.messages.length - 1]

  const started = dispatchRun(currentSession.value, g, {
    prompt: buildPromptText(g, rawUserText),
    promptPreview: rawUserText.slice(0, 80),
    sendFiles,
    hadHistory: userIdx > 0,
  }, { rollbackOnSyncError: true })
  if (!started) {
    currentSession.value.messages.splice(userIdx + 1, currentSession.value.messages.length - (userIdx + 1), ...prevTail)
    showToast('重新生成失败，已保留原回答')
    return
  }
  updateSession(currentSession.value.id, { config: { ...g }, messages: currentSession.value.messages })
}

function persistCurrent() {
  if (currentSession.value) {
    updateSession(currentSession.value.id, { messages: currentSession.value.messages, usage: currentSession.value.usage })
  }
}
function refreshSessionsKeep() {
  sessions.value = listSessions(activeId.value)
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
  t.skillPaths = t.skills === 'some'
    ? (t.skillNames || []).map(n => (skills.value.find(x => x.name === n) || {}).dir).filter(Boolean)
    : []
  return t
}

function onSaveGroup(next, silent, opts) {
  const forceRefreshEnv = !!(opts && opts.forceRefreshEnv)
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
  if (cwdChanged || permChanged || forceRefreshEnv) {
    if (cwdChanged || forceRefreshEnv) clearCwdDisplayCache()
    loadSkillsAsync()
    files.value = []
  }
  if (next.id === activeId.value) {
    const curCwd = effectiveGroupCwd(next)
    if (errorMsg.value && errorMsg.value.includes('尚未在本机授权') && (!curCwd || !window.piBridge || !window.piBridge.isWorkspaceApproved || window.piBridge.isWorkspaceApproved(curCwd))) {
      errorMsg.value = ''
    }
    if (permChanged || cwdChanged || forceRefreshEnv) {
      sessionRiskConfirmed.value = false
      pendingRiskConfirm.value = false
      if (engine.value === 'rpc') maybePrewarmRpc()
    }
  }
}

function onQuickUpdateGroup(patch, opts) {
  if (!activeGroup.value || running.value) return
  onSaveGroup({ ...activeGroup.value, ...patch }, true, opts)
  showToast('已更新当前分组配置')
}

function pickGroupCwd() {
  if (!activeGroup.value || running.value) return
  if (window.utools && typeof window.utools.showOpenDialog === 'function' && window.piBridge && window.piBridge.pickFolder) {
    const dir = window.piBridge.pickFolder()
    if (dir) {
      bumpWorkspaceAuth()
      onQuickUpdateGroup({ cwd: dir }, { forceRefreshEnv: true })
    }
    return
  }
  openSettingsTab('groups', { editGroupId: activeGroup.value.id })
}

function onDeleteGroup(g) {
  if (groups.value.length <= 1) return
  const list = listSessions(g.id)
  const imgPaths = []
  const piSessionIds = []
  for (const s of list) {
    const removed = deleteSession(s.id)
    if (removed) imgPaths.push(...collectSessionImagePaths(removed))
    if (s.piSessionId) piSessionIds.push(s.piSessionId)
  }
  if (piSessionIds.length && window.piBridge) {
    if (window.piBridge.deletePiSessions) {
      try { window.piBridge.deletePiSessions(piSessionIds) } catch (_) {}
    } else if (window.piBridge.deletePiSession) {
      for (const id of piSessionIds) {
        try { window.piBridge.deletePiSession(id) } catch (_) {}
      }
    }
  }
  if (imgPaths.length && window.piBridge && window.piBridge.deleteImages) {
    try { window.piBridge.deleteImages(imgPaths) } catch (_) {}
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
  if (window.piBridge && window.piBridge.clearImages) {
    try { window.piBridge.clearImages() } catch (_) {}
  }
  const piSessionIds = list.map(s => s && s.piSessionId).filter(Boolean)
  if (piSessionIds.length && window.piBridge) {
    if (window.piBridge.deletePiSessions) {
      try { window.piBridge.deletePiSessions(piSessionIds) } catch (_) {}
    } else if (window.piBridge.deletePiSession) {
      for (const id of piSessionIds) {
        try { window.piBridge.deletePiSession(id) } catch (_) {}
      }
    }
  }
  currentSession.value = null
  sessions.value = []
  showHistory.value = false
  showToast(`已清空 ${list.length} 个对话`)
}

function restartEngineForConfig() {
  if (window.piBridge && window.piBridge.stopRpc) { try { window.piBridge.stopRpc() } catch (_) {} }
  rpcStatus.value = ''
  refreshModels()
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
      :workspace-auth-rev="workspaceAuthRev"
      @close="showSettings = false"
      @set-layout="setLayout"
      @set-engine="setEngine"
      @set-default-cwd="setDefaultCwd"
      @pick-default-cwd="pickDefaultCwd"
      @set-send-key-mode="setSendKeyMode"
      @save-group="onSaveGroup"
      @delete-group="onDeleteGroup"
      @workspace-authorized="bumpWorkspaceAuth"
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
