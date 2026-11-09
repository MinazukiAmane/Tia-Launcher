import { createHash } from 'node:crypto'
import { readFile,mkdir,writeFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
const configuration=JSON.parse(await readFile('nix/native-runtimes.json','utf8'))
const response=await fetch(configuration.url,{signal:AbortSignal.timeout(120_000)})
if(!response.ok)throw new Error(`Native runtimes HTTP ${response.status}`)
const bytes=Buffer.from(await response.arrayBuffer())
if(bytes.length>32*1024*1024||'sha256-'+createHash('sha256').update(bytes).digest('base64')!==configuration.hash)throw new Error('Native runtimes hash mismatch.')
await mkdir('release/existing-runtimes',{recursive:true})
await writeFile('release/existing-runtimes.tar.gz',bytes)
execFileSync('tar',['-xzf','release/existing-runtimes.tar.gz','-C','release/existing-runtimes'],{stdio:'inherit'})
await mkdir('build/native/cedar',{recursive:true})
for(const [source,target,names]of [
 ['client-runtime','build/native',['csore-start-x86.exe','csore-start-x64.exe']],
 ['game-runtime','build/native/cedar',['cedar-start-x64.exe','cedar-client-x64.dll','launcher-services.json','LICENSE-Minhook.txt']]
])for(const name of names)await writeFile(target+'/'+name,await readFile('release/existing-runtimes/'+source+'/'+name))
console.log('Prepared hash-pinned client runtimes without private source checkout.')
