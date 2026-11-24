// Pi 运行环境：引擎、模型、技能、默认值、环境诊断与终端一键安装
import { ref } from 'vue'
import { readCacheMeta, writeCache } from '../storage.js'
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

  let modelsLoadingPromise = null
  let envLoadingPromise = null
  let lastSkillsCwd = null

  function normalizeDefaultsFromEnv(env) {
    if (!env || !env.defaultModel) return null
    return {
      modelId: env.defaultModel,
      modelName: env.defaultModel,
      thinkingLevel: env.defaultThinking || '',
    }
  }

  function hydrateFromCache() {
    const cwd = getCwd ? (getCwd() || '') : ''
    const mMeta = readCacheMeta('models')
    if (mMeta && Array.isArray(mMeta.data)) models.value = mMeta.data

    let skillsFresh = false
    const sMeta = readCacheMeta('skills')
    if (sMeta && sMeta.data) {
      if (Array.isArray(sMeta.data)) {
        skills.value = sMeta.data
        skillsFresh = sMeta.fresh
      } else if (Array.isArray(sMeta.data.list)) {
        const sameCwd = (sMeta.data.cwd || '') === cwd
        if (sameCwd || !skills.value.length) skills.value = sMeta.data.list
        if (sameCwd) {
          lastSkillsCwd = cwd
          skillsFresh = sMeta.fresh
        }
      }
    }

    const dMeta = readCacheMeta('defaults')
    if (dMeta && dMeta.data && !dMeta.data.error) {
      defaults.value = dMeta.data
    }

    const eMeta = readCacheMeta('env')
    if (eMeta && eMeta.data) {
      envInfo.value = eMeta.data
      if (eMeta.data.ok) {
        piStatus.value = { ok: true, node: eMeta.data.nodePath || '', cli: eMeta.data.piPath || '' }
        if (!defaults.value.modelId && !defaults.value.modelName) {
          const fallbackDef = normalizeDefaultsFromEnv(eMeta.data)
          if (fallbackDef) defaults.value = fallbackDef
        }
      }
    }

    return {
      modelsFresh: !!(mMeta && mMeta.fresh),
      skillsFresh,
      defaultsFresh: !!(dMeta && dMeta.fresh),
      envFresh: !!(eMeta && eMeta.fresh),
    }
  }

  function syncDefaultsFromRpc() {
    if (!window.piBridge || !window.piBridge.getRpcDefaults) return false
    try {
      const rpcDef = window.piBridge.getRpcDefaults(getCwd(), { ...(getLean ? getLean() : {}) })
      if (rpcDef && (rpcDef.modelId || rpcDef.modelName || rpcDef.thinkingLevel)) {
        defaults.value = rpcDef
        writeCache('defaults', rpcDef)
        return true
      }
    } catch (_) {}
    return false
  }

  // 读取 pi 实际生效的默认模型/思考强度，优先复用已预热 RPC 或 settings.json，避免冷启动额外派生子进程
  async function loadDefaults(force) {
    if (!force) {
      const dMeta = readCacheMeta('defaults')
      if (dMeta && dMeta.fresh && dMeta.data && !dMeta.data.error) {
        defaults.value = dMeta.data
        return
      }
      if (syncDefaultsFromRpc()) return
      const fromEnv = normalizeDefaultsFromEnv(envInfo.value)
      if (fromEnv) {
        defaults.value = fromEnv
        writeCache('defaults', fromEnv)
        return
      }
    }
    if (!window.piBridge || !window.piBridge.getDefaults) return
    try {
      const d = await window.piBridge.getDefaults(getCwd())
      if (d && !d.error) { defaults.value = d; writeCache('defaults', d) }
    } catch (_) {}
  }

  async function loadModelsAsync(opts = {}) {
    const force = !!(opts && opts.force)
    if (!force) {
      const mMeta = readCacheMeta('models')
      if (mMeta && mMeta.fresh && Array.isArray(mMeta.data)) {
        if (!models.value.length) models.value = mMeta.data
        return mMeta.data
      }
    }
    if (modelsLoadingPromise) return modelsLoadingPromise
    modelsLoadingPromise = (async () => {
      try {
        let list = null
        if (window.piBridge && window.piBridge.listModelsAsync) list = await window.piBridge.listModelsAsync()
        else if (window.piBridge && window.piBridge.listModels) list = window.piBridge.listModels()
        if (list) { models.value = list; writeCache('models', list) }
        return list
      } catch (_) {
        /* 保留上次缓存 */
        return null
      } finally {
        modelsLoadingPromise = null
      }
    })()
    return modelsLoadingPromise
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

  async function loadSkillsAsync(opts = {}) {
    const force = !!(opts && opts.force)
    const cwd = getCwd ? (getCwd() || '') : ''
    if (!force) {
      const sMeta = readCacheMeta('skills')
      if (sMeta && sMeta.fresh && sMeta.data && !Array.isArray(sMeta.data) && (sMeta.data.cwd || '') === cwd && Array.isArray(sMeta.data.list)) {
        skills.value = sMeta.data.list
        lastSkillsCwd = cwd
        return sMeta.data.list
      }
    }
    try {
      let list = null
      if (window.piBridge && window.piBridge.listSkillsAsync) list = await window.piBridge.listSkillsAsync(cwd)
      else if (window.piBridge && window.piBridge.listSkills) list = window.piBridge.listSkills(cwd)
      if (list) {
        skills.value = list
        lastSkillsCwd = cwd
        writeCache('skills', { cwd, list })
      }
      return list
    } catch (_) { /* 保留上次缓存 */ }
  }

  function applyEnvResult(env) {
    envInfo.value = env || null
    if (env && env.ok) {
      piStatus.value = { ok: true, node: env.nodePath || '', cli: env.piPath || '' }
      showEnvHelp.value = false
      writeCache('env', env)
      if (!defaults.value.modelId && !defaults.value.modelName) {
        const fromEnv = normalizeDefaultsFromEnv(env)
        if (fromEnv) {
          defaults.value = fromEnv
          writeCache('defaults', fromEnv)
        }
      }
    } else if (env) {
      piStatus.value = { ok: false, error: env.error || '环境未就绪' }
      showEnvHelp.value = true
    }
  }

  function loadEnv() {
    if (!window.piBridge || !window.piBridge.getEnv) return
    try {
      applyEnvResult(window.piBridge.getEnv())
    } catch (_) { envInfo.value = null }
  }

  async function loadEnvAsync() {
    if (envLoadingPromise) return envLoadingPromise
    if (!window.piBridge) return null
    envLoadingPromise = (async () => {
      try {
        const env = window.piBridge.getEnvAsync
          ? await window.piBridge.getEnvAsync()
          : (window.piBridge.getEnv ? window.piBridge.getEnv() : null)
        applyEnvResult(env)
        return env
      } catch (_) {
        return null
      } finally {
        envLoadingPromise = null
      }
    })()
    return envLoadingPromise
  }

  async function recheckEnv() {
    if (window.piBridge && window.piBridge.resetPiCache) {
      try { window.piBridge.resetPiCache() } catch (_) {}
    }
    const env = await loadEnvAsync()
    if (!env && window.piBridge && window.piBridge.resolvePiAsync) {
      piStatus.value = await window.piBridge.resolvePiAsync()
    }
    if (envInfo.value && envInfo.value.ok) {
      showEnvHelp.value = false
      loadModelsAsync({ force: true })
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
    rpcStatus.value = 'warming'
    return window.piBridge.prewarmRpc(getCwd(), { ...(getLean ? getLean() : {}) })
      .then(ok => {
        rpcStatus.value = ok ? 'ready' : 'failed'
        if (ok) syncDefaultsFromRpc()
        return ok
      })
      .catch(() => {
        rpcStatus.value = 'failed'
        return false
      })
  }

  function setEngine(val) {
    if (!window.piBridge || !window.piBridge.setConfig) return showToast('当前环境不支持切换引擎')
    engine.value = val
    window.piBridge.setConfig({ engine: val })
    if (val === 'rpc') {
      rpcStatus.value = 'warming'
      if (window.piBridge.prewarmRpc) {
        prewarmActive().then(ok => {
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
    hydrateFromCache, loadDefaults, loadModelsAsync, refreshModels, loadSkillsAsync,
    loadEnv, loadEnvAsync, recheckEnv, installPi, prewarmActive, setEngine, openPath, openExternal,
    getLastSkillsCwd: () => lastSkillsCwd,
  }
}
