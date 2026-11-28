// PiDeck 运行调度器：从 preload.js 剥离的进程调度、审计包装、异步模型列表与终端登录逻辑
const childProcess = require('node:child_process')
const nodeFs = require('node:fs')
const nodePath = require('node:path')
const os = require('node:os')
const defaultCore = require('./pi-core.cjs')
const { quoteForShell, isValidProviderId } = require('./config.cjs')

function toolSummary(t) {
  if (!t) return '无工具'
  const bits = [(t.list || []).join(',') || '无内置工具']
  bits.push(t.mcp === 'off' ? 'MCP 关' : t.mcp === 'all' ? 'MCP 全部' : 'MCP ' + (t.mcpServers || '未指定'))
  if (t.ext) bits.push('扩展开')
  if (t.skills === 'off') bits.push('技能关')
  else if (t.skills === 'some') bits.push('技能 ' + (t.skillPaths || []).length + ' 个')
  if (t.context) bits.push('项目规范')
  if (t.trust) bits.push('项目配置')
  return bits.join(' · ')
}

function isRiskTool(name) {
  // 只读类之外的都算风险：覆盖 MCP / 扩展带来的写文件、执行命令等工具
  return !defaultCore.READ_TOOL_NAMES.includes(String(name || ''))
}

function createRunner(deps = {}) {
  const core = deps.core || defaultCore
  const rpcEngine = deps.rpcEngine || null
  const auditRecord = deps.auditRecord || (() => false)
  const loadConfig = deps.loadConfig || (() => ({}))
  const tempDir = deps.tempDir || os.tmpdir()
  const spawn = deps.spawn || childProcess.spawn
  const execFile = deps.execFile || childProcess.execFile
  const fs = deps.fs || nodeFs
  const path = deps.path || nodePath

  let currentChild = null
  let activeJsonCancel = null
  let activeRpcCancel = null
  let _modelsPromise = null
  let _modelsCache = null
  let _modelsAt = 0
  const MODELS_TTL = 60 * 1000

  // 包装 handlers：工具级立即落盘，运行结束补一条汇总（幂等收口）
  function wrapHandlers(opts, handlers, ctx) {
    const h = handlers || {}
    const started = new Map()
    let usage = null
    let finished = false
    const base = {
      groupId: (opts && opts.groupId) || '',
      groupName: (opts && opts.groupName) || '',
      cwd: (opts && opts.cwd) || '',
      perm: toolSummary(opts && opts.tool),
      promptPreview: (opts && opts.promptPreview) || '',
    }
    return {
      ...h,
      onUsage: u => { usage = u; h.onUsage && h.onUsage(u) },
      onTool: (phase, name, payload, id) => {
        const key = id || ('name:' + name)
        if (phase === 'start') {
          started.set(key, { args: payload, ts: Date.now() })
        } else {
          const s = started.get(key) || {}
          started.delete(key)
          auditRecord({
            type: 'tool', ...base, engine: ctx.engine, risk: isRiskTool(name),
            tool: { name, args: s.args, result: payload, durationMs: s.ts ? Date.now() - s.ts : 0 },
          })
        }
        h.onTool && h.onTool(phase, name, payload, id)
      },
      onDone: payload => {
        if (finished) return
        finished = true
        auditRecord({ type: 'run', ...base, engine: ctx.engine, usage, aborted: !!(payload && payload.aborted) })
        h.onDone && h.onDone(payload)
      },
      onError: msg => {
        if (finished) return
        finished = true
        auditRecord({ type: 'run', ...base, engine: ctx.engine, usage, error: String(msg || '') })
        h.onError && h.onError(msg)
      },
    }
  }

  // 打开终端执行登录命令：Windows 写插件临时目录 .cmd 规避引号转义（转义 % 并拒绝换行），macOS 走 AppleScript
  function cleanupOldLoginScripts() {
    try {
      const cutoff = Date.now() - 10 * 60 * 1000
      for (const name of fs.readdirSync(tempDir)) {
        if (!/^pideck-login-.*\.cmd$/i.test(name)) continue
        const p = path.join(tempDir, name)
        try {
          if (fs.statSync(p).mtimeMs < cutoff) fs.unlinkSync(p)
        } catch (_) {}
      }
    } catch (_) {}
  }

  function launchTerminalCommand(command) {
    const safeCmd = String(command || '').trim()
    if (!safeCmd || /[\r\n\0]/.test(safeCmd)) return false
    try {
      if (process.platform === 'win32') {
        fs.mkdirSync(tempDir, { recursive: true })
        cleanupOldLoginScripts()
        const file = path.join(tempDir, `pideck-login-${process.pid}-${Date.now().toString(36)}.cmd`)
        if (/["\r\n\0&|<>^%!]/.test(file)) return false
        const batchCmd = safeCmd.replace(/%/g, '%%')
        fs.writeFileSync(file, `@echo off\r\n${batchCmd}\r\n`, { encoding: 'utf8', mode: 0o600 })
        // start 的第一个参数是窗口标题（空串）；启用 windowsVerbatimArguments 避免 libuv 二次转义破坏含空格路径
        const child = spawn('cmd.exe', ['/d', '/c', `start "" cmd.exe /k "${file}"`], {
          detached: true, stdio: 'ignore', windowsHide: false, windowsVerbatimArguments: true,
        })
        child.on('error', () => {})
        child.unref()
        return true
      }
      if (process.platform === 'darwin') {
        const script = `tell application "Terminal" to do script ${JSON.stringify(safeCmd)}`
        const child = spawn('osascript', ['-e', script], { detached: true, stdio: 'ignore' })
        child.on('error', () => {})
        child.unref()
        return true
      }
      return false
    } catch (_) { return false }
  }

  function openInstallTerminal() {
    return launchTerminalCommand(core.PI_INSTALL_CMD || defaultCore.PI_INSTALL_CMD)
  }

  function openLoginTerminal(provider) {
    const id = String(provider || '').trim()
    if (!isValidProviderId(id)) return false
    let cmd = `pi auth login ${id}`
    try {
      const { node, cli } = core.resolvePi()
      const qNode = quoteForShell(node)
      const qCli = quoteForShell(cli)
      if (qNode && qCli) cmd = `${qNode} ${qCli} auth login ${id}`
    } catch (_) {}
    return launchTerminalCommand(cmd)
  }

  function run(opts, handlers) {
    if (currentChild || activeRpcCancel) throw new Error('已有任务运行中，请先取消')
    // 禁工具且未开 MCP/扩展的纯文本分组：替换 system prompt，避免模型输出原始工具调用标记
    opts = core.applyLeanSystemPrompt(opts)
    const cfg = loadConfig() || {}
    // RPC 引擎：已预热且无非图片附件时走长驻进程；否则回退 JSON 模式并懒预热
    const canRpc = !(rpcEngine && rpcEngine.hasNonImageFiles && rpcEngine.hasNonImageFiles(opts.files))
    // 历史会话只有在常驻进程已持有同一会话时才走 RPC；否则强制单次调用，保证落盘会话续接
    const rpcHasSession = (canRpc && rpcEngine && rpcEngine.hasSession)
      ? rpcEngine.hasSession(opts.cwd, opts, opts.sessionId) : false
    const mustUseJson = !!opts.hasLocalHistory && !rpcHasSession
    const ctx = { engine: 'json' }
    const wrapped = wrapHandlers(opts, handlers, ctx)
    if (cfg.engine === 'rpc' && rpcEngine && canRpc && !mustUseJson) {
      if (!rpcEngine.isReady(opts.cwd, opts)) {
        // 懒预热：本条回退 JSON，后台建立长驻进程，下一条新会话起零冷启动
        try { rpcEngine.prewarm(opts.cwd, opts).catch(() => {}) } catch (_) {}
      } else {
        try {
          const clearActive = () => { if (activeRpcCancel === doCancel) activeRpcCancel = null }
          let rpcHandle = null
          const doCancel = () => {
            clearActive()
            if (rpcHandle && rpcHandle.cancel) rpcHandle.cancel()
          }
          activeRpcCancel = doCancel
          ctx.engine = 'rpc'
          rpcHandle = rpcEngine.prompt(opts.cwd, opts, {
            ...wrapped,
            onDone: payload => { clearActive(); wrapped.onDone && wrapped.onDone(payload) },
            onError: msg => { clearActive(); wrapped.onError && wrapped.onError(msg) },
          })
          return { cancel: doCancel, mode: 'rpc' }
        } catch (_) {
          activeRpcCancel = null
          // RPC 不可用，静默回退 JSON
        }
      }
    }

    ctx.engine = 'json'
    // 该会话是否已落盘：RPC 产生历史没有磁盘文件，回退 JSON 时模型看不到旧上下文
    const sessionResumed = mustUseJson && core.hasPiSession ? core.hasPiSession(opts.sessionId) : true
    const { node } = core.resolvePi()
    const args = core.buildArgs(opts)

    const child = spawn(node, args, {
      cwd: core.effectiveCwd(opts.cwd),
      env: { ...process.env },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    currentChild = child

    const buf = core.makeLineBuffer()
    let settled = false
    let aborted = false
    const finish = (payload) => {
      if (settled) return
      settled = true
      wrapped.onDone && wrapped.onDone(payload)
    }

    child.stdout.on('data', chunk => {
      core.pushChunk(buf, chunk, rec => {
        const isDone = core.mapPiEvent(rec, wrapped)
        if (isDone) finish({ aborted: false })
      })
    })

    let stderr = ''
    const errStream = core.makeTextStream()
    child.stderr.on('data', c => {
      if (stderr.length < 16000) stderr += errStream.push(c).slice(0, 8000)
    })

    let timer = null
    const release = () => {
      if (timer) { clearTimeout(timer); timer = null }
      if (currentChild === child) currentChild = null
      if (activeJsonCancel === doJsonCancel) activeJsonCancel = null
    }
    const doJsonCancel = () => {
      aborted = true
      release()
      try { child.kill() } catch (_) {}
    }
    activeJsonCancel = doJsonCancel
    child.on('error', err => {
      settled = true
      release()
      wrapped.onError && wrapped.onError(String(err && err.message || err))
    })
    child.on('close', code => {
      release()
      if (!settled) {
        if (aborted) finish({ aborted: true })
        else {
          settled = true
          const msg = stderr.trim()
          wrapped.onError && wrapped.onError(msg ? `pi 退出（code ${code}）：${msg.slice(-1200)}` : `pi 退出（code ${code}）`)
        }
      } else {
        wrapped.onClose && wrapped.onClose(code)
      }
    })

    // watchdog：15 分钟无结束则强杀
    timer = setTimeout(() => {
      if (!settled) {
        settled = true
        aborted = true
        release()
        try { child.kill() } catch (_) {}
        wrapped.onError && wrapped.onError('pi 运行超时（15 分钟），已终止')
      }
    }, 15 * 60 * 1000)
    if (timer.unref) timer.unref()

    return {
      cancel: doJsonCancel,
      mode: 'json',
      sessionResumed,
    }
  }

  function cancel() {
    if (activeRpcCancel) {
      const fn = activeRpcCancel
      activeRpcCancel = null
      try { fn(); return true } catch (_) { return false }
    }
    if (activeJsonCancel) {
      const fn = activeJsonCancel
      try { fn(); return true } catch (_) { return false }
    }
    if (!currentChild) return false
    const child = currentChild
    // 立即释放引用：kill 到 close 有延迟，期间用户再发送会被误判为"任务运行中"
    currentChild = null
    try { child.kill(); return true } catch (_) { return false }
  }

  function resetModelsCache() {
    _modelsCache = null
    _modelsAt = 0
  }

  async function listModelsAsync(opts) {
    const force = !!(opts && opts.force)
    if (!force && _modelsCache && Date.now() - _modelsAt < MODELS_TTL) {
      return _modelsCache
    }
    if (!force && _modelsPromise) return _modelsPromise
    const runFetch = async () => {
      const { node, cli } = core.resolvePiAsync ? await core.resolvePiAsync() : core.resolvePi()
      return new Promise((resolve, reject) => {
        execFile(node, [cli, '--list-models'], { windowsHide: true, timeout: 30000, maxBuffer: 1024 * 1024 }, (err, stdout) => {
          if (err) return reject(err)
          const list = core.parseModelsOutput(stdout)
          _modelsCache = list
          _modelsAt = Date.now()
          resolve(list)
        })
      })
    }
    if (force) return runFetch()
    _modelsPromise = runFetch().finally(() => { _modelsPromise = null })
    return _modelsPromise
  }

  return { run, cancel, listModelsAsync, resetModelsCache, openInstallTerminal, openLoginTerminal, wrapHandlers }
}

module.exports = {
  toolSummary,
  isRiskTool,
  createRunner,
}
