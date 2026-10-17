import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm, unlink } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { createHash } from 'crypto'
vi.mock('electron', () => ({ app: { getPath: () => tmpdir() } }))
import { writeInstallState } from '../../src/main/installState'
import { verifyInstall } from '../../src/main/gameManager'
afterEach(() => vi.unstubAllGlobals())
it('verifies local hashes during an API outage and still rejects corrupted or missing files', async () => {
 const dir = await mkdtemp(join(tmpdir(), 'tia-offline-play-'))
 try {
  await mkdir(join(dir, 'Bin'))
  const target = join(dir, 'Bin', 'client.exe')
  const bytes = Buffer.from('installed client fixture')
  await writeFile(target, bytes)
  await writeInstallState(dir, { version: '1', installDir: dir, files: [{ path: 'Bin/client.exe', md5: createHash('md5').update(bytes).digest('hex') }] })
  const fetch = vi.fn(async () => new Response('origin unavailable', { status: 520 }))
  vi.stubGlobal('fetch', fetch)
  expect(await verifyInstall(dir, true)).toEqual({ ok: true, corruptFiles: [], missingFiles: [] })
  expect(fetch).toHaveBeenCalledTimes(1)
  await writeFile(target, Buffer.from('damaged'))
  expect(await verifyInstall(dir, true)).toMatchObject({ ok: false, corruptFiles: ['Bin/client.exe'] })
  await unlink(target)
  expect(await verifyInstall(dir, true)).toMatchObject({ ok: false, missingFiles: ['Bin/client.exe'] })
  expect(fetch).toHaveBeenCalledTimes(1)
 } finally { await rm(dir, { recursive: true, force: true }) }
})
