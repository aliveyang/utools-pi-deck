// Pi 运行环境：引擎、模型、技能、默认值、环境诊断与终端一键安装
import { ref } from 'vue'
import { readCache, writeCache } from '../storage.js'
import { PI_INSTALL_CMD } from '../constants.js'

export function usePiEnv({ getCwd, showToast, copyText, getLean }) {
  const models = ref([])
  const skills = ref([])
  const piStatus = ref(null)
  const engine = ref('json')
  const rpcStatus = ref('')
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
      if (envInfo.value && !envInfo.value.ok) showEnvHelp.value = true
    } catch (_) { envInfo.value = null }
  }

  function recheckEnv() {
    if (window.piBridge && window.piBridge.resetPiCache) {
      try { window.piBridge.resetPiCache() } catch (_) {}
    }
    loadEnv()
    if (window.piBridge && window.piBridge.resolvePi) piStatus.value = window.piBridge.resolvePi()
    if (envInfo.value && envInfo.value.ok) {
      showEnvHelp.value = false
      loadModelsAsync()
      loadDefaults(true)
      showToast('检测通过，Pi 可用')
    } else {
      showToast('仍未检测到，可在设置中手动指定路径或安装后重启 uTools')
    }
  }

  function installPi() {
    const ok = window.piBridge && window.piBridge.installPiInTerminal && window.piBridge.installPiInTerminal()
    if (ok) {
      showToast('已打开终端开始安装，完成后点击「重新检测」')
      return
    }
    if (copyText) copyText(PI_INSTALL_CMD)
    showToast('已复制安装命令，请在终端中运行')
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
          showToast(ok ? '已开启极速模式并完成预热' : '极速预热失败，将自动使用标准模式')
        })
      }
    } else {
      if (window.piBridge.stopRpc) window.piBridge.stopRpc()
      rpcStatus.value = ''
      showToast('已切换为标准模式')
    }
  }

  function openPath(p) {
    if (!p) return
    if (!window.piBridge || !window.piBridge.openPath || !window.piBridge.openPath(p)) {
      showToast('当前环境无法打开文件管理器')
    }
  }

  function openExternal(url) {
    const raw = String(url || '').trim()
    if (!raw) return
    let href = ''
    try {
      const parsed = new URL(raw)
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') href = parsed.href
    } catch (_) {}
    if (!href) return
    if (window.piBridge && window.piBridge.openExternal) {
      window.piBridge.openExternal(href)
      return
    }
    window.open(href, '_blank', 'noopener,noreferrer')
  }

  return {
    models, skills, piStatus, engine, rpcStatus, defaults, envInfo, showEnvHelp,
    loadDefaults, loadModelsAsync, refreshModels, loadSkillsAsync,
    loadEnv, recheckEnv, installPi, prewarmActive, setEngine, openPath, openExternal,
  }
}
