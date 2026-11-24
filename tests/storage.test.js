import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  read, write, readLocal, readLocalAsync, writeLocal,
  readCache, readCacheMeta, readCacheMetaAsync, writeCache,
  PREFS_KEY, LEGACY_PREF_KEYS, loadPrefsBundle, savePrefsPatch,
} from '../src/storage.js'

function createMockDbStorage() {
  const map = new Map()
  return {
    map,
    getItem: k => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, v) },
    removeItem: k => { map.delete(k); return true },
  }
}

describe('storage.js 同步库隔离与缓存分级', () => {
  let origUtools
  let origBridge

  beforeEach(() => {
    origUtools = globalThis.window.utools
    origBridge = globalThis.window.piBridge
    localStorage.clear()
  })

  afterEach(() => {
    globalThis.window.utools = origUtools
    globalThis.window.piBridge = origBridge
    localStorage.clear()
  })

  it('readCache/writeCache 绝不写入 utools.dbStorage，有 piBridge 时委托给桥接层', () => {
    const dbStorage = createMockDbStorage()
    const bridgeCache = new Map()
    globalThis.window.utools = { dbStorage }
    globalThis.window.piBridge = {
      readCache: k => (bridgeCache.has(k) ? bridgeCache.get(k) : null),
      writeCache: (k, d) => { bridgeCache.set(k, d); return true },
    }

    expect(writeCache('models', [{ id: 'gpt-4o' }])).toBe(true)
    expect(readCache('models')).toEqual([{ id: 'gpt-4o' }])
    expect(bridgeCache.get('models')).toEqual([{ id: 'gpt-4o' }])
    expect(dbStorage.map.size).toBe(0)

    // 用户数据 read/write 依然写入 dbStorage
    write('pideck.groups.v1', [{ id: 'chat' }])
    expect(dbStorage.map.has('pideck.groups.v1')).toBe(true)
    expect(read('pideck.groups.v1', [])).toEqual([{ id: 'chat' }])
  })

  it('无 piBridge 缓存方法时降级到 localStorage，仍不触碰 dbStorage', () => {
    const dbStorage = createMockDbStorage()
    globalThis.window.utools = { dbStorage }
    globalThis.window.piBridge = undefined

    expect(writeCache('skills', [{ name: 's1' }])).toBe(true)
    expect(readCache('skills')).toEqual([{ name: 's1' }])
    expect(readCacheMeta('skills')).toMatchObject({ data: [{ name: 's1' }], fresh: true })
    expect(dbStorage.map.size).toBe(0)
  })

  it('readLocal/writeLocal 绝不写入 utools.dbStorage，有 piBridge 时委托桥接层', () => {
    const dbStorage = createMockDbStorage()
    const localMap = new Map()
    globalThis.window.utools = { dbStorage }
    globalThis.window.piBridge = {
      readLocal: (k, fb) => (localMap.has(k) ? localMap.get(k) : fb),
      writeLocal: (k, v) => { localMap.set(k, v); return true },
    }

    expect(writeLocal('pideck.drafts.v1', { chat: 'hi' })).toBe(true)
    expect(readLocal('pideck.drafts.v1', {})).toEqual({ chat: 'hi' })
    expect(dbStorage.map.size).toBe(0)
  })

  it('readCacheMetaAsync 与 readLocalAsync 优先走 piBridge 异步方法且不触碰 dbStorage', async () => {
    const dbStorage = createMockDbStorage()
    globalThis.window.utools = { dbStorage }
    globalThis.window.piBridge = {
      readCacheMetaAsync: async k => (k === 'env' ? { data: { ok: true }, fresh: true, ageMs: 1 } : null),
      readLocalAsync: async (k, fb) => (k === 'pideck.drafts.v1' ? { chat: 'draft' } : fb),
    }

    expect(await readCacheMetaAsync('env')).toEqual({ data: { ok: true }, fresh: true, ageMs: 1 })
    expect(await readLocalAsync('pideck.drafts.v1', {})).toEqual({ chat: 'draft' })
    expect(dbStorage.map.size).toBe(0)
  })

  it('loadPrefsBundle / savePrefsPatch 支持旧 4 key 迁移并收敛为单 key', () => {
    const dbStorage = createMockDbStorage()
    globalThis.window.utools = { dbStorage }
    globalThis.window.piBridge = undefined

    write(LEGACY_PREF_KEYS.defaultCwd, 'D:/work')
    write(LEGACY_PREF_KEYS.sendKey, 'enter')
    write(LEGACY_PREF_KEYS.layout, 'console')
    write(LEGACY_PREF_KEYS.activeId, 'translate')

    const first = loadPrefsBundle()
    expect(first.needsMigration).toBe(true)
    expect(first.prefs).toEqual({
      defaultCwd: 'D:/work',
      sendKey: 'enter',
      layout: 'console',
      activeId: 'translate',
    })
    // loadPrefsBundle 为纯读，不会提前写盘
    expect(dbStorage.map.has(PREFS_KEY)).toBe(false)

    savePrefsPatch({ activeId: 'agent' })
    expect(dbStorage.map.has(PREFS_KEY)).toBe(true)

    const second = loadPrefsBundle()
    expect(second.needsMigration).toBe(false)
    expect(second.prefs).toEqual({
      defaultCwd: 'D:/work',
      sendKey: 'enter',
      layout: 'console',
      activeId: 'agent',
    })
  })
})
