import { mkdir,writeFile } from 'node:fs/promises'
import { createWriteStream } from 'node:fs'
import { Readable,Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { join,resolve } from 'node:path'
const [version,directory='release/existing-native']=process.argv.slice(2)
if(!/^2\.\d+\.\d+$/.test(version??''))throw new Error('Expected a stable native release.')
const origin='https://tia-launcher-releases.s3.us-east-002.serenetia.com'
const response=await fetch(origin+'/native/latest.json',{signal:AbortSignal.timeout(30_000)})
if(!response.ok)throw new Error(`Native manifest HTTP ${response.status}`)
const raw=await response.text(),feed=JSON.parse(raw)
if(feed.version!==version)throw new Error('The live native release changed; review the bridge target.')
await mkdir(resolve(directory),{recursive:true})
await writeFile(join(directory,'live-feed.json'),raw)
const native=[]
for(const [target,bridgeFeed] of [['linux-x86_64','latest-linux.yml'],['linux-x86_64-deb'],['linux-x86_64-pacman']]) {
 const entry=feed.platforms[target],url=new URL(entry.url)
 const prefix=`/api/updates/native/${version}/`
 if(url.origin!=='https://tia-launcher.serenetia.com'||!url.pathname.startsWith(prefix)||url.search||url.hash)throw new Error('Unexpected native package URL.')
 const name=url.pathname.slice(prefix.length)
 if(!/^[A-Za-z0-9._-]+$/.test(name)||!entry.signature)throw new Error('Missing package signature or unsafe name.')
 const download=await fetch(`${origin}/native/${version}/${name}`,{signal:AbortSignal.timeout(600_000)})
 if(!download.ok||!download.body)throw new Error(`Native package HTTP ${download.status}`)
 let size=0
 const limit=new Transform({transform(chunk,encoding,done){size+=chunk.length;done(size>512*1024*1024?new Error('Native package exceeds its verified size limit.'):null,chunk)}})
 await pipeline(Readable.fromWeb(download.body),limit,createWriteStream(join(directory,name),{flags:'wx'}))
 await writeFile(join(directory,name+'.sig'),entry.signature+'\n')
 native.push({file:name,targets:[target],...(bridgeFeed?{bridgeFeed}:{})})
 console.log(`Downloaded signed native input: ${name}`)
}
await writeFile(join(directory,'release-artifacts.json'),JSON.stringify({native},null,2))
