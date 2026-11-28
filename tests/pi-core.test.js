import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, readdirSync, rmSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// findPiCli/findNode 依赖文件系统探测：用运行时 tmp 假 cli.js + 当前 node 注入环境变量，
// 使 buildArgs 等纯逻辑不依赖真实 pi 安装
const fixtureDir = mkdtempSync(join(tmpdir(), 'pideck-test-'))
const fakeCli = join(fixtureDir, 'cli.js')
writeFileSync(fakeCli, '// fake pi cli for tests\n')
process.env.PIDECK_PI_CLI = fakeCli
process.env.PIDECK_NODE = process.execPath

const core = await import('../shared/pi-core.cjs')

afterAll(() => {
  try { rmSync(fixtureDir, { recursive: true, force: true }) } catch (_) {}
})

// 构造完整精细工具对象（与 groups.js makeTool 产物形状一致）
function tool(over = {}) {
  return {
    list: ['read', 'grep', 'find', 'ls'],
    mcp: 'off', mcpServers: '', ext: false,
    skills: 'off', skillPaths: [],
    context: false, templates: false, trust: false,
    ...over,
  }
}

describe('buildPermArgs 权限档位 → pi argv', () => {
  it('纯文本档：-nt 且全关', () => {
    expect(core.buildPermArgs(tool({ list: [] }))).toEqual([
      '-nt', '--no-mcp', '-ne', '-ns', '-nc', '-np', '--no-approve',
    ])
  })

  it('只读档：--tools 白名单，无写执行工具', () => {
    expect(core.buildPermArgs(tool())).toEqual([
      '--tools', 'read,grep,find,ls', '--no-mcp', '-ne', '-ns', '-nc', '-np', '--no-approve',
    ])
  })

  it('完整档：全工具 + MCP/扩展/规范全开（ext=true 无 -ne）', () => {
    expect(core.buildPermArgs(tool({
      list: ['read', 'grep', 'find', 'ls', 'edit', 'write', 'bash', 'powershell'],
      mcp: 'all', ext: true, skills: 'all', context: true, templates: true,
    }))).toEqual([
      '--tools', 'read,grep,find,ls,edit,write,bash,powershell', '--no-approve',
    ])
  })

  it('MCP 指定 server：白名单追加 mcp__srv__*，ext 关时 builtin:mcp 挂回', () => {
    expect(core.buildPermArgs(tool({
      list: ['read'], mcp: 'servers', mcpServers: 'a, b', skills: 'all',
    }))).toEqual([
      '--tools', 'read,mcp__a__*,mcp__b__*', '-ne', '-e', 'builtin:mcp', '-nc', '-np', '--no-approve',
    ])
  })

  it('MCP 指定但没填 server 名：按关闭处理，不放行全部', () => {
    const args = core.buildPermArgs(tool({ mcp: 'servers', mcpServers: '  ' }))
    expect(args).toContain('--no-mcp')
    expect(args.join(' ')).not.toContain('mcp__')
  })

  it('技能指定：-ns 后按目录显式 --skill', () => {
    expect(core.buildPermArgs(tool({ skills: 'some', skillPaths: ['/p1', '/p2'] }))).toEqual([
      '--tools', 'read,grep,find,ls', '--no-mcp', '-ne',
      '-ns', '--skill', '/p1', '--skill', '/p2',
      '-nc', '-np', '--no-approve',
    ])
  })

  it('trust=true → --approve', () => {
    expect(core.buildPermArgs(tool({ trust: true }))).toContain('--approve')
    expect(core.buildPermArgs(tool({ trust: true }))).not.toContain('--no-approve')
  })

  it('无内置工具 + MCP 指定 server：仍用 --tools 过滤而不退化为 -nt 全放开', () => {
    expect(core.buildPermArgs(tool({ list: [], mcp: 'servers', mcpServers: 'github' }))).toEqual([
      '--tools', 'mcp__github__*', '-ne', '-e', 'builtin:mcp', '-ns', '-nc', '-np', '--no-approve',
    ])
  })
})

describe('permFlags / applyLeanSystemPrompt', () => {
  it('无内置工具但开了 MCP 或扩展时，noTools 为 false 且不替换 systemPrompt', () => {
    expect(core.permFlags({ tool: tool({ list: [], mcp: 'all' }) })).toEqual({ noTools: false })
    expect(core.permFlags({ tool: tool({ list: [], ext: true }) })).toEqual({ noTools: false })
    expect(core.permFlags({ tool: tool({ list: [] }) })).toEqual({ noTools: true })

    const withMcp = core.applyLeanSystemPrompt({ prompt: 'hi', tool: tool({ list: [], mcp: 'all' }) })
    expect(withMcp.systemPrompt).toBeUndefined()

    const pureText = core.applyLeanSystemPrompt({ prompt: 'hi', tool: tool({ list: [] }) })
    expect(pureText.systemPrompt).toBe(core.LEAN_SYSTEM_PROMPT)
  })
})

describe('parseModelsOutput 与 listFiles 符号链接', () => {
  it('parseModelsOutput 解析多空格分隔模型表', () => {
    const out = [
      'provider   model            context',
      'openai     gpt-4o           128k',
      'anthropic  claude-sonnet-4  200k',
    ].join('\n')
    expect(core.parseModelsOutput(out)).toEqual([
      { provider: 'openai', model: 'gpt-4o', display: 'openai/gpt-4o' },
      { provider: 'anthropic', model: 'claude-sonnet-4', display: 'anthropic/claude-sonnet-4' },
    ])
  })

  it('listFiles 正确处理普通文件及安全跳过循环/坏符号链接', () => {
    const ws = mkdtempSync(join(fixtureDir, 'ws-'))
    writeFileSync(join(ws, 'a.txt'), 'hi')
    const sub = join(ws, 'sub')
    mkdirSync(sub)
    writeFileSync(join(sub, 'b.txt'), 'world')
    try { symlinkSync(join(ws, 'a.txt'), join(ws, 'link-file.txt')) } catch (_) {}
    try { symlinkSync(ws, join(sub, 'loop-dir')) } catch (_) {}
    const items = core.listFiles(ws, '')
    expect(items.find(x => x.path === 'a.txt')).toEqual({ path: 'a.txt', dir: false })
    const lf = items.find(x => x.path === 'link-file.txt')
    if (lf) expect(lf.dir).toBe(false)
    expect(items.find(x => x.path === 'sub/b.txt')).toEqual({ path: 'sub/b.txt', dir: false })
  })
})

describe('normalizeTool 规范化与路径覆盖', () => {
  it('未传 tool 时默认最安全只读档且其余全关', () => {
    const t = core.normalizeTool(undefined)
    expect(t.list).toEqual(['read', 'grep', 'find', 'ls'])
    expect(t.mcp).toBe('off')
    expect(t.skills).toBe('off')
    expect(t.context).toBe(false)
    expect(t.trust).toBe(false)
  })

  it('list 内非法工具名被过滤', () => {
    const t = core.normalizeTool(tool({ list: ['read', 'rm-rf', 'bash'] }))
    expect(t.list).toEqual(['read', 'bash'])
  })

  it('setPathOverrides 可覆盖并恢复测试路径', () => {
    expect(core.PI_INSTALL_CMD).toContain('@earendil-works/pi-coding-agent')
    core.setPathOverrides({ nodePath: process.execPath, piCliPath: fakeCli })
    expect(core.resolvePi()).toEqual({ node: process.execPath, cli: fakeCli })
    core.setPathOverrides({ nodePath: '', piCliPath: '' })
    expect(core.resolvePi()).toEqual({ node: process.execPath, cli: fakeCli })
  })

  it('getEnv 独立探测 Node 与 pi CLI，缺失 pi 时仍保留 nodePath 与 nodeVersion', () => {
    const env = core.getEnv({
      findNode: () => process.execPath,
      findPiCli: () => {
        const err = new Error('未找到 pi CLI')
        err.code = 'PI_MISSING'
        throw err
      },
    })
    expect(env.ok).toBe(false)
    expect(env.errorCode).toBe('PI_MISSING')
    expect(env.nodePath).toBe(process.execPath)
    expect(env.nodeVersion).toMatch(/^v\d+/)
    expect(env.piPath).toBe('')
  })
})

describe('buildArgs spawn 参数', () => {
  it('基础结构：cli 在首、--no-session 紧随模式、-- 后置参数收尾', () => {
    const args = core.buildArgs({ prompt: 'hi' })
    expect(args[0]).toBe(fakeCli)
    expect(args.slice(1, 4)).toEqual(['--mode', 'json', '--no-session'])
    expect(args[args.length - 1]).toBe('hi')
    expect(args).toContain('--')
  })

  it('sessionId 替代 --no-session', () => {
    const args = core.buildArgs({ prompt: 'x', sessionId: 'pideck-abc123' })
    expect(args).toContain('--session-id')
    expect(args[args.indexOf('--session-id') + 1]).toBe('pideck-abc123')
    expect(args).not.toContain('--no-session')
  })

  it('选项值以 - 开头时被丢弃（防参数注入）', () => {
    const args = core.buildArgs({ prompt: 'x', model: '--danger', sessionId: '-evil' })
    expect(args).not.toContain('--danger')
    expect(args).not.toContain('-evil')
    expect(args).toContain('--no-session')
  })

  it('files 前缀 @ 且位于 -- 之后，prompt 最后', () => {
    const args = core.buildArgs({ prompt: 'do it', files: ['a.txt', 'b.png'] })
    const i = args.indexOf('--')
    expect(args.slice(i + 1)).toEqual(['@a.txt', '@b.png', 'do it'])
  })

  it('systemPrompt 透传', () => {
    const args = core.buildArgs({ prompt: 'x', systemPrompt: 'SP' })
    expect(args[args.indexOf('--system-prompt') + 1]).toBe('SP')
  })
})

describe('makeTextStream / pushChunk 跨 chunk UTF-8', () => {
  it('makeTextStream：多字节字符跨 chunk 不乱码', () => {
    const ts = core.makeTextStream()
    // "中" = e4 b8 ad，人为从字节中间切开
    const a = Buffer.concat([Buffer.from('err: '), Buffer.from([0xe4])])
    const b = Buffer.concat([Buffer.from([0xb8, 0xad]), Buffer.from('文 ok')])
    expect(ts.push(a) + ts.push(b)).toBe('err: 中文 ok')
  })

  it('pushChunk：JSONL 按 \n 切分、容忍 \\r、跳过坏行', () => {
    const buf = core.makeLineBuffer()
    const recs = []
    core.pushChunk(buf, Buffer.from('{"a":1}\r\nbad\n{"b":2}\n'), r => recs.push(r))
    expect(recs).toEqual([{ a: 1 }, { b: 2 }])
  })

  it('pushChunk：多字节字符跨 chunk 不丢记录', () => {
    const buf = core.makeLineBuffer()
    const recs = []
    // "中" = e4 b8 ad 从字节中间切开；"文" = e6 96 87 完整落在第二个 chunk
    const head = Buffer.concat([Buffer.from('{"t":"'), Buffer.from([0xe4])])
    const tail = Buffer.concat([Buffer.from([0xb8, 0xad, 0xe6, 0x96, 0x87]), Buffer.from('"}\n')])
    core.pushChunk(buf, head, r => recs.push(r))
    core.pushChunk(buf, tail, r => recs.push(r))
    expect(recs).toEqual([{ t: '中文' }])
  })
})

describe('mapPiEvent 事件映射', () => {
  it('text_delta → onText；tool start/end → onTool', () => {
    const calls = { text: [], tool: [] }
    const settled = core.mapPiEvent(
      { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'hi' } },
      { onText: d => calls.text.push(d) },
    )
    expect(settled).toBe(false)
    expect(calls.text).toEqual(['hi'])

    core.mapPiEvent({ type: 'tool_execution_start', toolName: 'read', args: { p: 1 }, toolCallId: 't1' },
      { onTool: (...a) => calls.tool.push(a) })
    core.mapPiEvent({ type: 'tool_execution_end', toolName: 'read', result: 'ok', toolCallId: 't1' },
      { onTool: (...a) => calls.tool.push(a) })
    expect(calls.tool).toEqual([
      ['start', 'read', { p: 1 }, 't1'],
      ['end', 'read', 'ok', 't1'],
    ])
  })

  it('agent_settled → 返回 true', () => {
    expect(core.mapPiEvent({ type: 'agent_settled' }, {})).toBe(true)
    expect(core.mapPiEvent({ type: 'message_update' }, {})).toBe(false)
  })
})

describe('deletePiSession 会话文件清理（root 注入）', () => {
  let root
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'pideck-sess-'))
    const dir = join(root, 'C--Users-x')
    mkdirSync(dir)
    writeFileSync(join(dir, '20260101_000000_pideck-abc123.jsonl'), '')
    writeFileSync(join(dir, '20260101_000000_pideck-zzz999.jsonl'), '')
    writeFileSync(join(dir, 'unrelated.jsonl'), '')
  })
  afterAll(() => {
    try { rmSync(root, { recursive: true, force: true }) } catch (_) {}
  })

  it('合法 id：精确删除同后缀文件，其余保留', () => {
    const r = core.deletePiSession('pideck-abc123', root)
    expect(r.ok).toBe(true)
    expect(r.removed).toBe(1)
    const left = readdirSync(join(root, 'C--Users-x'))
    expect(left).toContain('20260101_000000_pideck-zzz999.jsonl')
    expect(left).toContain('unrelated.jsonl')
    expect(existsSync(join(root, 'C--Users-x', '20260101_000000_pideck-abc123.jsonl'))).toBe(false)
  })

  it('非法 id 一律拒绝', () => {
    expect(core.deletePiSession('../evil', root).ok).toBe(false)
    expect(core.deletePiSession('notpideck-abc', root).ok).toBe(false)
    expect(core.deletePiSession('', root).ok).toBe(false)
  })

  it('不存在的 id：ok 但 removed=0', () => {
    const r = core.deletePiSession('pideck-nothing', root)
    expect(r).toEqual({ ok: true, removed: 0 })
  })
})

describe('resolveCwd / effectiveCwd', () => {
  it('resolveCwd：有效目录原样返回，无效回退 ~/MyPiDeck（不建目录）', () => {
    expect(core.resolveCwd(fixtureDir)).toBe(fixtureDir)
    expect(core.resolveCwd('')).toBe(join(core.os.homedir(), 'MyPiDeck'))
    expect(core.resolveCwd('Z:\\__pideck_no_such__')).toBe(join(core.os.homedir(), 'MyPiDeck'))
  })

  it('effectiveCwd：有效目录原样返回（不触碰真实 HOME，避免 mkdir 污染）', () => {
    expect(core.effectiveCwd(fixtureDir)).toBe(fixtureDir)
  })
})

describe('异步路径解析、环境诊断、技能与文件扫描', () => {
  it('resolvePiAsync 与 seedResolvedPaths 快路径命中与失效回退', async () => {
    core.resetPiCache()
    const r = await core.resolvePiAsync()
    expect(r.node).toBe(process.execPath)
    expect(r.cli).toBe(fakeCli)

    // 测试 seedResolvedPaths：无 env override 时直接命中不存在的路径会被 access 拒绝并回退
    core.resetPiCache()
    const origNode = process.env.PIDECK_NODE
    const origCli = process.env.PIDECK_PI_CLI
    delete process.env.PIDECK_NODE
    delete process.env.PIDECK_PI_CLI
    core.seedResolvedPaths({ nodePath: process.execPath, nodeVersion: 'v22.19.0', piPath: fakeCli })
    try {
      const fast = await core.resolvePiAsync()
      expect(fast.node).toBe(process.execPath)
      expect(fast.cli).toBe(fakeCli)
    } finally {
      if (origNode !== undefined) process.env.PIDECK_NODE = origNode
      if (origCli !== undefined) process.env.PIDECK_PI_CLI = origCli
      core.resetPiCache()
    }
  })

  it('getEnvAsync 与 getEnv 字段保持一致', async () => {
    const syncEnv = core.getEnv()
    const asyncEnv = await core.getEnvAsync()
    expect(asyncEnv.ok).toBe(syncEnv.ok)
    expect(asyncEnv.agentDir).toBe(syncEnv.agentDir)
    expect(asyncEnv.configs.map(c => c.name)).toEqual(syncEnv.configs.map(c => c.name))
  })

  it('listFilesAsync 异步扫描目录并支持查询过滤', async () => {
    const ws = mkdtempSync(join(fixtureDir, 'async-ws-'))
    mkdirSync(join(ws, 'src'))
    writeFileSync(join(ws, 'README.md'), '# hi')
    writeFileSync(join(ws, 'src', 'app.js'), 'console.log(1)')
    const all = await core.listFilesAsync(ws)
    expect(all.some(f => f.path === 'README.md' && !f.dir)).toBe(true)
    expect(all.some(f => f.path === 'src/app.js' && !f.dir)).toBe(true)
    const filtered = await core.listFilesAsync(ws, 'app.js')
    expect(filtered).toEqual([{ path: 'src/app.js', dir: false }])
  })

  it('listSkillsAsync 异步扫描工作区技能', async () => {
    const ws = mkdtempSync(join(fixtureDir, 'async-sk-'))
    const skDir = join(ws, '.pi', 'skills', 'demo-skill')
    mkdirSync(skDir, { recursive: true })
    writeFileSync(join(skDir, 'SKILL.md'), '---\nname: demo-skill\ndescription: demo async\n---\nbody\n')
    const list = await core.listSkillsAsync(ws)
    expect(list.some(s => s.name === 'demo-skill' && s.description === 'demo async')).toBe(true)
  })
})

describe('validateNodeExecutable 与 validatePiCliPath 安全校验', () => {
  it('isNodeExecutableName 仅放行 node 可执行文件名', () => {
    expect(core.isNodeExecutableName('/usr/local/bin/node')).toBe(true)
    expect(core.isNodeExecutableName('C:\\Program Files\\nodejs\\node.exe')).toBe(true)
    expect(core.isNodeExecutableName('node-v22.19.0.exe')).toBe(true)
    expect(core.isNodeExecutableName('/bin/sh')).toBe(false)
    expect(core.isNodeExecutableName('bash')).toBe(false)
    expect(core.isNodeExecutableName('x.sh')).toBe(false)
    expect(core.isNodeExecutableName('node.js')).toBe(false)
    expect(core.isNodeExecutableName('node.cmd')).toBe(false)
  })

  it('validateNodeExecutable 放行合法 >=22.19 的 Node，拒绝目录、不存在路径及非 node 脚本', () => {
    const okRes = core.validateNodeExecutable(process.execPath)
    const [maj, min] = process.versions.node.split('.').map(Number)
    if (maj > 22 || (maj === 22 && min >= 19)) {
      expect(okRes.ok).toBe(true)
      expect(okRes.version).toMatch(/^v\d+/)
    } else {
      expect(okRes.ok).toBe(false)
    }

    expect(core.validateNodeExecutable('').ok).toBe(false)
    expect(core.validateNodeExecutable(fixtureDir).ok).toBe(false)
    expect(core.validateNodeExecutable(join(fixtureDir, 'missing-node.exe')).ok).toBe(false)

    const fakeSh = join(fixtureDir, 'evil.sh')
    writeFileSync(fakeSh, '#!/bin/sh\necho v24.0.0\n')
    expect(core.validateNodeExecutable(fakeSh).ok).toBe(false)

    const fakeNodeFile = join(fixtureDir, 'node.exe')
    writeFileSync(fakeNodeFile, 'not a binary')
    expect(core.validateNodeExecutable(fakeNodeFile).ok).toBe(false)
  })

  it('validatePiCliPath 仅放行 @earendil-works/pi-coding-agent 包内的常规 JS 文件', async () => {
    const pkgRoot = join(fixtureDir, 'nm', '@earendil-works', 'pi-coding-agent')
    const cliFile = join(pkgRoot, 'dist', 'bundle', 'cli.js')
    mkdirSync(join(pkgRoot, 'dist', 'bundle'), { recursive: true })
    writeFileSync(join(pkgRoot, 'package.json'), JSON.stringify({ name: '@earendil-works/pi-coding-agent', version: '0.9.1' }))
    writeFileSync(cliFile, '// valid cli')

    const ok = core.validatePiCliPath(cliFile)
    expect(ok.ok).toBe(true)
    expect(ok.version).toBe('0.9.1')

    expect(core.validatePiCliPath(fakeCli).ok).toBe(false)
    expect(core.validatePiCliPath(pkgRoot).ok).toBe(false)
    expect(core.validatePiCliPath(join(pkgRoot, 'package.json')).ok).toBe(false)

    // 目录名伪造但 package.json 名称不匹配应拒绝
    const spoofRoot = join(fixtureDir, 'spoof', '@earendil-works', 'pi-coding-agent')
    const spoofCli = join(spoofRoot, 'cli.js')
    mkdirSync(spoofRoot, { recursive: true })
    writeFileSync(join(spoofRoot, 'package.json'), JSON.stringify({ name: 'evil-pkg', version: '1.0.0' }))
    writeFileSync(spoofCli, '// spoof')
    expect(core.validatePiCliPath(spoofCli).ok).toBe(false)

    // 符号链接逃逸到包外脚本应被 realpathSync 拦截
    const escapeLink = join(pkgRoot, 'dist', 'escape.js')
    let linked = false
    try { symlinkSync(fakeCli, escapeLink); linked = true } catch (_) {}
    if (linked) {
      expect(core.validatePiCliPath(escapeLink).ok).toBe(false)
      expect((await core.validatePiCliPathAsync(escapeLink)).ok).toBe(false)
    }

    // 异步校验函数 validateNodeExecutableAsync / validatePiCliPathAsync 与同步版本一致
    expect((await core.validateNodeExecutableAsync(process.execPath)).ok).toBe(true)
    expect((await core.validateNodeExecutableAsync(fakeCli)).ok).toBe(false)
    expect((await core.validatePiCliPathAsync(cliFile)).ok).toBe(true)
    expect((await core.validatePiCliPathAsync(fakeCli)).ok).toBe(false)
  })

  it('严格校验参数边界、listFiles 拦截目录外符号链接及 deletePiSessions 批量安全删除', async () => {
    expect(core.validateCwd(null)).toBe(false)
    expect(core.validateCwd(123)).toBe(false)
    expect(() => core.buildArgs({ prompt: 'hi', files: ['data:image/png;base64,abc'] })).toThrow('data URL')

    // 非法 mcpServers、- 开头 skillPath、非 pideck- sessionId 与 - 开头 systemPrompt 处理
    const permArgs = core.buildPermArgs(tool({
      mcp: 'servers',
      mcpServers: 'good_1, bad server, --inject',
      skills: 'some',
      skillPaths: ['/ok/skill', '-evil', 'bad\npath'],
    }))
    expect(permArgs).toContain('read,grep,find,ls,mcp__good_1__*')
    expect(permArgs).not.toContain('-evil')
    expect(permArgs).toContain('/ok/skill')

    const args = core.buildArgs({ prompt: '@/etc/passwd', sessionId: 'other-id', systemPrompt: '--as-flag' })
    expect(args).toContain('--no-session')
    expect(args[args.indexOf('--system-prompt') + 1]).toBe(' --as-flag')
    expect(args[args.length - 1].startsWith('@')).toBe(false)
    expect(args[args.length - 1]).toContain('@/etc/passwd')

    // listFiles / listFilesAsync 拦截指向目录外的符号链接
    const ws = mkdtempSync(join(fixtureDir, 'ws-escape-'))
    const outside = mkdtempSync(join(fixtureDir, 'outside-'))
    writeFileSync(join(ws, 'in.txt'), 'ok')
    writeFileSync(join(outside, 'secret.txt'), 'no')
    let symOk = false
    try {
      symlinkSync(outside, join(ws, 'out-dir'))
      symlinkSync(join(outside, 'secret.txt'), join(ws, 'out-file.txt'))
      symOk = true
    } catch (_) {}
    if (symOk) {
      const syncList = core.listFiles(ws)
      const asyncList = await core.listFilesAsync(ws)
      expect(syncList.some(f => f.path.includes('secret.txt') || f.path.includes('out-dir'))).toBe(false)
      expect(asyncList.some(f => f.path.includes('secret.txt') || f.path.includes('out-dir'))).toBe(false)
    }

    // deletePiSessions 一次扫描批量删除且不删符号链接
    const sessRoot = mkdtempSync(join(fixtureDir, 'sess-batch-'))
    const sub = join(sessRoot, 'ws1')
    mkdirSync(sub)
    writeFileSync(join(sub, '20260101_000000_pideck-s1111.jsonl'), '')
    writeFileSync(join(sub, '20260101_000000_pideck-s2222.jsonl'), '')
    const linkSess = join(sub, '20260101_000000_pideck-link1.jsonl')
    try { symlinkSync(join(outside, 'secret.txt'), linkSess) } catch (_) {}
    const delRes = core.deletePiSessions(['pideck-s1111', 'pideck-s2222', 'pideck-link1'], sessRoot)
    expect(delRes).toEqual({ ok: true, removed: 2 })
    expect(existsSync(join(outside, 'secret.txt'))).toBe(true)
  })
})
