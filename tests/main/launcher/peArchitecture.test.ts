import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { readPEArchitecture } from '../../../src/main/launcher/peArchitecture'
afterEach(() => vi.restoreAllMocks())
const fixture = (arch: string) => join(process.cwd(), 'tests/fixtures', `pe-${arch}.bin`)

it('routes x86/x64 headers and rejects invalid or inconsistent headers', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tia-pe-headers-'))
  try {
    for (const arch of ['x86', 'x64']) expect(await readPEArchitecture(fixture(arch))).toBe(arch)
    const bytes = await readFile(fixture('x86')); bytes.writeUInt16LE(0x20b, 0x80 + 24)
    const path = join(root, 'bad.exe'); await writeFile(path, bytes)
    expect(await readPEArchitecture(path)).toBeNull()
    bytes.writeUInt32LE(0xfffffff0, 60); await writeFile(path, bytes)
    expect(await readPEArchitecture(path)).toBeNull()
    await writeFile(path, Buffer.alloc(8)); expect(await readPEArchitecture(path)).toBeNull()
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('reads only architecture headers even for an executable with a large overlay', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tia-pe-sparse-'))
  try {
    const path = join(root, 'large.exe'); const file = await open(path, 'w')
    const prototype = Object.getPrototypeOf(file)
    try { await file.writeFile(await readFile(fixture('x86'))); await file.truncate(256 * 1024 * 1024) }
    finally { await file.close() }
    const reads = vi.spyOn(prototype, 'read')
    expect(await readPEArchitecture(path)).toBe('x86')
    expect(reads.mock.calls.reduce((sum, args) => sum + Number(args[2]), 0)).toBe(90)
  } finally { await rm(root, { recursive: true, force: true }) }
})
