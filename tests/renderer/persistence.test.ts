import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const values = new Map<string, string>()
const migrate = vi.fn()

beforeEach(() => {
  vi.resetModules()
  values.clear()
  migrate.mockReset().mockResolvedValue({})
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    removeItem: (key: string) => values.delete(key)
  })
  vi.stubGlobal('window', { csore: { migrateLegacyPreferences: migrate } })
})
afterEach(() => vi.unstubAllGlobals())

describe('legacy renderer preferences', () => {
  it('imports pre-update preferences once and removes old values only after SQLite accepts them', async () => {
    values.set('tia-background-mode', 'image')
    values.set('tia-install-dir', 'D:\\Games\\CSORE')
    values.set('tia-install-path-confirmed', 'D:\\Games\\CSORE')
    const { migrateLegacyPreferences } = await import('../../src/renderer/src/persistence')
    await Promise.all([migrateLegacyPreferences(), migrateLegacyPreferences()])
    expect(migrate).toHaveBeenCalledTimes(1)
    expect(migrate).toHaveBeenCalledWith({ backgroundMode: 'image', installDir: 'D:\\Games\\CSORE', confirmedInstallDir: 'D:\\Games\\CSORE' })
    expect(values.size).toBe(0)
  })

  it('retains old values on failure and retries migration on the next attempt', async () => {
    values.set('tia-background-mode', 'video')
    migrate.mockRejectedValueOnce(new Error('database write failed'))
    const { migrateLegacyPreferences } = await import('../../src/renderer/src/persistence')
    await expect(migrateLegacyPreferences()).rejects.toThrow('database write failed')
    expect(values.get('tia-background-mode')).toBe('video')
    await migrateLegacyPreferences()
    expect(values.size).toBe(0)
    expect(migrate).toHaveBeenCalledTimes(2)
  })
})
