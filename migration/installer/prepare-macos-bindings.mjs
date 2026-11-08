import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname,'../..')
const lock = JSON.parse(await readFile(join(root,'package-lock.json'),'utf8'))
for (const arch of ['arm64','x64']) {
  const name = `node_modules/@bsdiff-rust/node-darwin-${arch}`
  const dependency = lock.packages[name]
  if (!dependency || !/^sha512-[A-Za-z0-9+/]+=*$/.test(dependency.integrity)) throw new Error('Missing locked macOS patch runtime.')
  const address = new URL(dependency.resolved)
  if (address.protocol!=='https:' || address.hostname!=='registry.npmjs.org') throw new Error('Unexpected patch runtime registry.')
  const response = await fetch(address,{signal:AbortSignal.timeout(60_000)})
  if (!response.ok) throw new Error('Could not fetch the locked macOS patch runtime.')
  const chunks = []; let bytes=0
  for await (const chunk of response.body) {
    bytes+=chunk.length
    if (bytes>16*1024*1024) throw new Error('macOS patch runtime archive is too large.')
    chunks.push(chunk)
  }
  const archive = Buffer.concat(chunks)
  if ('sha512-'+createHash('sha512').update(archive).digest('base64')!==dependency.integrity) throw new Error('macOS patch runtime integrity mismatch.')
  const temporary = join(root,`release/patch-runtime-${arch}.tar.gz`)
  await mkdir(join(root,'release'),{recursive:true})
  await writeFile(temporary,archive)
  try {
    const entries = execFileSync('tar',['-tzf',temporary],{encoding:'utf8'}).trim().split('\n')
    if (entries.some(name=>!name.startsWith('package/')||name.includes('\\')||name.split('/').some(part=>part==='..'))) throw new Error('Unsafe patch runtime archive.')
    const directory = join(root,name)
    await mkdir(directory,{recursive:true})
    execFileSync('tar',['-xzf',temporary,'--strip-components=1','-C',directory])
    console.log(`Verified locked macOS patch runtime: ${arch}`)
  } finally { await rm(temporary,{force:true}) }
}
