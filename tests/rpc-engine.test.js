import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { EventEmitter } from 'node:events'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const fixtureDir = mkdtempSync(join(tmpdir(), 'pideck-rpc-test-'))
const fakeCli = join(fixtureDir, 'cli.js')
writeFileSync(fakeCli, '// fake cli\n')
process.env.PIDECK_PI_CLI = fakeCli
process.env.PIDECK_NODE = process.execPath

const core = await import('../shared/pi-core.cjs')
const { createRpcEngine, hasNonImageFiles } = await import('../shared/rpc-engine.cjs')

afterAll(() => {
  try { rmSync(fixtureDir, { recursive: true, force: true }) } catch (_) {}
})

function makeMockChild(opts = {}) {
  const child = new EventEmitter()
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.killed = false
  child.sent = []
  child.stdinEnded = false
  child.stdin = {
    write(chunk) {
      const line = String(chunk).trim()
      if (!line) return
      const cmd = JSON.parse(line)
      child.sent.push(cmd)
      if (opts.onCommand) opts.onCommand(cmd, child)
      else if (cmd.type === 'get_state' && !opts.deferGetState) {
        queueMicrotask(() => {
          child.stdout.emit('data', Buffer.from(JSON.stringify({
            type: 'response', id: cmd.id, command: 'get_state', success: true,
            data: opts.stateData || { model: { id: 'default-model' }, thinkingLevel: 'medium' },
          }) + '\n'))
        })
      } else if (cmd.type === 'new_session' || cmd.type === 'set_model' || cmd.type === 'set_thinking_level' || cmd.type === 'abort') {
        queueMicrotask(() => {
          child.stdout.emit('data', Buffer.from(JSON.stringify({
            type: 'response', id: cmd.id, command: cmd.type, success: true, data: {},
          }) + '\n'))
        })
      } else if (cmd.type === 'prompt') {
        queueMicrotask(() => {
          child.stdout.emit('data', Buffer.from(JSON.stringify({
            type: 'response', id: cmd.id, command: 'prompt', success: true, data: {},
          }) + '\n'))
          if (!opts.keepPromptOpen) {
            child.stdout.emit('data', Buffer.from(JSON.stringify({
              type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'ok' },
            }) + '\n'))
            child.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'agent_settled' }) + '\n'))
          }
        })
      }
    },
    end() { child.stdinEnded = true },
  }
  child.kill = () => { child.killed = true; child.emit('exit', 0) }
  return child
}

describe('rpc-engine keyOf 与文件判断', () => {
  it('keyOf 区分不同 systemPrompt 且对 tool 键顺序不敏感', () => {
    const eng = createRpcEngine({ core, spawn: () => makeMockChild() })
    const k1 = eng.keyOf(fixtureDir, {
      tool: { list: ['read'], mcp: 'off', ext: false, skills: 'off', context: false, templates: false, trust: false },
      systemPrompt: 'SP-A',
    })
    const k2 = eng.keyOf(fixtureDir, {
      tool: { trust: false, templates: false, context: false, skills: 'off', ext: false, mcp: 'off', list: ['read'] },
      systemPrompt: 'SP-A',
    })
    const k3 = eng.keyOf(fixtureDir, {
      tool: { list: ['read'], mcp: 'off', ext: false, skills: 'off', context: false, templates: false, trust: false },
      systemPrompt: 'SP-B',
    })
    expect(k1).toBe(k2)
    expect(k1).not.toBe(k3)
  })

  it('hasNonImageFiles 识别非图片附件', () => {
    expect(hasNonImageFiles(['a.png', 'data:image/jpeg;base64,xxx'])).toBe(false)
    expect(hasNonImageFiles(['a.png', 'doc.pdf'])).toBe(true)
    expect(hasNonImageFiles(['notes.txt'])).toBe(true)
  })
})

describe('rpc-engine ensure 与 prompt 契约', () => {
  it('并发 ensure() 等待 get_state 完成后才 resolve', async () => {
    let spawned = 0
    let pendingStateCmd = null
    let childRef = null
    const eng = createRpcEngine({
      core,
      spawn: () => {
        spawned++
        childRef = makeMockChild({
          deferGetState: true,
          onCommand(cmd) { pendingStateCmd = cmd },
        })
        return childRef
      },
    })
    const p1 = eng.ensure(fixtureDir, {})
    const p2 = eng.ensure(fixtureDir, {})
    expect(spawned).toBe(1)
    let resolved = false
    p2.then(() => { resolved = true })
    await Promise.resolve()
    expect(resolved).toBe(false)
    childRef.stdout.emit('data', Buffer.from(JSON.stringify({
      type: 'response', id: pendingStateCmd.id, command: 'get_state', success: true, data: {},
    }) + '\n'))
    await Promise.all([p1, p2])
    expect(resolved).toBe(true)
  })

  it('未预热、忙碌、或含非图片附件时 prompt() 同步抛错', async () => {
    const child = makeMockChild({ keepPromptOpen: true })
    const eng = createRpcEngine({ core, spawn: () => child })
    expect(() => eng.prompt(fixtureDir, { prompt: 'hi' }, {})).toThrow('RPC 未预热')

    await eng.ensure(fixtureDir, {})
    expect(() => eng.prompt(fixtureDir, { prompt: 'hi', files: ['a.pdf'] }, {})).toThrow('不支持非图片文件')

    eng.prompt(fixtureDir, { prompt: 'hi' }, {})
    expect(() => eng.prompt(fixtureDir, { prompt: 'hi2' }, {})).toThrow('忙碌中')
  })

  it('会话切换触发 new_session；切回默认模型/思考时恢复默认值', async () => {
    const child = makeMockChild({ stateData: { model: { id: 'm-default' }, thinkingLevel: 'medium' } })
    const eng = createRpcEngine({ core, spawn: () => child })
    await eng.ensure(fixtureDir, {})

    const runOne = opts => new Promise((resolve, reject) => {
      eng.prompt(fixtureDir, opts, {
        onDone: resolve,
        onError: msg => reject(new Error(msg)),
      })
    })

    await runOne({ prompt: '1', sessionId: 'pideck-s1', model: 'm-custom', thinking: 'off' })
    await runOne({ prompt: '2', sessionId: 'pideck-s2', model: '', thinking: '' })

    const types = child.sent.map(c => c.type)
    expect(types.filter(t => t === 'new_session').length).toBe(2)
    expect(child.sent.filter(c => c.type === 'set_model').map(c => c.model)).toEqual(['m-custom', 'm-default'])
    expect(child.sent.filter(c => c.type === 'set_thinking_level').map(c => c.level)).toEqual(['off', 'medium'])
  })

  it('15 轮对话不泄漏 exit 监听器；中途退出仅触发一次 onError', async () => {
    const child = makeMockChild()
    const eng = createRpcEngine({ core, spawn: () => child })
    await eng.ensure(fixtureDir, {})

    const baseListeners = child.listenerCount('exit')
    for (let i = 0; i < 15; i++) {
      await new Promise(resolve => {
        eng.prompt(fixtureDir, { prompt: `msg ${i}`, sessionId: 'pideck-same' }, { onDone: resolve })
      })
    }
    expect(child.listenerCount('exit')).toBe(baseListeners)

    // 模拟发送阶段进程突然退出
    const busyChild = makeMockChild({ keepPromptOpen: true })
    const eng2 = createRpcEngine({ core, spawn: () => busyChild })
    await eng2.ensure(fixtureDir, {})
    let errors = 0
    eng2.prompt(fixtureDir, { prompt: 'x', sessionId: 'pideck-s1' }, {
      onError: () => { errors++ },
    })
    busyChild.emit('exit', 1)
    await new Promise(r => setTimeout(r, 10))
    expect(errors).toBe(1)
  })

  it('hasSession 只在该进程持有同一会话时为真，getCachedDefaults 返回默认模型与思考强度', async () => {
    const child = makeMockChild({ stateData: { model: { id: 'm-def', name: 'M Def' }, thinkingLevel: 'low' } })
    const eng = createRpcEngine({ core, spawn: () => child })
    expect(eng.getCachedDefaults(fixtureDir, {})).toBeNull()
    await eng.ensure(fixtureDir, {})
    expect(eng.getCachedDefaults(fixtureDir, {})).toEqual({
      modelId: 'm-def',
      modelName: 'M Def',
      thinkingLevel: 'low',
    })
    expect(eng.hasSession(fixtureDir, {}, 'pideck-s1')).toBe(false)
    await new Promise(resolve => {
      eng.prompt(fixtureDir, { prompt: 'a', sessionId: 'pideck-s1' }, { onDone: resolve })
    })
    expect(eng.hasSession(fixtureDir, {}, 'pideck-s1')).toBe(true)
    expect(eng.hasSession(fixtureDir, {}, 'pideck-s2')).toBe(false)
  })

  it('忙碌进程不会被 cleanupIdle 或 evictOverflow 误杀', async () => {
    const children = []
    const eng = createRpcEngine({
      core,
      idleTtl: 1,
      maxProcs: 1,
      spawn: () => {
        const c = makeMockChild({ keepPromptOpen: true })
        children.push(c)
        return c
      },
    })
    await eng.ensure(fixtureDir, { systemPrompt: 'A' })
    eng.prompt(fixtureDir, { prompt: 'busy', systemPrompt: 'A' }, {})

    // 等待超过 idleTtl=1ms，忙碌进程不应被 cleanupIdle 清理
    await new Promise(r => setTimeout(r, 15))
    eng.cleanupIdle()
    expect(children[0].stdinEnded).toBe(false)
    expect(eng._processes.size).toBe(1)

    // 再起第二个进程超出 maxProcs=1，忙碌中的第一个进程不应被淘汰
    await eng.ensure(fixtureDir, { systemPrompt: 'B' })
    expect(children[0].stdinEnded).toBe(false)
    expect(eng._processes.size).toBe(2)
  })

  it('svg 图片使用 image/svg+xml MIME，且超限本地图片同步抛错触发回退并清理监听', async () => {
    const svgFile = join(fixtureDir, 'icon.svg')
    const bigFile = join(fixtureDir, 'huge.png')
    writeFileSync(svgFile, '<svg></svg>')
    writeFileSync(bigFile, 'x'.repeat(200))

    const child = makeMockChild()
    const eng = createRpcEngine({ core, maxImageBytes: 50, spawn: () => child })
    await eng.ensure(fixtureDir, {})

    await new Promise((resolve, reject) => {
      eng.prompt(fixtureDir, { prompt: 'see svg', files: [svgFile] }, {
        onDone: resolve,
        onError: m => reject(new Error(m)),
      })
    })
    const promptCmd = child.sent.find(c => c.type === 'prompt')
    expect(promptCmd.images[0].mimeType).toBe('image/svg+xml')

    const baseListeners = child.listenerCount('exit')
    expect(() => eng.prompt(fixtureDir, { prompt: 'huge', files: [bigFile] }, {})).toThrow('图片过大')
    expect(child.listenerCount('exit')).toBe(baseListeners)
  })
})
