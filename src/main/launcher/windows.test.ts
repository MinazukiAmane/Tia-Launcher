
import { describe, it, expect, afterEach } from 'vitest'
import { mkdtemp, rm, mkdir, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join, dirname } from 'path'
import { findGameExecutable, launchWindows } from './windows'

let tempDirs: string[] = []
async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'csore-win-launcher-test-'))
  tempDirs.push(dir)
  return dir
}
afterEach(async () => {
  await Promise.all(tempDirs.map((d) => rm(d, { recursive: true, force: true })))
  tempDirs = []
})

describe('findGameExecutable', () => {
  it('resolves to Bin/cstrike-online.exe when it exists (matches the real production launcher)', async () => {
    const installDir = await makeTempDir()
    await mkdir(join(installDir, 'Bin'), { recursive: true })
    await writeFile(join(installDir, 'Bin', 'cstrike-online.exe'), 'fake exe bytes')

    const got = await findGameExecutable(installDir)
    expect(got).toBe(join(installDir, 'Bin', 'cstrike-online.exe'))
  })

  it('throws when the executable is missing (install is incomplete/corrupted)', async () => {
    const installDir = await makeTempDir()
    await expect(findGameExecutable(installDir)).rejects.toThrow()
  })
})

describe('launchWindows', () => {
  it('rejects with a clear message when the executable does not exist (ENOENT)', async () => {
    const installDir = await makeTempDir()
    const exePath = join(installDir, 'Bin', 'cstrike-online.exe')
    await expect(launchWindows(exePath, [])).rejects.toThrow(/not found/i)
  })

  it('resolves and runs the real executable with cwd set to its own directory', async () => {
    const installDir = await makeTempDir()
    const binDir = join(installDir, 'Bin')
    await mkdir(binDir, { recursive: true })

    const scriptPath = join(binDir, 'check-cwd.js')
    const outPath = join(binDir, 'cwd.txt')
    await writeFile(
      scriptPath,
      `require('fs').writeFileSync(${JSON.stringify(outPath)}, process.cwd())`
    )
    await launchWindows(process.execPath, [scriptPath])
    await new Promise((r) => setTimeout(r, 300))
    const { readFile } = await import('fs/promises')
    const cwdSeen = await readFile(outPath, 'utf-8')
    expect(cwdSeen.trim()).toBe(dirname(process.execPath))
  })
})
