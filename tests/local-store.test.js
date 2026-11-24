import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, rmSync, utimesSync, readFileSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const { createLocalStore, isAllowedExternalUrl, isPathWithinRoot, resolveSafeOpenTarget } = await import('../shared/local-store.cjs')

let tmpRoot
let store
let clock

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'pideck-ls-test-'))
  clock = 1_700_000_000_000
  store = createLocalStore({
    cacheDir: join(tmpRoot, 'cache'),
    cacheTtl: 5 * 60 * 1000,
    configFile: join(tmpRoot, 'cfg', 'config.json'),
    legacyConfigFile: join(tmpRoot, 'legacy', 'config.json'),
    localStateFile: join(tmpRoot, 'cfg', 'state.json'),
    imageDir: join(tmpRoot, 'images'),
    maxImageBytes: 1024,
    now: () => clock,
  })
})

afterEach(() => {
  try { rmSync(tmpRoot, { recursive: true, force: true }) } catch (_) {}
})

describe('local-store 缓存读写与校验', () => {
  it('写入并读取缓存，过期后返回 null', () => {
    expect(store.writeCache('models', [{ id: 'm1' }])).toBe(true)
    expect(store.readCache('models')).toEqual([{ id: 'm1' }])

    clock += 5 * 60 * 1000 + 1
    expect(store.readCache('models')).toBeNull()
  })

  it('非法 key 一律拒绝，坏 JSON 容错返回 null', () => {
    expect(store.writeCache('../evil', { a: 1 })).toBe(false)
    expect(store.writeCache('bad/key', { a: 1 })).toBe(false)
    expect(store.readCache('../evil')).toBeNull()

    mkdirSync(join(tmpRoot, 'cache'), { recursive: true })
    writeFileSync(join(tmpRoot, 'cache', 'broken.json'), '{not-json')
    expect(store.readCache('broken')).toBeNull()
  })
})

describe('local-store 配置读写与本地状态', () => {
  it('不存在时返回空对象，saveConfig 合并 patch 持久化，主配置缺失时回退 legacyConfigFile', () => {
    expect(store.loadConfig()).toEqual({})

    mkdirSync(join(tmpRoot, 'legacy'), { recursive: true })
    writeFileSync(join(tmpRoot, 'legacy', 'config.json'), JSON.stringify({ engine: 'rpc' }))
    expect(store.loadConfig()).toEqual({ engine: 'rpc' })

    expect(store.saveConfig({ theme: 'dark' })).toEqual({ engine: 'rpc', theme: 'dark' })
    expect(store.loadConfig()).toEqual({ engine: 'rpc', theme: 'dark' })
  })

  it('readLocal/writeLocal/removeLocal 读写本机状态字典', () => {
    expect(store.readLocal('drafts', {})).toEqual({})
    expect(store.writeLocal('drafts', { chat: 'hello' })).toBe(true)
    expect(store.readLocal('drafts', {})).toEqual({ chat: 'hello' })
    expect(store.removeLocal('drafts')).toBe(true)
    expect(store.readLocal('drafts', null)).toBeNull()
  })
})

describe('local-store 图片落盘与 24h 清理', () => {
  it('合法 dataUrl 落盘，非法格式/扩展名/超限拒绝', () => {
    const pngB64 = Buffer.from('fake-png-data').toString('base64')
    const out = store.saveImage(`data:image/png;base64,${pngB64}`)
    expect(existsSync(out)).toBe(true)
    expect(out.endsWith('.png')).toBe(true)
    expect(readFileSync(out, 'utf8')).toBe('fake-png-data')

    expect(() => store.saveImage('not-a-data-url')).toThrow()
    expect(() => store.saveImage(`data:image/exe;base64,${pngB64}`)).toThrow()
    expect(() => store.saveImage(`data:image/png;base64,${Buffer.alloc(2048).toString('base64')}`)).toThrow()
  })

  it('cleanupImages 删除超过 24h 的旧文件，保留新文件', () => {
    const imgDir = join(tmpRoot, 'images')
    mkdirSync(imgDir, { recursive: true })
    const oldFile = join(imgDir, 'old.png')
    const freshFile = join(imgDir, 'fresh.png')
    writeFileSync(oldFile, 'old')
    writeFileSync(freshFile, 'fresh')

    const oldTime = new Date(clock - 25 * 3600 * 1000)
    const freshTime = new Date(clock - 1 * 3600 * 1000)
    utimesSync(oldFile, oldTime, oldTime)
    utimesSync(freshFile, freshTime, freshTime)

    const removed = store.cleanupImages()
    expect(removed).toBe(1)
    expect(existsSync(oldFile)).toBe(false)
    expect(existsSync(freshFile)).toBe(true)
  })
})

describe('isAllowedExternalUrl 协议白名单', () => {
  it('仅放行 http 与 https', () => {
    expect(isAllowedExternalUrl('https://example.com/a?x=1')).toBe('https://example.com/a?x=1')
    expect(isAllowedExternalUrl('http://localhost:5173')).toBe('http://localhost:5173/')
    expect(isAllowedExternalUrl('file:///C:/Windows/System32/calc.exe')).toBe('')
    expect(isAllowedExternalUrl('javascript:alert(1)')).toBe('')
    expect(isAllowedExternalUrl('cmd://calc')).toBe('')
    expect(isAllowedExternalUrl('data:text/html,<script>')).toBe('')
    expect(isAllowedExternalUrl('not a url')).toBe('')
  })
})

describe('isPathWithinRoot 与 resolveSafeOpenTarget 路径白名单', () => {
  it('放行白名单根目录内的文件与目录，拒绝兄弟前缀、.. 穿越及未授权路径', () => {
    const ws = join(tmpRoot, 'ws')
    const sibling = join(tmpRoot, 'ws-other')
    const outside = join(tmpRoot, 'outside')
    mkdirSync(join(ws, 'sub'), { recursive: true })
    mkdirSync(sibling, { recursive: true })
    mkdirSync(outside, { recursive: true })
    const fileInWs = join(ws, 'sub', 'notes.md')
    const fileInSibling = join(sibling, 'secret.txt')
    const fileOutside = join(outside, 'app.exe')
    writeFileSync(fileInWs, 'ok')
    writeFileSync(fileInSibling, 'no')
    writeFileSync(fileOutside, 'no')

    expect(isPathWithinRoot(fileInWs, ws)).toBe(true)
    expect(isPathWithinRoot(fileInSibling, ws)).toBe(false)

    const okDir = resolveSafeOpenTarget(join(ws, 'sub'), [ws])
    expect(okDir.ok).toBe(true)
    expect(okDir.isDir).toBe(true)

    const okFile = resolveSafeOpenTarget(fileInWs, [ws])
    expect(okFile.ok).toBe(true)
    expect(okFile.isFile).toBe(true)

    expect(resolveSafeOpenTarget(fileInSibling, [ws]).ok).toBe(false)
    expect(resolveSafeOpenTarget(join(ws, '..', 'outside', 'app.exe'), [ws]).ok).toBe(false)
    expect(resolveSafeOpenTarget(join(ws, 'missing.txt'), [ws]).ok).toBe(false)

    // 符号链接逃逸应被 realpathSync 拦截（Windows 无权限创建 symlink 时跳过）
    const escapeLink = join(ws, 'escape.exe')
    let linked = false
    try { symlinkSync(fileOutside, escapeLink); linked = true } catch (_) {}
    if (linked) {
      expect(resolveSafeOpenTarget(escapeLink, [ws]).ok).toBe(false)
    }
  })
})
