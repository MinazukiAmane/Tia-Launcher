import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { exportedFlagArchitecture, readFlagArchitecture } from '../../../src/main/launcher/peFlags'
afterEach(() => vi.restoreAllMocks())
const fixture = (arch: string) => join(process.cwd(), 'tests/fixtures', `flags-fixture-${arch}.exe`)

it('matches in-memory export parsing for both architectures and rejects removed exports', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tia-pe-exports-'))
  try {
    for (const arch of ['x86', 'x64']) {
      expect(await readFlagArchitecture(fixture(arch))).toBe(arch)
      const bytes = await readFile(fixture(arch)); bytes.write('other', bytes.indexOf(Buffer.from('flags\0')))
      const path = join(root, arch + '.exe'); await writeFile(path, bytes)
      expect(exportedFlagArchitecture(bytes)).toBeNull(); expect(await readFlagArchitecture(path)).toBeNull()
    }
    const invalid = join(root, 'bad.exe'); await writeFile(invalid, Buffer.alloc(64))
    expect(await readFlagArchitecture(invalid)).toBeNull()
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('reads bounded export pages instead of a large executable overlay', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tia-pe-sparse-'))
  try {
    const path = join(root, 'large.exe'); const file = await open(path, 'w')
    const prototype = Object.getPrototypeOf(file)
    try { await file.writeFile(await readFile(fixture('x86'))); await file.truncate(256 * 1024 * 1024) }
    finally { await file.close() }
    const reads = vi.spyOn(prototype, 'read')
    expect(await readFlagArchitecture(path)).toBe('x86')
    const requested = reads.mock.calls.reduce((sum, args) => sum + Number(args[2]), 0)
    expect(requested).toBeGreaterThan(0); expect(requested).toBeLessThan(512 * 1024)
  } finally { await rm(root, { recursive: true, force: true }) }
})
