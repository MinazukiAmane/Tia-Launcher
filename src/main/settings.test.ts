import { describe, it, expect, afterEach } from 'vitest'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { readSettings, writeSettings, buildGameLaunchArgs, DEFAULT_SETTINGS, type Settings } from './settings'

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
      downloadSpeedLimitMbps: 25
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
})

describe('buildGameLaunchArgs', () => {
  it('always includes -lang with the configured language', () => {
    expect(buildGameLaunchArgs({ lang: 'na_en', classicUi: false, alternateRenderer: false, downloadSpeedLimitMbps: null })).toEqual([
      '-lang',
      'na_en'
    ])
  })

  it('appends bare -classicui when the toggle is on', () => {
    expect(buildGameLaunchArgs({ lang: 'na_en', classicUi: true, alternateRenderer: false, downloadSpeedLimitMbps: null })).toEqual([
      '-lang',
      'na_en',
      '-classicui'
    ])
  })

  it('appends bare -renderer when the toggle is on, no value', () => {
    expect(buildGameLaunchArgs({ lang: 'na_id', classicUi: false, alternateRenderer: true, downloadSpeedLimitMbps: null })).toEqual([
      '-lang',
      'na_id',
      '-renderer'
    ])
  })

  it('both toggles on appends both flags after -lang', () => {
    expect(buildGameLaunchArgs({ lang: 'na_id', classicUi: true, alternateRenderer: true, downloadSpeedLimitMbps: null })).toEqual([
      '-lang',
      'na_id',
      '-classicui',
      '-renderer'
    ])
  })
})
