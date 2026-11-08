import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, readFile, mkdir, copyFile, writeFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const stable = value => /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(value)
const platformKeys = new Set(['windows-x86_64', 'linux-x86_64', 'linux-x86_64-deb', 'linux-x86_64-pacman', 'darwin-x86_64', 'darwin-aarch64'])
export async function hashFile(path, algorithm = 'sha512', encoding = 'base64') {
  const info = await lstat(path)
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('Release artifacts must be regular files.')
  const hash = createHash(algorithm)
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return { hash: hash.digest(encoding), size: info.size }
}
export async function releaseLayout({ input, output, version, bridgeVersion, base, migration = true, now = new Date() }) {
  if (!stable(version) || !version.startsWith('2.') || !stable(bridgeVersion) || !bridgeVersion.startsWith('1.')) throw new Error('Release requires stable native 2.x and bridge 1.x versions.')
  const url = new URL(base)
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('Release base must be a public HTTPS URL.')
  const root = resolve(input), destination = resolve(output)
  const artifactURL = path => `${base.replace(/\/$/, '')}/${path.split('/').map(encodeURIComponent).join('/')}`
  const platforms = {}, bridgeFeeds = {}, rootFeeds = {}, checksums = []
  const definitions = JSON.parse(await readFile(join(root, 'release-artifacts.json'), 'utf8'))
  if (definitions.metadata) {
    if (definitions.metadata.version!==version || definitions.metadata.bridgeVersion!==bridgeVersion) throw new Error('Release metadata does not match the requested versions.')
    now = new Date(definitions.metadata.releaseDate)
  }
  if (!Number.isFinite(now.getTime())) throw new Error('Invalid release timestamp.')
  async function stage(name, path) {
    if (typeof name !== 'string' || basename(name) !== name || !/^[A-Za-z0-9._-]+$/.test(name)) throw new Error('Invalid artifact filename.')
    const source = join(root, name), metadata = await hashFile(source)
    await mkdir(join(destination, path, '..'), { recursive: true })
    await copyFile(source, join(destination, path))
    checksums.push(`${(await hashFile(source, 'sha256', 'hex')).hash}  ${path}`)
    return metadata
  }
  function yaml(version, entries) {
    const file = entries[0]
    return `version: ${version}\nfiles:\n${entries.map(entry => `  - url: ${JSON.stringify(entry.url)}\n    sha512: ${entry.sha512}\n    size: ${entry.size}`).join('\n')}\npath: ${JSON.stringify(file.url)}\nsha512: ${file.sha512}\nreleaseDate: ${now.toISOString()}\n`
  }
  for (const artifact of definitions.native) {
    if (!Array.isArray(artifact.targets) || !artifact.targets.length) throw new Error('Missing native target.')
    const path = `native/${version}/${artifact.file}`
    const metadata = await stage(artifact.file, path)
    const signature = (await readFile(join(root, artifact.file + '.sig'), 'utf8')).trim()
    const decoded = Buffer.from(signature, 'base64').toString('utf8')
    if (!decoded.includes(`\tversion:${version}`)) throw new Error('Native signature does not bind the release version.')
    await copyFile(join(root, artifact.file + '.sig'), join(destination, path + '.sig'))
    for (const target of artifact.targets) {
      if (!platformKeys.has(target) || platforms[target]) throw new Error('Unknown or duplicate native target.')
      platforms[target] = { url: artifactURL(path), signature }
    }
    if (migration && artifact.bridgeFeed) {
      if (!['latest.yml', 'latest-linux.yml', 'latest-mac.yml'].includes(artifact.bridgeFeed) || bridgeFeeds[artifact.bridgeFeed]) throw new Error('Invalid or duplicate bridge feed.')
      bridgeFeeds[artifact.bridgeFeed] = yaml(version, [{url:artifactURL(path),sha512:metadata.hash,size:metadata.size}])
    }
  }
  // A macOS bridge consumes ZIP; native Tauri updates consume tar.gz.
  for (const artifact of migration ? definitions.migration ?? [] : []) {
    const path = `native/${version}/${artifact.file}`
    const metadata = await stage(artifact.file, path)
    if (artifact.bridgeFeed !== 'latest-mac.yml' || bridgeFeeds[artifact.bridgeFeed]) throw new Error('Invalid migration archive feed.')
    bridgeFeeds[artifact.bridgeFeed] = yaml(version, [{url:artifactURL(path),sha512:metadata.hash,size:metadata.size}])
  }
  for (const artifact of migration ? definitions.bridge : []) {
    const metadata = await stage(artifact.file, artifact.file)
    if (!['latest.yml', 'latest-linux.yml', 'latest-mac.yml'].includes(artifact.feed) || rootFeeds[artifact.feed]) throw new Error('Invalid or duplicate legacy feed.')
    rootFeeds[artifact.feed] = yaml(bridgeVersion, [{url:artifactURL(artifact.file),sha512:metadata.hash,size:metadata.size}])
  }
  for (const artifact of definitions.downloads ?? []) await stage(artifact.file, `native/${version}/${artifact.file}`)
  for (const key of platformKeys) if (!platforms[key]) throw new Error(`Missing release target: ${key}`)
  for (const feed of migration ? ['latest.yml', 'latest-linux.yml', 'latest-mac.yml'] : []) if (!rootFeeds[feed] || !bridgeFeeds[feed]) throw new Error(`Missing update continuity feed: ${feed}`)
  await mkdir(join(destination, `bridge/${bridgeVersion}`), {recursive:true})
  for (const [name, body] of Object.entries(rootFeeds)) await writeFile(join(destination, name), body)
  for (const [name, body] of Object.entries(bridgeFeeds)) await writeFile(join(destination, `bridge/${bridgeVersion}`, name), body)
  await writeFile(join(destination, 'native/latest.json'), JSON.stringify({version,notes:'Tia Launcher',pub_date:now.toISOString(),platforms},null,2)+'\n')
  await writeFile(join(destination, `native/${version}/SHA256SUMS`),checksums.sort().join('\n')+'\n')
  return {version,bridgeVersion,targets:Object.keys(platforms)}
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [input,output,version,bridgeVersion,base,mode = 'migration'] = process.argv.slice(2)
  console.log(JSON.stringify(await releaseLayout({input,output,version,bridgeVersion,base,migration:mode==='migration'})))
}
