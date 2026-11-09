import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { execFileSync } from 'node:child_process'

const [run, output='release/combined'] = process.argv.slice(2)
const repository=process.env.GITHUB_REPOSITORY,token=process.env.GH_TOKEN
if (!/^[1-9]\d*$/.test(run??'') || !/^[\w.-]+\/[\w.-]+$/.test(repository??'') || !token) throw new Error('Authenticated candidate context is required.')
const headers={Authorization:`Bearer ${token}`,Accept:'application/vnd.github+json'}
const base=`https://api.github.com/repos/${repository}/actions`
const response=await fetch(`${base}/runs/${run}/artifacts?per_page=100`,{headers,signal:AbortSignal.timeout(30_000)})
if (!response.ok) throw new Error(`Could not list candidate artifacts: HTTP ${response.status}`)
const {artifacts}=await response.json()
await mkdir(resolve(output),{recursive:true})
for (const name of ['release-Linux','release-Windows','release-macOS']) {
  const matches=artifacts.filter(artifact=>artifact.name===name&&!artifact.expired)
  if (matches.length!==1 || !/^sha256:[a-f0-9]{64}$/.test(matches[0].digest??'')) throw new Error(`Missing artifact or GitHub digest: ${name}`)
  const artifact=matches[0],directory=await mkdtemp(join(tmpdir(),'tia-artifact-')),file=join(directory,'artifact.zip')
  try {
    const download=await fetch(`${base}/artifacts/${artifact.id}/zip`,{headers,signal:AbortSignal.timeout(600_000)})
    if (!download.ok || !download.body) throw new Error(`Could not download ${name}: HTTP ${download.status}`)
    const hash=createHash('sha256');let size=0
    const verify=new Transform({transform(chunk,encoding,done){
      size+=chunk.length
      if(size>2*1024**3)return done(new Error('Release artifact exceeds its download limit.'))
      hash.update(chunk);done(null,chunk)
    }})
    await pipeline(Readable.fromWeb(download.body),verify,createWriteStream(file,{flags:'wx',mode:0o600}))
    if (`sha256:${hash.digest('hex')}`!==artifact.digest) throw new Error(`GitHub artifact digest mismatch: ${name}`)
    execFileSync('python3',['migration/installer/extract-artifact.py',file,resolve(output)],{stdio:'inherit'})
    console.log(`Verified GitHub artifact: ${name}`)
  } finally {await rm(directory,{recursive:true,force:true})}
}
