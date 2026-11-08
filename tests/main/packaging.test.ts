import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createRequire } from 'module'
import { randomBytes, createDecipheriv } from 'crypto'
import { brotliDecompressSync } from 'zlib'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'fs/promises'
import * as fs from 'fs'
import * as path from 'path'
import { tmpdir } from 'os'
import { runInNewContext } from 'vm'

const require = createRequire(import.meta.url)
const afterPack = require('../../build-scripts/afterPack.js').default
const { createPackage } = require('@electron/asar')
const previousKey = process.env.TIA_ASAR_KEY
let root: string
let key: Buffer

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'tia-packaging-'))
  key = randomBytes(32)
  process.env.TIA_ASAR_KEY = key.toString('hex')
})
afterEach(async () => {
  if (previousKey === undefined) delete process.env.TIA_ASAR_KEY
  else process.env.TIA_ASAR_KEY = previousKey
  await rm(root, { recursive: true, force: true })
})

async function fixture(platform = 'linux', arch = 1): Promise<{ resources: string; archive: Buffer }> {
  const input = path.join(root, 'input')
  const output = path.join(root, 'output')
  const resources = platform === 'darwin' ? path.join(output, 'Fixture.app', 'Contents', 'Resources') : path.join(output, 'resources')
  await mkdir(path.join(input, 'out', 'main'), { recursive: true })
  await mkdir(resources, { recursive: true })
  await writeFile(path.join(input, 'out', 'main', 'index.js'), 'module.exports = "application-entry";\n'.repeat(1000))
  await createPackage(input, path.join(resources, 'app.asar'))
  const archive = await readFile(path.join(resources, 'app.asar'))
  for (const name of ['linux-x64-gnu', 'linux-x64-musl', 'win32-x64-msvc', 'darwin-arm64', 'darwin-x64']) {
    const directory = path.join(resources, 'app.asar.unpacked', 'node_modules', '@bsdiff-rust', 'node-' + name)
    await mkdir(directory, { recursive: true })
    await writeFile(path.join(directory, 'addon.node'), name)
  }
  await afterPack({ electronPlatformName: platform, arch, appOutDir: output, packager: { appInfo: { productFilename: 'Fixture', version: '1.0.0' } } })
  return { resources, archive }
}

describe('compact application packaging', () => {
  it('compresses before encryption and boots the identical archive with its native addon directory', async () => {
    const { resources, archive } = await fixture()
    const encoded = await readFile(path.join(resources, 'app.dat'))
    expect(encoded.length).toBeLessThan(archive.length / 2)
    const decipher = createDecipheriv('aes-256-gcm', key, encoded.subarray(0, 12))
    decipher.setAuthTag(encoded.subarray(12, 28))
    const decoded = brotliDecompressSync(Buffer.concat([decipher.update(encoded.subarray(28)), decipher.final()]))
    expect(decoded.equals(archive)).toBe(true)
    const bootstrap = await readFile(path.join(resources, 'app', 'bootstrap.js'), 'utf8')
    let loaded = false
    let temporary = ''
    let cleanup: (() => void) | undefined
    runInNewContext(bootstrap, {
      Buffer, __dirname: path.join(resources, 'app'),
      process: { on: (_event: string, callback: () => void) => { cleanup = callback } },
      require: (name: string) => {
        if (name === 'original-fs') return fs
        if (name === 'os') return { tmpdir: () => root }
        if (name.endsWith(path.join('out', 'main', 'index.js'))) {
          temporary = name.slice(0, -path.join('out', 'main', 'index.js').length).replace(/[\\/]$/, '')
          expect(fs.readFileSync(temporary).equals(archive)).toBe(true)
          expect(fs.existsSync(temporary + '.unpacked/node_modules/@bsdiff-rust/node-linux-x64-gnu/addon.node')).toBe(true)
          loaded = true
          return {}
        }
        return require(name)
      }
    })
    expect(loaded).toBe(true)
    cleanup!()
    expect(fs.existsSync(temporary)).toBe(false)
  })

  it('rejects modified encrypted payloads before running application code', async () => {
    const { resources } = await fixture()
    const filename = path.join(resources, 'app.dat')
    const encoded = await readFile(filename)
    encoded[encoded.length - 1] ^= 1
    await writeFile(filename, encoded)
    const bootstrap = await readFile(path.join(resources, 'app', 'bootstrap.js'), 'utf8')
    expect(() => runInNewContext(bootstrap, {
      Buffer, __dirname: path.join(resources, 'app'), process: { on: () => {} },
      require: (name: string) => name === 'original-fs' ? fs : require(name)
    })).toThrow()
  })

  it.each([
    ['linux', 1, ['node-linux-x64-gnu']],
    ['win32', 1, ['node-win32-x64-msvc']],
    ['darwin', 3, ['node-darwin-arm64']],
    ['darwin', 4, ['node-darwin-arm64', 'node-darwin-x64']]
  ] as const)('keeps only native patch bindings for %s architecture %s', async (platform, arch, expected) => {
    const { resources } = await fixture(platform, arch)
    expect((await readdir(path.join(resources, '.tia-rt', 'node_modules', '@bsdiff-rust'))).sort()).toEqual([...expected].sort())
  })
})
