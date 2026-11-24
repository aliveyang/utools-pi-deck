import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, rmSync, utimesSync, readFileSync, statSync, symlinkSync } from 'node:fs'
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

  it('readCacheMeta 支持 fresh / stale / expired 三态与 removeCache', () => {
    expect(store.writeCache('models', [{ id: 'm1' }])).toBe(true)
    const fresh = store.readCacheMeta('models')
    expect(fresh).toMatchObject({ data: [{ id: 'm1' }], fresh: true })

    clock += 5 * 60 * 1000 + 10
    const stale = store.readCacheMeta('models')
    expect(stale).toMatchObject({ data: [{ id: 'm1' }], fresh: false })
    expect(store.readCache('models')).toBeNull()

    clock += 24 * 60 * 60 * 1000
    expect(store.readCacheMeta('models')).toBeNull()

    expect(store.writeCache('pi-resolved', { nodePath: '/n' })).toBe(true)
    expect(store.removeCache('pi-resolved')).toBe(true)
    expect(store.readCacheMeta('pi-resolved')).toBeNull()
  })

  it('非法 key 一律拒绝，坏 JSON 容错返回 null', () => {
    expect(store.writeCache('../evil', { a: 1 })).toBe(false)
    expect(store.writeCache('bad/key', { a: 1 })).toBe(false)
    expect(store.readCache('../evil')).toBeNull()

    mkdirSync(join(tmpRoot, 'cache'), { recursive: true })
    writeFileSync(join(tmpRoot, 'cache', 'broken.json'), '{not-json')
    expect(store.readCache('broken')).toBeNull()
  })

  it('readCacheMetaAsync 支持 fresh / stale / expired 与非法 key 拒绝', async () => {
    expect(await store.readCacheMetaAsync('../evil')).toBeNull()
    expect(store.writeCache('models', [{ id: 'm1' }])).toBe(true)
    expect(await store.readCacheMetaAsync('models')).toMatchObject({ data: [{ id: 'm1' }], fresh: true })

    clock += 5 * 60 * 1000 + 10
    expect(await store.readCacheMetaAsync('models')).toMatchObject({ data: [{ id: 'm1' }], fresh: false })

    clock += 24 * 60 * 60 * 1000
    expect(await store.readCacheMetaAsync('models')).toBeNull()
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

  it('readLocal/writeLocal/removeLocal 读写本机状态字典且无变化时跳过重复写盘', () => {
    expect(store.readLocal('drafts', {})).toEqual({})
    expect(store.writeLocal('drafts', { chat: 'hello' })).toBe(true)
    expect(store.readLocal('drafts', {})).toEqual({ chat: 'hello' })

    const oldTime = new Date(clock - 60000)
    utimesSync(store.localStateFile, oldTime, oldTime)
    expect(store.writeLocal('drafts', { chat: 'hello' })).toBe(true)
    expect(existsSync(store.localStateFile)).toBe(true)
    const afterSameWrite = readFileSync(store.localStateFile, 'utf8')
    expect(JSON.parse(afterSameWrite).drafts).toEqual({ chat: 'hello' })
    const mtimeAfterSame = statSync(store.localStateFile).mtimeMs
    expect(mtimeAfterSame).toBe(oldTime.getTime())

    expect(store.removeLocal('drafts')).toBe(true)
    expect(store.readLocal('drafts', null)).toBeNull()
  })

  it('loadConfigAsync 含 legacy 回退与 mtime 缓存复用；readLocalAsync 正确读取并回退', async () => {
    expect(await store.loadConfigAsync()).toEqual({})

    mkdirSync(join(tmpRoot, 'legacy'), { recursive: true })
    writeFileSync(join(tmpRoot, 'legacy', 'config.json'), JSON.stringify({ engine: 'rpc' }))
    expect(await store.loadConfigAsync()).toEqual({ engine: 'rpc' })

    store.saveConfig({ theme: 'dark' })
    expect(await store.loadConfigAsync()).toEqual({ engine: 'rpc', theme: 'dark' })
    // 命中内存 mtime 缓存分支
    expect(await store.loadConfigAsync()).toEqual({ engine: 'rpc', theme: 'dark' })

    expect(await store.readLocalAsync('drafts', {})).toEqual({})
    expect(store.writeLocal('drafts', { chat: 'async-hi' })).toBe(true)
    expect(await store.readLocalAsync('drafts', {})).toEqual({ chat: 'async-hi' })
  })
})

describe('local-store 图片落盘、过期与容量淘汰、安全清理', () => {
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

  it('cleanupImages 默认 30 天（可配 imageMaxAgeMs）删除过期文件并保留新文件', () => {
    const imgDir = join(tmpRoot, 'images')
    mkdirSync(imgDir, { recursive: true })
    const oldFile = join(imgDir, 'old.png')
    const freshFile = join(imgDir, 'fresh.png')
    writeFileSync(oldFile, 'old')
    writeFileSync(freshFile, 'fresh')

    const oldTime = new Date(clock - 31 * 24 * 3600 * 1000)
    const freshTime = new Date(clock - 5 * 24 * 3600 * 1000)
    utimesSync(oldFile, oldTime, oldTime)
    utimesSync(freshFile, freshTime, freshTime)

    const removed = store.cleanupImages()
    expect(removed).toBe(1)
    expect(existsSync(oldFile)).toBe(false)
    expect(existsSync(freshFile)).toBe(true)

    const customStore = createLocalStore({
      imageDir: imgDir,
      imageMaxAgeMs: 2 * 24 * 3600 * 1000,
      now: () => clock,
    })
    expect(customStore.cleanupImages()).toBe(1)
    expect(existsSync(freshFile)).toBe(false)
  })

  it('总容量超出 maxImageTotalBytes 时按 mtime 淘汰最旧图片，且 saveImage 保护刚写入的新图', () => {
    const imgDir = join(tmpRoot, 'lru-images')
    const lruStore = createLocalStore({
      imageDir: imgDir,
      maxImageBytes: 250,
      maxImageTotalBytes: 220,
      now: () => clock,
    })
    const first = lruStore.saveImage(`data:image/png;base64,${Buffer.alloc(50, 1).toString('base64')}`)
    clock += 1000
    const second = lruStore.saveImage(`data:image/png;base64,${Buffer.alloc(50, 2).toString('base64')}`)
    // 将后写入的 second 设为更早 mtime，验证淘汰依据是 mtimeMs 而非文件名顺序
    utimesSync(first, new Date(clock - 1000), new Date(clock - 1000))
    utimesSync(second, new Date(clock - 5000), new Date(clock - 5000))
    const firstSize = statSync(first).size
    const secondSize = statSync(second).size
    expect(existsSync(first)).toBe(true)
    expect(existsSync(second)).toBe(true)

    clock += 1000
    // third 占 70B，三张总计 170B > 140B，但淘汰 1 张 50B 后剩余 120B <= 140B：应仅淘汰 mtime 最旧的 second
    const thirdSizeCapStore = createLocalStore({
      imageDir: imgDir,
      maxImageBytes: 250,
      maxImageTotalBytes: 140,
      now: () => clock,
    })
    const third = thirdSizeCapStore.saveImage(`data:image/png;base64,${Buffer.alloc(70, 3).toString('base64')}`)
    expect(statSync(third).size).toBe(70)
    expect(firstSize + secondSize + statSync(third).size).toBe(170)
    expect(existsSync(second)).toBe(false)
    expect(existsSync(first)).toBe(true)
    expect(existsSync(third)).toBe(true)

    // 单图自身已超过总上限时也不应误删刚写入的新图
    clock += 1000
    const giant = thirdSizeCapStore.saveImage(`data:image/png;base64,${Buffer.alloc(240, 4).toString('base64')}`)
    expect(existsSync(first)).toBe(false)
    expect(existsSync(third)).toBe(false)
    expect(existsSync(giant)).toBe(true)
  })

  it('deleteImages 仅删除 imageDir 内的普通文件，严格拒绝目录外、兄弟前缀、穿越与 symlink', () => {
    const imgDir = join(tmpRoot, 'images')
    const siblingDir = join(tmpRoot, 'images-other')
    const outsideDir = join(tmpRoot, 'outside-del')
    mkdirSync(imgDir, { recursive: true })
    mkdirSync(siblingDir, { recursive: true })
    mkdirSync(outsideDir, { recursive: true })

    const img1 = store.saveImage(`data:image/png;base64,${Buffer.from('a').toString('base64')}`)
    const img2 = store.saveImage(`data:image/png;base64,${Buffer.from('b').toString('base64')}`)
    const siblingFile = join(siblingDir, 'keep.png')
    const outsideFile = join(outsideDir, 'secret.png')
    writeFileSync(siblingFile, 'keep')
    writeFileSync(outsideFile, 'secret')

    const linkFile = join(imgDir, 'escape-link.png')
    let linked = false
    try { symlinkSync(outsideFile, linkFile); linked = true } catch (_) {}

    const targets = [
      img1,
      img1,
      siblingFile,
      outsideFile,
      join(imgDir, '..', 'outside-del', 'secret.png'),
      imgDir,
      join(imgDir, 'missing.png'),
      ...(linked ? [linkFile] : []),
    ]
    expect(store.deleteImages(targets)).toBe(1)
    expect(existsSync(img1)).toBe(false)
    expect(existsSync(img2)).toBe(true)
    expect(existsSync(siblingFile)).toBe(true)
    expect(existsSync(outsideFile)).toBe(true)
    if (linked) expect(existsSync(linkFile)).toBe(true)
  })

  it('clearImages 清空 imageDir 下普通文件，保留子目录与外部 symlink 目标', () => {
    const imgDir = join(tmpRoot, 'images')
    const subDir = join(imgDir, 'nested')
    const outsideDir = join(tmpRoot, 'outside-clear')
    mkdirSync(subDir, { recursive: true })
    mkdirSync(outsideDir, { recursive: true })

    const img1 = store.saveImage(`data:image/png;base64,${Buffer.from('1').toString('base64')}`)
    const img2 = store.saveImage(`data:image/png;base64,${Buffer.from('2').toString('base64')}`)
    const outsideFile = join(outsideDir, 'keep.png')
    writeFileSync(outsideFile, 'keep')
    const linkFile = join(imgDir, 'link.png')
    let linked = false
    try { symlinkSync(outsideFile, linkFile); linked = true } catch (_) {}

    expect(store.clearImages()).toBe(2)
    expect(existsSync(img1)).toBe(false)
    expect(existsSync(img2)).toBe(false)
    expect(existsSync(subDir)).toBe(true)
    expect(existsSync(outsideFile)).toBe(true)
    if (linked) expect(existsSync(linkFile)).toBe(true)
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
