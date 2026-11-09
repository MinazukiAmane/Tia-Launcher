import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { chmod, lstat, mkdir, mkdtemp, readFile, rename, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'
import builderDownloads from 'app-builder-lib/out/util/electronGet.js'

const releases = new Map()
const assetHosts = new Set(['release-assets.githubusercontent.com', 'objects.githubusercontent.com', 'github-releases.githubusercontent.com'])
async function digest(path) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}
export async function downloadReleaseAsset(spec, { request = fetch, token = process.env.GH_TOKEN, retryDelay = 1000 } = {}) {
  const { repository, tag, name, destination, checksum, executable = false } = spec
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository) || !tag || !/^[\w.@+-]+$/.test(name) || checksum && !/^[a-f0-9]{64}$/.test(checksum)) throw new Error('Invalid build dependency descriptor')
  const headers = { Accept: 'application/vnd.github+json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }
  for (let attempt = 0; attempt < 4; attempt++) {
    let temporary
    try {
      const key = `${repository}/${tag}`
      if (!releases.has(key)) {
        const response = await request(`https://api.github.com/repos/${repository}/releases/tags/${encodeURIComponent(tag)}`, { headers, signal: AbortSignal.timeout(30_000) })
        if (!response.ok) throw Object.assign(new Error(`Build metadata HTTP ${response.status}`), { retryable: response.status === 429 || response.status >= 500 })
        releases.set(key, await response.json())
      }
      const matches = releases.get(key).assets?.filter(asset => asset.name === name) ?? []
      if (matches.length !== 1) throw new Error(`Missing official build asset: ${name}`)
      const asset = matches[0], expected = checksum ?? asset.digest?.replace(/^sha256:/, '')
      if (!/^[a-f0-9]{64}$/.test(expected ?? '') || asset.digest && asset.digest !== `sha256:${expected}` || !Number.isSafeInteger(asset.id) || !Number.isSafeInteger(asset.size) || asset.size <= 0 || asset.size > 512 * 1024 ** 2) throw new Error(`Unverified build asset: ${name}`)
      try {
        const info = await lstat(destination)
        if (!info.isFile() || info.isSymbolicLink()) throw new Error('Invalid dependency cache entry')
        if (info.size === asset.size && await digest(destination) === expected) {
          if (executable) await chmod(destination, 0o755)
          console.log(`Verified cached build dependency: ${name}`)
          return destination
        }
      } catch (error) { if (error.code !== 'ENOENT') throw error }
      await mkdir(dirname(destination), { recursive: true })
      temporary = await mkdtemp(join(dirname(destination), '.tia-download-'))
      let url = `https://api.github.com/repos/${repository}/releases/assets/${asset.id}`
      let response
      for (let hop = 0; hop < 5; hop++) {
        response = await request(url, { redirect: 'manual', headers: hop === 0 ? { ...headers, Accept: 'application/octet-stream' } : {}, signal: AbortSignal.timeout(600_000) })
        if (![301, 302, 303, 307, 308].includes(response.status)) break
        const next = new URL(response.headers.get('location') ?? '', url)
        if (next.protocol !== 'https:' || !assetHosts.has(next.hostname) || next.username || next.password) throw new Error('Unexpected build asset redirect')
        url = next.href
        await response.body?.cancel()
      }
      if (!response?.ok || !response.body) throw Object.assign(new Error(`Build asset HTTP ${response?.status}`), { retryable: response?.status === 429 || response?.status >= 500 })
      const hash = createHash('sha256'); let size = 0
      const verify = new Transform({ transform(chunk, encoding, done) {
        size += chunk.length
        if (size > asset.size) return done(new Error('Oversized build asset'))
        hash.update(chunk); done(null, chunk)
      } })
      const file = join(temporary, name)
      await pipeline(Readable.fromWeb(response.body), verify, createWriteStream(file, { flags: 'wx', mode: 0o600 }))
      if (size !== asset.size || hash.digest('hex') !== expected) throw new Error(`Build dependency checksum mismatch: ${name}`)
      if (executable) await chmod(file, 0o755)
      await rm(destination, { force: true })
      await rename(file, destination)
      console.log(`Downloaded and verified build dependency: ${name}`)
      return destination
    } catch (error) {
      const transient = error.retryable || error instanceof TypeError || ['AbortError', 'TimeoutError'].includes(error.name) || ['ECONNRESET', 'ETIMEDOUT'].includes(error.code)
      if (!transient || attempt === 3) throw error
      console.log(`Retrying build dependency ${name} (${attempt + 1}/3)`)
      await new Promise(resolve => setTimeout(resolve, retryDelay * 2 ** attempt))
    } finally { if (temporary) await rm(temporary, { recursive: true, force: true }) }
  }
}
export async function prepareBuildDownloads() {
  const { Cache } = await import(new URL('./Cache.js', import.meta.resolve('@electron/get')).href)
  const electronCache = new Cache(), builderCache = builderDownloads.getCacheDirectory({ allowEnvVarOverride: true })
  const version = JSON.parse(await readFile(new URL('../../node_modules/electron/package.json', import.meta.url))).version
  const checksums = JSON.parse(await readFile(new URL('../../node_modules/electron/checksums.json', import.meta.url)))
  for (const arch of process.platform === 'darwin' ? ['arm64', 'x64'] : [process.arch]) {
    const name = `electron-v${version}-${process.platform}-${arch}.zip`, tag = `v${version}`
    await downloadReleaseAsset({ repository: 'electron/electron', tag, name, checksum: checksums[name], destination: electronCache.getCachePath(`https://github.com/electron/electron/releases/download/${tag}/${name}`, name) })
  }
  const sevenZip = process.platform === 'win32'
    ? ['7zip-win-x64.tar.gz', 'be071f15bd6da2f78fe81c6ddef2009b0c4d8a51f36b780cb806c7e6df95e1b3']
    : process.platform === 'darwin'
      ? [`7zip-darwin-${process.arch === 'arm64' ? 'arm64' : 'x86_64'}.tar.gz`, '496a341abe210aae1a25bc202ee97f6de6c76a3dc80f91d96616be05502d72c1']
      : ['7zip-linux-x64.tar.gz', 'd151bb44b2a9d9bfc52813ce4cac042916394a0ab8a56bd5d221a5dc9ef8d5d7']
  const tools = [['7zip@1.0.0', ...sevenZip], ['icons@1.2.3', 'icons-bundle.tar.gz', '4e5bb546c9d3ab0c2bbacc22857467bf415f742a34c2be9dd138779d2fc066f9']]
  if (process.platform !== 'darwin') tools.push(
    ['nsis-3.0.4.1', 'nsis-3.0.4.1.7z', '9877df902530f96357d13a7a31ae2b9df67f48b11ffc9a1700a7c961574ec5fa'],
    ['nsis-resources-3.4.1', 'nsis-resources-3.4.1.7z', '593a9a92ef958321293ac6a2ee61e64bf1bd543142a5bd6b3d310709cc924103'],
    ['winCodeSign-2.6.0', 'winCodeSign-2.6.0.7z', 'cdaec7154dda7cc31f88d886e2489379a0625a737d610b5ae7f62a12f16743a4'])
  if (process.platform === 'linux') tools.push(
    ['appimage-12.0.1', 'appimage-12.0.1.7z', 'd12ff7eb8f1d1ec4652ca5237a7fbdca33acc0c758045636feca62dc6ecb8ec4'],
    ['fpm@2.1.4', 'fpm-1.17.0-ruby-3.4.3-linux-amd64.7z', '44b0ec6025c14ec137f56180e62675c0eae36233cdce53d0953d9c73ced8989f'])
  for (const [tag, name, checksum] of tools) await downloadReleaseAsset({ repository: 'electron-userland/electron-builder-binaries', tag, name, checksum, destination: join(builderCache, tag, name) })
  if (process.platform === 'linux') {
    const cache = join(dirname(builderDownloads.defaultElectronGetCacheRoot()), 'tauri')
    for (const [repository, tag, name, filename] of [
      ['tauri-apps/binary-releases', 'apprun-old', 'AppRun-x86_64', 'AppRun-x86_64'],
      ['tauri-apps/binary-releases', 'linuxdeploy-07333c6', 'linuxdeploy-x86_64.AppImage', 'linuxdeploy-07333c6-x86_64.AppImage'],
      ['linuxdeploy/linuxdeploy-plugin-appimage', 'continuous', 'linuxdeploy-plugin-appimage-x86_64.AppImage', 'linuxdeploy-plugin-appimage.AppImage']
    ]) await downloadReleaseAsset({ repository, tag, name, destination: join(cache, filename), executable: true })
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await prepareBuildDownloads()
