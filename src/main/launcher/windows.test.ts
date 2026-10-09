
import { describe, it, expect, afterEach } from 'vitest'
import { mkdtemp, rm, mkdir, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { findGameExecutable } from './windows'

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
  it('resolves to Bin/CSORE.exe when it exists', async () => {
    const installDir = await makeTempDir()
    await mkdir(join(installDir, 'Bin'), { recursive: true })
    await writeFile(join(installDir, 'Bin', 'CSORE.exe'), 'fake exe bytes')

    const got = await findGameExecutable(installDir)
    expect(got).toBe(join(installDir, 'Bin', 'CSORE.exe'))
  })

  it('throws when the executable is missing (install is incomplete/corrupted)', async () => {
    const installDir = await makeTempDir()
    await expect(findGameExecutable(installDir)).rejects.toThrow()
  })
})
