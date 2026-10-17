import { expect, it, vi } from 'vitest'
import AdmZip from 'adm-zip'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { createHash } from 'crypto'
import { applyPatch } from '../../src/main/patcher'
import { bspatch } from '../../src/main/bsdiffAdapter'
vi.mock('electron', () => ({ app: { getPath: () => tmpdir() } }))
const md5 = (bytes: Buffer): string => createHash('md5').update(bytes).digest('hex')
it('applies a Go-generated BSDIFF40 delta through the real native file API', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'csore-native-file-patch-'))
  try {
    const install = join(dir, 'game')
    await mkdir(join(install, 'Bin'), { recursive: true })
    const old = Buffer.from('original game bytes')
    const next = Buffer.concat([old, Buffer.alloc(65536, 0x5a)])
    await writeFile(join(install, 'Bin/client.dll'), old)
    const zip = new AdmZip()
    zip.addFile('deltas/1', await readFile(join(process.cwd(), 'tests/fixtures/patch-fixture.bsdiff')))
    const path = join(dir, 'patch.zip'); zip.writeZip(path)
    expect(typeof bspatch.files).toBe('function')
    await applyPatch(install, path, { entries: [{ path: 'Bin/client.dll', action: 'modified', delta_file: 'deltas/1', old_md5: md5(old), new_md5: md5(next), size: next.length }] }, bspatch)
    expect(await readFile(join(install, 'Bin/client.dll'))).toEqual(next)
  } finally { await rm(dir, { recursive: true, force: true }) }
})
