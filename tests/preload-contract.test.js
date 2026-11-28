import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, existsSync, realpathSync } from 'node:fs'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import vm from 'node:vm'

const require = createRequire(import.meta.url)

function loadPreloadWithMocks({ dialogQueue = [], dbItems = {}, localRoot = '', tempRoot = '', enterActions = [], failCore = false, runnerRunSpy = null }) {
  const preloadPath = resolve('public/preload.js')
  const code = readFileSync(preloadPath, 'utf8')
  let enterHandler = null
  const win = {
    addEventListener: () => {},
    dispatchEvent: () => {},
    utools: {
      onPluginEnter: fn => { enterHandler = fn },
      getPluginLocalDataPath: () => localRoot,
      getPluginTempPath: () => tempRoot,
      showOpenDialog: () => dialogQueue.shift(),
      dbStorage: {
        getItem: k => (Object.prototype.hasOwnProperty.call(dbItems, k) ? dbItems[k] : null),
      },
    },
  }
  const sandbox = {
    window: win,
    CustomEvent: class CustomEvent { constructor(t, o) { this.type = t; this.detail = o && o.detail } },
    performance: { now: () => 0 },
    process,
    console,
    setTimeout,
    clearTimeout,
    setImmediate,
    require: id => {
      if (failCore && id.includes('pi-core.cjs')) throw new Error('mock core missing')
      if (runnerRunSpy && id.includes('runner.cjs')) {
        return {
          createRunner: () => ({
            run: (opts, handlers) => runnerRunSpy(opts, handlers),
            cancel: () => false,
            listModelsAsync: async () => [],
            resetModelsCache: () => {},
            openInstallTerminal: () => false,
            openLoginTerminal: () => false,
          }),
        }
      }
      if (id.startsWith('./shared/') || id.startsWith('../shared/')) {
        return require(resolve('shared', id.replace(/^\.\.?\/shared\//, '')))
      }
      return require(id)
    },
  }
  vm.runInNewContext(code, sandbox, { filename: preloadPath })
  if (enterHandler && Array.isArray(enterActions)) {
    for (const act of enterActions) enterHandler(act)
  }
  return win.piBridge
}

function loadDevBridgeWithMocks() {
  const devPath = resolve('src/dev-bridge.js')
  const code = readFileSync(devPath, 'utf8')
  const win = {}
  class FakeXHR {
    open() {}
    send() { this.status = 200; this.responseText = '{}' }
  }
  const sandbox = {
    window: win,
    XMLHttpRequest: FakeXHR,
    localStorage: { getItem: () => null, setItem: () => {} },
    fetch: async () => ({ ok: true, json: async () => ({}) }),
    AbortController,
    TextDecoder,
    URL,
    console,
  }
  vm.runInNewContext(code, sandbox, { filename: devPath })
  return win.piBridge
}

describe('preload.js 安全边界契约', () => {
  let root
  let localRoot
  let tempRoot

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'pideck-preload-'))
    localRoot = join(root, 'local')
    tempRoot = join(root, 'temp')
    mkdirSync(localRoot, { recursive: true })
    mkdirSync(tempRoot, { recursive: true })
  })

  afterEach(() => {
    try { rmSync(root, { recursive: true, force: true }) } catch (_) {}
  })

  it('不暴露 auditRecord 与 validateCwd，且 setConfig 拒绝 nodePath/piCliPath/approvedWorkspaces', () => {
    const bridge = loadPreloadWithMocks({ localRoot, tempRoot })
    expect(bridge.auditRecord).toBeUndefined()
    expect(bridge.validateCwd).toBeUndefined()

    const afterEvil = bridge.setConfig({
      nodePath: '/bin/sh',
      piCliPath: '/tmp/x.sh',
      approvedWorkspaces: [root],
      engine: 'rpc',
    })
    expect(afterEvil.engine).toBe('rpc')
    expect(afterEvil.nodePath).toBe('')
    expect(afterEvil.piCliPath).toBe('')
    expect(bridge.getConfig().approvedWorkspaces).toBeUndefined()
  })

  it('pickExecutable 校验失败保留旧值并返回错误，成功则保存新路径，clearExecutable 可恢复', () => {
    const pkgRoot = join(root, 'nm', '@earendil-works', 'pi-coding-agent')
    const validCli = join(pkgRoot, 'dist', 'bundle', 'cli.js')
    const badScript = join(root, 'evil.sh')
    mkdirSync(join(pkgRoot, 'dist', 'bundle'), { recursive: true })
    writeFileSync(join(pkgRoot, 'package.json'), JSON.stringify({ name: '@earendil-works/pi-coding-agent', version: '1.0.0' }))
    writeFileSync(validCli, '// valid pi cli')
    writeFileSync(badScript, '#!/bin/sh\n')

    const bridge = loadPreloadWithMocks({
      localRoot,
      tempRoot,
      dialogQueue: [
        [validCli],
        [badScript],
        [badScript],
      ],
    })

    const okPi = bridge.pickExecutable('pi')
    expect(okPi.ok).toBe(true)
    expect(bridge.getConfig().piCliPath).toBeTruthy()
    const savedCli = bridge.getConfig().piCliPath

    const failPi = bridge.pickExecutable('pi')
    expect(failPi.ok).toBe(false)
    expect(failPi.error).toBeTruthy()
    expect(bridge.getConfig().piCliPath).toBe(savedCli)

    const failNode = bridge.pickExecutable('node')
    expect(failNode.ok).toBe(false)
    expect(bridge.getConfig().nodePath).toBe('')

    expect(bridge.clearExecutable('pi')).toEqual({ ok: true })
    expect(bridge.getConfig().piCliPath).toBe('')
  })

  it('不信任 utools.dbStorage 中的未授权目录；仅放行默认工作区或 pickFolder 授权目录', async () => {
    const dbOnlyDir = join(root, 'db-only-ws')
    const allowedByPick = join(root, 'picked-ws')
    const unlistedDir = join(root, 'secret-ws')
    mkdirSync(dbOnlyDir, { recursive: true })
    mkdirSync(allowedByPick, { recursive: true })
    mkdirSync(unlistedDir, { recursive: true })
    writeFileSync(join(dbOnlyDir, 'db.txt'), 'db')
    writeFileSync(join(dbOnlyDir, 'AGENTS.md'), '# db rule')
    writeFileSync(join(allowedByPick, 'picked.txt'), 'picked')
    writeFileSync(join(allowedByPick, 'AGENTS.md'), '# picked rule')
    writeFileSync(join(unlistedDir, 'secret.txt'), 'secret')
    writeFileSync(join(unlistedDir, 'AGENTS.md'), '# secret rule')

    const bridge = loadPreloadWithMocks({
      localRoot,
      tempRoot,
      dialogQueue: [[allowedByPick]],
      dbItems: {
        'pideck.groups.v1': JSON.stringify([{ id: 'agent', cwd: dbOnlyDir }]),
      },
    })

    // 仅出现在 dbStorage 或未登记目录一律拒绝
    expect(bridge.isWorkspaceApproved(dbOnlyDir)).toBe(false)
    expect(await bridge.listFilesAsync(dbOnlyDir)).toEqual([])
    expect(bridge.detectContextFiles(dbOnlyDir)).toEqual([])
    expect(await bridge.listSkillsAsync(dbOnlyDir)).toEqual([])
    expect(await bridge.listFilesAsync(unlistedDir)).toEqual([])
    expect(bridge.detectContextFiles(unlistedDir)).toEqual([])
    expect(await bridge.listSkillsAsync(unlistedDir)).toEqual([])
    expect(await bridge.prewarmRpc(dbOnlyDir, {})).toBe(false)

    // pickFolder 登记后放行并持久有效
    expect(bridge.pickFolder()).toBeTruthy()
    expect(bridge.isWorkspaceApproved(allowedByPick)).toBe(true)
    const pickedFiles = await bridge.listFilesAsync(allowedByPick)
    expect(pickedFiles.some(f => f.path === 'picked.txt')).toBe(true)
    const ctxFiles = bridge.detectContextFiles(allowedByPick)
    expect(ctxFiles.some(c => c.path.endsWith('AGENTS.md') && c.path.includes('picked-ws'))).toBe(true)
  })

  it('run() 拒绝未授权 cwd 与未授权附件；pickFiles / onPluginEnter 文件持久化授权', () => {
    const outsideDir = join(root, 'outside')
    const pickedFile = join(outsideDir, 'picked.md')
    const enterFile = join(outsideDir, 'enter.txt')
    const secretFile = join(outsideDir, 'secret.env')
    mkdirSync(outsideDir, { recursive: true })
    writeFileSync(pickedFile, '# picked')
    writeFileSync(enterFile, 'enter')
    writeFileSync(secretFile, 'SECRET=1')

    const bridge = loadPreloadWithMocks({
      localRoot,
      tempRoot,
      dialogQueue: [[pickedFile]],
      enterActions: [{ type: 'files', payload: [{ path: enterFile }] }],
    })

    expect(() => bridge.run({ cwd: outsideDir, prompt: 'hi' }, {})).toThrow('尚未在本机授权')
    expect(() => bridge.run({ cwd: '', files: [secretFile], prompt: 'hi' }, {})).toThrow('未在本机授权')

    expect(bridge.pickFiles()).toHaveLength(1)

    // 重载一个新的 preload 实例验证持久化 approvedFiles
    const bridge2 = loadPreloadWithMocks({ localRoot, tempRoot })
    expect(bridge2.getConfig().approvedFiles).toBeUndefined()
    // 仍拒绝未授权秘密文件
    expect(() => bridge2.run({ cwd: '', files: [secretFile], prompt: 'hi' }, {})).toThrow('未在本机授权')
    // 已授权文件可通过门禁（因测试环境无 pi CLI，抛错应来自解析 pi 而非权限门禁）
    try {
      bridge2.run({ cwd: '', files: [pickedFile, enterFile], prompt: 'hi' }, {})
    } catch (e) {
      expect(String(e.message)).not.toContain('未在本机授权')
    }
  })

  it('writeLocal 仅允许 pideck.drafts.v1 且拒绝 __proto__ 与超限数据', () => {
    const bridge = loadPreloadWithMocks({ localRoot, tempRoot })
    expect(bridge.writeLocal('other.key', { a: 1 })).toBe(false)
    expect(bridge.writeLocal('__proto__', { a: 1 })).toBe(false)
    expect(bridge.writeLocal('pideck.drafts.v1', { chat: 'x'.repeat(600 * 1024) })).toBe(false)
    expect(bridge.writeLocal('pideck.drafts.v1', { chat: 'hello' })).toBe(true)
    expect(bridge.readLocal('pideck.drafts.v1', {})).toEqual({ chat: 'hello' })
  })

  it('禁止渲染层读写 pi-resolved 内部缓存 key', () => {
    const bridge = loadPreloadWithMocks({ localRoot, tempRoot })
    expect(bridge.writeCache('pi-resolved', { nodePath: '/bin/sh', piPath: '/tmp/x.sh' })).toBe(false)
    expect(bridge.readCache('pi-resolved')).toBeNull()
    expect(bridge.readCacheMeta('pi-resolved')).toBeNull()
    expect(bridge.writeCache('models', [{ id: 'm1' }])).toBe(true)
    expect(bridge.readCache('models')).toEqual([{ id: 'm1' }])
  })

  it('normal / fallback / dev-bridge 三端 window.piBridge 接口键完全对齐', () => {
    const normal = loadPreloadWithMocks({ localRoot, tempRoot })
    const fallback = loadPreloadWithMocks({ localRoot, tempRoot, failCore: true })
    const devBridge = loadDevBridgeWithMocks()
    expect(Object.keys(fallback).sort()).toEqual(Object.keys(normal).sort())
    expect(Object.keys(devBridge).sort()).toEqual(Object.keys(normal).sort())
  })

  it('run() 将 data:image URL 自动落盘为真实文件路径，且放行挂载于技能根的软链技能', () => {
    const ws = join(root, 'ws-skill')
    const skillsDir = join(ws, '.pi', 'skills')
    const extSkill = join(root, 'ext-skill')
    const rogueSkill = join(root, 'rogue-skill')
    mkdirSync(skillsDir, { recursive: true })
    mkdirSync(extSkill, { recursive: true })
    mkdirSync(rogueSkill, { recursive: true })
    writeFileSync(join(extSkill, 'SKILL.md'), '---\nname: ext-skill\ndescription: external linked skill\n---\n')
    writeFileSync(join(rogueSkill, 'SKILL.md'), '---\nname: rogue-skill\ndescription: unmounted\n---\n')

    const linkedSkill = join(skillsDir, 'ext-skill')
    let linked = false
    try { symlinkSync(extSkill, linkedSkill, 'junction'); linked = true } catch (_) {}

    let capturedOpts = null
    const bridge = loadPreloadWithMocks({
      localRoot,
      tempRoot,
      dialogQueue: [[ws]],
      runnerRunSpy: opts => { capturedOpts = opts; return { cancel: () => {}, mode: 'json' } },
    })
    expect(bridge.pickFolder()).toBeTruthy()

    const dataUrl = `data:image/png;base64,${Buffer.from('fake-png-bytes').toString('base64')}`
    bridge.run({
      cwd: ws,
      prompt: 'test',
      files: [dataUrl],
      tool: {
        list: ['read'],
        skills: 'some',
        skillPaths: [...(linked ? [linkedSkill] : []), rogueSkill],
      },
    }, {})

    expect(capturedOpts).toBeTruthy()
    expect(capturedOpts.files).toHaveLength(1)
    expect(capturedOpts.files[0].startsWith('data:')).toBe(false)
    expect(existsSync(capturedOpts.files[0])).toBe(true)
    expect(capturedOpts.tool.skillPaths).not.toContain(realpathSync(rogueSkill))
    if (linked) {
      expect(capturedOpts.tool.skillPaths).toContain(realpathSync(extSkill))
    }
  })

  it('ensurePiConfiguredAsync 在已保存覆盖路径失效时清空旧内存覆盖', async () => {
    const core = require(resolve('shared/pi-core.cjs'))
    const pkgRoot = join(root, 'nm2', '@earendil-works', 'pi-coding-agent')
    const cli = join(pkgRoot, 'dist', 'bundle', 'cli.js')
    mkdirSync(join(pkgRoot, 'dist', 'bundle'), { recursive: true })
    writeFileSync(join(pkgRoot, 'package.json'), JSON.stringify({ name: '@earendil-works/pi-coding-agent', version: '1.0.0' }))
    writeFileSync(cli, '// temp cli')

    try {
      const bridge1 = loadPreloadWithMocks({
        localRoot,
        tempRoot,
        dialogQueue: [[cli]],
      })
      expect(bridge1.pickExecutable('pi').ok).toBe(true)
      expect((await bridge1.resolvePiAsync()).cli).toBe(realpathSync(cli))

      // 模拟用户删除或移动了之前手动指定的 cli.js
      rmSync(cli, { force: true })
      const bridge2 = loadPreloadWithMocks({ localRoot, tempRoot })
      const res2 = await bridge2.resolvePiAsync()
      if (res2.ok) {
        expect(res2.cli).not.toBe(realpathSync(pkgRoot) + '\\dist\\bundle\\cli.js')
      }
    } finally {
      core.setPathOverrides({ nodePath: '', piCliPath: '' })
    }
  })
})
