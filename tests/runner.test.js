import { describe, it, expect } from 'vitest'
import { EventEmitter } from 'node:events'
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const { toolSummary, isRiskTool, createRunner } = await import('../shared/runner.cjs')

describe('runner 审计与工具判定', () => {
  it('isRiskTool 将只读之外的工具视为风险工具', () => {
    expect(isRiskTool('read')).toBe(false)
    expect(isRiskTool('grep')).toBe(false)
    expect(isRiskTool('find')).toBe(false)
    expect(isRiskTool('ls')).toBe(false)
    expect(isRiskTool('edit')).toBe(true)
    expect(isRiskTool('write')).toBe(true)
    expect(isRiskTool('bash')).toBe(true)
    expect(isRiskTool('mcp__fs__write')).toBe(true)
  })

  it('toolSummary 准确汇总内置工具、MCP、扩展与项目配置状态', () => {
    expect(toolSummary(null)).toBe('无工具')
    expect(toolSummary({
      list: ['read', 'bash'],
      mcp: 'servers',
      mcpServers: 'github',
      ext: true,
      skills: 'some',
      skillPaths: ['/a', '/b'],
      context: true,
      trust: true,
    })).toBe('read,bash · MCP github · 扩展开 · 技能 2 个 · 项目规范 · 项目配置')
  })

  it('wrapHandlers 记录工具与汇总审计且终态回调幂等', () => {
    const entries = []
    let doneCount = 0
    const runner = createRunner({
      auditRecord: e => { entries.push(e); return true },
    })
    const wrapped = runner.wrapHandlers(
      { groupId: 'agent', groupName: '智能体', cwd: '/ws', promptPreview: 'hi', tool: { list: ['read', 'bash'], mcp: 'off' } },
      { onDone: () => { doneCount++ } },
      { engine: 'json' },
    )
    wrapped.onTool('start', 'bash', { cmd: 'ls' }, 't1')
    wrapped.onTool('end', 'bash', 'ok', 't1')
    wrapped.onUsage({ totalTokens: 42 })
    wrapped.onDone({ aborted: false })
    wrapped.onDone({ aborted: false })

    expect(doneCount).toBe(1)
    expect(entries).toHaveLength(2)
    expect(entries[0]).toMatchObject({ type: 'tool', risk: true, engine: 'json' })
    expect(entries[1]).toMatchObject({ type: 'run', engine: 'json', usage: { totalTokens: 42 }, aborted: false })
  })

  it('独立调用 runner.cancel() 取消 JSON 子进程时触发 onDone({ aborted: true }) 而非 onError', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'pideck-runner-'))
    const fakeCli = join(tmp, 'cli.js')
    writeFileSync(fakeCli, '// fake\n')
    try {
      let childRef = null
      const runner = createRunner({
        core: {
          applyLeanSystemPrompt: o => o,
          resolvePi: () => ({ node: process.execPath, cli: fakeCli }),
          buildArgs: () => [fakeCli],
          effectiveCwd: () => tmp,
          makeLineBuffer: () => ({ value: '' }),
          makeTextStream: () => ({ push: () => '', end: () => '' }),
          pushChunk: () => {},
          mapPiEvent: () => false,
        },
        spawn: () => {
          const c = new EventEmitter()
          c.stdout = new EventEmitter()
          c.stderr = new EventEmitter()
          c.kill = () => { c.emit('close', null) }
          childRef = c
          return c
        },
      })

      let donePayload = null
      let errMsg = ''
      runner.run({ prompt: 'hi', cwd: tmp }, {
        onDone: p => { donePayload = p },
        onError: m => { errMsg = m },
      })
      expect(childRef).toBeTruthy()
      expect(runner.cancel()).toBe(true)
      expect(donePayload).toEqual({ aborted: true })
      expect(errMsg).toBe('')
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('不暴露通用 openTerminal；openInstallTerminal / openLoginTerminal 仅允许固定意图且严格校验 provider', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'pideck-term-'))
    try {
      const spawns = []
      const runner = createRunner({
        tempDir: tmp,
        core: {
          PI_INSTALL_CMD: 'npm i -g @earendil-works/pi-coding-agent',
          resolvePi: () => ({ node: 'C:\\Program Files\\nodejs\\node.exe', cli: 'C:\\pi\\cli.js' }),
        },
        spawn: (cmd, args) => {
          spawns.push({ cmd, args })
          const c = new EventEmitter()
          c.unref = () => {}
          return c
        },
      })
      expect(runner.openTerminal).toBeUndefined()
      expect(runner.openLoginTerminal('')).toBe(false)
      expect(runner.openLoginTerminal('openai && calc')).toBe(false)
      expect(runner.openLoginTerminal('openai\ncalc.exe')).toBe(false)
      expect(runner.openLoginTerminal('constructor')).toBe(false)
      expect(runner.openLoginTerminal('__proto__')).toBe(false)
      expect(spawns).toHaveLength(0)

      if (process.platform === 'win32' || process.platform === 'darwin') {
        expect(runner.openInstallTerminal()).toBe(true)
        expect(runner.openLoginTerminal('deepseek')).toBe(true)
        expect(spawns).toHaveLength(2)
        if (process.platform === 'win32') {
          const cmds = readdirSync(tmp).filter(n => n.endsWith('.cmd')).sort()
          expect(cmds).toHaveLength(2)
          const contents = cmds.map(n => readFileSync(join(tmp, n), 'utf8')).join('\n')
          expect(contents).toContain('npm i -g @earendil-works/pi-coding-agent')
          expect(contents).toContain('"C:\\Program Files\\nodejs\\node.exe" "C:\\pi\\cli.js" auth login deepseek')
        }
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('listModelsAsync 合并并发请求并使用 TTL 缓存，force=true 绕过缓存', async () => {
    let calls = 0
    const runner = createRunner({
      core: {
        resolvePiAsync: async () => ({ node: 'node', cli: 'cli.js' }),
        parseModelsOutput: s => [{ provider: 'p', model: String(s).trim(), display: 'p/' + String(s).trim() }],
      },
      execFile: (_node, _args, _opts, cb) => {
        calls++
        const n = calls
        setTimeout(() => cb(null, `m${n}\n`), 10)
      },
    })

    const [a, b] = await Promise.all([runner.listModelsAsync(), runner.listModelsAsync()])
    expect(calls).toBe(1)
    expect(a).toEqual([{ provider: 'p', model: 'm1', display: 'p/m1' }])
    expect(b).toEqual(a)

    const c = await runner.listModelsAsync()
    expect(calls).toBe(1)
    expect(c).toEqual(a)

    const d = await runner.listModelsAsync({ force: true })
    expect(calls).toBe(2)
    expect(d).toEqual([{ provider: 'p', model: 'm2', display: 'p/m2' }])
  })
})
