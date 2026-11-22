// Pi 运行环境：引擎、模型、技能、默认值、环境诊断
import { ref } from 'vue'
import { readCache, writeCache } from '../storage.js'

export function usePiEnv({ getCwd, showToast, getLean }) {
  const models = ref([])
  const skills = ref([])
  const piStatus = ref(null)
  const engine = ref('json')
  const rpcStatus = ref('')
  const contextFiles = ref([])
  const defaults = ref({ modelId: '', modelName: '', thinkingLevel: '' })
  const envInfo = ref(null)
  const showEnvHelp = ref(false)

  // 读取 pi 实际默认模型/思考强度，带 5 分钟缓存
  async function loadDefaults(force) {
    const cached = force ? null : readCache('defaults')
    if (cached) { defaults.value = cached; return }
    if (!window.piBridge || !window.piBridge.getDefaults) return
    try {
      const d = await window.piBridge.getDefaults(getCwd())
      if (d && !d.error) { defaults.value = d; writeCache('defaults', d) }
    } catch (_) {}
  }

  function detectContext() {
    if (!window.piBridge || !window.piBridge.detectContextFiles) return
    try { contextFiles.value = window.piBridge.detectContextFiles(getCwd()) || [] }
    catch (_) { contextFiles.value = [] }
  }

  async function loadModelsAsync() {
    try {
      let list = null
      if (window.piBridge && window.piBridge.listModelsAsync) list = await window.piBridge.listModelsAsync()
      else if (window.piBridge && window.piBridge.listModels) list = window.piBridge.listModels()
      if (list) { models.value = list; writeCache('models', list) }
    } catch (_) { /* 保留上次缓存 */ }
  }

  async function refreshModels() {
    try {
      let list = null
      // 优先异步版本：同步 execFile 会阻塞 UI ~1.5s（preload 内与渲染层同线程）
      if (window.piBridge && window.piBridge.listModelsAsync) list = await window.piBridge.listModelsAsync()
      else if (window.piBridge && window.piBridge.refreshModels) list = window.piBridge.refreshModels()
      else if (window.piBridge && window.piBridge.listModels) list = window.piBridge.listModels()
      if (list) { models.value = list; writeCache('models', list) }
      await loadDefaults(true)
      showToast('模型列表已刷新')
    } catch (e) { showToast('刷新失败：' + e.message) }
  }

  async function loadSkillsAsync() {
    try {
      const list = window.piBridge && window.piBridge.listSkills ? window.piBridge.listSkills(getCwd()) : null
      if (list) { skills.value = list; writeCache('skills', list) }
    } catch (_) { /* 保留上次缓存 */ }
  }

  function loadEnv() {
    if (!window.piBridge || !window.piBridge.getEnv) return
    try {
      envInfo.value = window.piBridge.getEnv()
      // 环境未就绪时默认展开安装引导
      if (envInfo.value && !envInfo.value.ok) showEnvHelp.value = true
    } catch (_) { envInfo.value = null }
  }

  function recheckEnv() {
    loadEnv()
    if (window.piBridge && window.piBridge.resolvePi) piStatus.value = window.piBridge.resolvePi()
    if (envInfo.value && envInfo.value.ok) showToast('检测通过，Pi 可用')
    else showToast('仍未检测到，请确认安装后重启 uTools')
  }

  function prewarmActive() {
    if (!window.piBridge || !window.piBridge.prewarmRpc) return Promise.resolve(false)
    return window.piBridge.prewarmRpc(getCwd(), { ...(getLean ? getLean() : {}) })
  }

  function setEngine(val) {
    if (!window.piBridge || !window.piBridge.setConfig) return showToast('当前环境不支持切换引擎')
    engine.value = val
    window.piBridge.setConfig({ engine: val })
    if (val === 'rpc') {
      rpcStatus.value = 'warming'
      if (window.piBridge.prewarmRpc) {
        prewarmActive().then(ok => {
          rpcStatus.value = ok ? 'ready' : 'failed'
          showToast(ok ? 'RPC 引擎已就绪' : 'RPC 预热失败，将回退单次调用')
        })
      }
    } else {
      if (window.piBridge.stopRpc) window.piBridge.stopRpc()
      rpcStatus.value = ''
      showToast('已切换为单次调用')
    }
  }

  function openPath(p) {
    if (!p) return
    if (!window.piBridge || !window.piBridge.openPath || !window.piBridge.openPath(p)) {
      showToast('当前环境无法打开文件管理器（可在浏览器预览中手动打开）')
    }
  }

  function openExternal(url) {
    if (window.piBridge && window.piBridge.openExternal && window.piBridge.openExternal(url)) return
    window.open(url, '_blank')
  }

  function ctxLabel(c) { return c.global ? '全局' : '项目' }

  return {
    models, skills, piStatus, engine, rpcStatus, contextFiles, defaults, envInfo, showEnvHelp,
    loadDefaults, detectContext, loadModelsAsync, refreshModels, loadSkillsAsync,
    loadEnv, recheckEnv, prewarmActive, setEngine, openPath, openExternal, ctxLabel,
  }
}
