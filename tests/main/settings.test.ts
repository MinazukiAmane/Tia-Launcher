import { describe, it, expect, afterEach } from 'vitest'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  readSettings,
  writeSettings,
  buildGameLaunchArgs,
  DEFAULT_SETTINGS,
  MIN_DOWNLOAD_SPEED_LIMIT_KBPS,
  MAX_DOWNLOAD_SPEED_LIMIT_KBPS,
  MAX_LAUNCH_COMMAND_LENGTH,
  getCachedWindowCloseBehavior,
  setCachedWindowCloseBehavior,
  type Settings
} from '../../src/main/settings'

let tempDirs: string[] = []

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'csore-settings-test-'))
  tempDirs.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(tempDirs.map((d) => rm(d, { recursive: true, force: true })))
  tempDirs = []
})

const BASE_SETTINGS: Settings = {
  lang: 'na_en',
  classicUi: false,
  alternateRenderer: false,
  downloadSpeedLimitKbps: null,
  launchCommand: null,
  troubleshootingMode: false,
  windowCloseBehavior: 'exit',
  customBackground: null
}

describe('readSettings', () => {
  it('returns defaults when no file exists', async () => {
    const dir = await makeTempDir()
    expect(await readSettings(dir)).toEqual(DEFAULT_SETTINGS)
  })

  it('round-trips what writeSettings wrote', async () => {
    const dir = await makeTempDir()
    const settings: Settings = {
      lang: 'na_id',
      classicUi: true,
      alternateRenderer: false,
      downloadSpeedLimitKbps: 4096,
      launchCommand: 'prime-run %command%',
      troubleshootingMode: true,
      windowCloseBehavior: 'minimize_to_tray',
      customBackground: 'custom-123.gif'
    }
    await writeSettings(dir, settings)
    expect(await readSettings(dir)).toEqual(settings)
  })

  it('fills in missing fields with defaults (forward-compatible with older settings files)', async () => {
    const dir = await makeTempDir()
    const { writeFile } = await import('fs/promises')
    await writeFile(join(dir, 'settings.json'), JSON.stringify({ lang: 'na_id' }), 'utf-8')
    const got = await readSettings(dir)
    expect(got).toEqual({ ...DEFAULT_SETTINGS, lang: 'na_id' })
  })

  it('ignores a saved old-field-name value (downloadSpeedLimitMbps) and falls back to the new default', async () => {
    const dir = await makeTempDir()
    const { writeFile } = await import('fs/promises')
    await writeFile(
      join(dir, 'settings.json'),
      JSON.stringify({ lang: 'na_id', downloadSpeedLimitMbps: 25 }),
      'utf-8'
    )
    const got = await readSettings(dir)
    expect(got.downloadSpeedLimitKbps).toBe(null)
  })

  it('clamps an out-of-range downloadSpeedLimitKbps found on disk rather than passing it through', async () => {
    const dir = await makeTempDir()
    const { writeFile } = await import('fs/promises')
    await writeFile(join(dir, 'settings.json'), JSON.stringify({ downloadSpeedLimitKbps: 999999 }), 'utf-8')
    const got = await readSettings(dir)
    expect(got.downloadSpeedLimitKbps).toBe(MAX_DOWNLOAD_SPEED_LIMIT_KBPS)
  })
})

describe('writeSettings: downloadSpeedLimitKbps validation', () => {
  it('clamps a value above the max down to MAX_DOWNLOAD_SPEED_LIMIT_KBPS', async () => {
    const dir = await makeTempDir()
    await writeSettings(dir, { ...BASE_SETTINGS, downloadSpeedLimitKbps: 999999 })
    expect((await readSettings(dir)).downloadSpeedLimitKbps).toBe(MAX_DOWNLOAD_SPEED_LIMIT_KBPS)
  })

  it('clamps a value below the min up to MIN_DOWNLOAD_SPEED_LIMIT_KBPS', async () => {
    const dir = await makeTempDir()
    await writeSettings(dir, { ...BASE_SETTINGS, downloadSpeedLimitKbps: 1 })
    expect((await readSettings(dir)).downloadSpeedLimitKbps).toBe(MIN_DOWNLOAD_SPEED_LIMIT_KBPS)
  })

  it('leaves an in-range value untouched', async () => {
    const dir = await makeTempDir()
    await writeSettings(dir, { ...BASE_SETTINGS, downloadSpeedLimitKbps: 4096 })
    expect((await readSettings(dir)).downloadSpeedLimitKbps).toBe(4096)
  })

  it('keeps null (no limit) as null', async () => {
    const dir = await makeTempDir()
    await writeSettings(dir, { ...BASE_SETTINGS, downloadSpeedLimitKbps: null })
    expect((await readSettings(dir)).downloadSpeedLimitKbps).toBe(null)
  })
})

describe('writeSettings: launchCommand validation', () => {
  it('truncates a launchCommand longer than MAX_LAUNCH_COMMAND_LENGTH', async () => {
    const dir = await makeTempDir()
    const long = 'a'.repeat(600)
    await writeSettings(dir, { ...BASE_SETTINGS, launchCommand: long })
    const got = await readSettings(dir)
    expect(got.launchCommand).toHaveLength(MAX_LAUNCH_COMMAND_LENGTH)
    expect(got.launchCommand).toBe('a'.repeat(MAX_LAUNCH_COMMAND_LENGTH))
  })

  it('treats an empty string the same as null', async () => {
    const dir = await makeTempDir()
    await writeSettings(dir, { ...BASE_SETTINGS, launchCommand: '' })
    expect((await readSettings(dir)).launchCommand).toBe(null)
  })
})

describe('writeSettings/readSettings: windowCloseBehavior + troubleshootingMode validation', () => {
  it('falls back to the default windowCloseBehavior for an invalid enum value on write', async () => {
    const dir = await makeTempDir()
    await writeSettings(dir, {
      ...BASE_SETTINGS,
      windowCloseBehavior: 'not_a_real_value' as unknown as Settings['windowCloseBehavior']
    })
    expect((await readSettings(dir)).windowCloseBehavior).toBe(DEFAULT_SETTINGS.windowCloseBehavior)
  })

  it('leaves a valid windowCloseBehavior value untouched', async () => {
    const dir = await makeTempDir()
    await writeSettings(dir, { ...BASE_SETTINGS, windowCloseBehavior: 'minimize_to_tray' })
    expect((await readSettings(dir)).windowCloseBehavior).toBe('minimize_to_tray')
  })

  it('falls back to the default windowCloseBehavior for a bad value found on disk', async () => {
    const dir = await makeTempDir()
    const { writeFile } = await import('fs/promises')
    await writeFile(join(dir, 'settings.json'), JSON.stringify({ windowCloseBehavior: 123 }), 'utf-8')
    expect((await readSettings(dir)).windowCloseBehavior).toBe(DEFAULT_SETTINGS.windowCloseBehavior)
  })

  it('falls back to the default troubleshootingMode for a non-boolean value on write', async () => {
    const dir = await makeTempDir()
    await writeSettings(dir, {
      ...BASE_SETTINGS,
      troubleshootingMode: 'yes' as unknown as boolean
    })
    expect((await readSettings(dir)).troubleshootingMode).toBe(DEFAULT_SETTINGS.troubleshootingMode)
  })
})

describe('cached windowCloseBehavior', () => {
  afterEach(() => {
    setCachedWindowCloseBehavior(DEFAULT_SETTINGS.windowCloseBehavior)
  })

  it('defaults to the DEFAULT_SETTINGS value before anything sets it', () => {
    expect(getCachedWindowCloseBehavior()).toBe(DEFAULT_SETTINGS.windowCloseBehavior)
  })

  it('reflects whatever was last set, synchronously', () => {
    setCachedWindowCloseBehavior('minimize_to_tray')
    expect(getCachedWindowCloseBehavior()).toBe('minimize_to_tray')
    setCachedWindowCloseBehavior('exit')
    expect(getCachedWindowCloseBehavior()).toBe('exit')
  })
})

describe('buildGameLaunchArgs', () => {
  it('always includes -lang with the configured language', () => {
    expect(buildGameLaunchArgs({ ...BASE_SETTINGS, lang: 'na_en' })).toEqual(['-lang', 'na_en'])
  })

  it('appends bare -classicui when the toggle is on', () => {
    expect(buildGameLaunchArgs({ ...BASE_SETTINGS, lang: 'na_en', classicUi: true })).toEqual([
      '-lang',
      'na_en',
      '-classicui'
    ])
  })

  it('appends bare -renderer when the toggle is on, no value', () => {
    expect(buildGameLaunchArgs({ ...BASE_SETTINGS, lang: 'na_id', alternateRenderer: true })).toEqual([
      '-lang',
      'na_id',
      '-renderer'
    ])
  })

  it('both toggles on appends both flags after -lang', () => {
    expect(
      buildGameLaunchArgs({ ...BASE_SETTINGS, lang: 'na_id', classicUi: true, alternateRenderer: true })
    ).toEqual(['-lang', 'na_id', '-classicui', '-renderer'])
  })
})
