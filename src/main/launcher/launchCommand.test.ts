import { describe, expect, it, vi } from 'vitest'
import { buildWrappedCommand, resolveLaunchOptions } from './launchCommand'
import { buildSikarugirBatch } from './macos'
import { join, delimiter } from 'path'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { launchLinux } from './linux'
vi.mock('electron', () => ({ app: { getPath: () => tmpdir() } }))

describe('bare client launch options', () => {
  it('preserves quoted values, empty arguments, and literal shell characters', () => {
    expect(resolveLaunchOptions([], '-name "two words" -empty "" -value "$HOME;foo"').args)
      .toEqual(['-name', 'two words', '-empty', '', '-value', '$HOME;foo'])
  })
  it('rejects an unfinished quote before spawning', () => {
    expect(() => resolveLaunchOptions([], '-name "unfinished')).toThrow(/unclosed quote/)
  })
  it('preserves explicit wrappers and wrapper-only fallback', () => {
    for (const command of ['gamemoderun', 'VAR=1 %command%', '%command% -ip 84.247.156.34 -port 50600']) {
      expect(resolveLaunchOptions(['-lang', 'na_en'], command)).toEqual({ args: ['-lang', 'na_en'], command })
      expect(buildWrappedCommand(command, 'client')).toContain('client')
    }
  })
  it('includes IP and port in the macOS client batch rather than wrapper arguments', () => {
    const options = resolveLaunchOptions(['-lang', 'na_en'], '-ip 84.247.156.34 -port 50600')
    expect(options.command).toBeNull()
    expect(buildSikarugirBatch(join('/game', 'Bin', 'client.exe'), options.args))
      .toContain('"-lang" "na_en" "-ip" "84.247.156.34" "-port" "50600"')
  })
})

it.skipIf(process.platform === 'win32')('forwards IP and port through a real Linux umu-run process', async () => {
  const root = await mkdtemp(join(tmpdir(), 'csore-launch-args-'))
  const previousPath = process.env.PATH
  try {
    const bin = join(root, 'Bin')
    await mkdir(bin)
    const exe = join(bin, 'cstrike-online.exe')
    const output = join(root, 'argv.json')
    await writeFile(join(root, 'umu-run'), `#!${process.execPath}
require('fs').writeFileSync(${JSON.stringify(output)}, JSON.stringify(process.argv.slice(2)))
`, { mode: 0o755 })
    process.env.PATH = root + delimiter + (previousPath ?? '')
    await launchLinux('/proton-fixture', '/prefix-fixture', exe, ['-lang', 'na_en'], '-ip 84.247.156.34 -port 50600')
    await vi.waitFor(async () => {
      expect(JSON.parse(await readFile(output, 'utf8'))).toEqual([exe, '-lang', 'na_en', '-ip', '84.247.156.34', '-port', '50600'])
    })
  } finally {
    if (previousPath === undefined) delete process.env.PATH
    else process.env.PATH = previousPath
    await rm(root, { recursive: true, force: true })
  }
})
