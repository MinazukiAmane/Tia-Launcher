import { describe, it, expect, afterEach } from 'vitest'
import { mkdtemp, rm, writeFile, readdir } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  importBackground,
  clearBackgrounds,
  readBackgroundDataUrl,
  isValidBackgroundName,
  MAX_BACKGROUND_BYTES
} from '../../src/main/background'

let dirs: string[] = []
async function tmp(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), 'csore-bg-test-'))
  dirs.push(d)
  return d
}
afterEach(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })))
  dirs = []
})

describe('background', () => {
  it('imports a gif, returns a gif data URL, and replaces the previous background', async () => {
    const userData = await tmp()
    const src = join(await tmp(), 'anim.GIF')
    await writeFile(src, Buffer.from('GIF89a-fake'))

    const first = await importBackground(userData, src)
    expect(isValidBackgroundName(first)).toBe(true)
    const url = await readBackgroundDataUrl(userData, first)
    expect(url?.startsWith('data:image/gif;base64,')).toBe(true)

    await new Promise((r) => setTimeout(r, 5))
    const second = await importBackground(userData, src)
    expect(second).not.toBe(first)
    expect(await readdir(join(userData, 'backgrounds'))).toEqual([second])

    await clearBackgrounds(userData)
    expect(await readBackgroundDataUrl(userData, second)).toBeNull()
  })

  it('rejects unsupported types and oversized files', async () => {
    const userData = await tmp()
    const bad = join(await tmp(), 'x.exe')
    await writeFile(bad, 'x')
    await expect(importBackground(userData, bad)).rejects.toThrow(/Unsupported/)

    const big = join(await tmp(), 'big.png')
    await writeFile(big, Buffer.alloc(MAX_BACKGROUND_BYTES + 1))
    await expect(importBackground(userData, big)).rejects.toThrow(/too large/)
  })

  it('never reads outside the backgrounds dir for a malicious name', async () => {
    const userData = await tmp()
    expect(isValidBackgroundName('../../etc/passwd')).toBe(false)
    expect(await readBackgroundDataUrl(userData, '../settings.json')).toBeNull()
  })
})
