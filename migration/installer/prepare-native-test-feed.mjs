import { mkdir, readFile, writeFile, copyFile, chmod } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { execFileSync } from 'node:child_process'

const root=resolve(import.meta.dirname,'../..')
const directory=join(root,'release-test/native-updater')
const feed=join(directory,'feed');const secrets=join(directory,'secrets')
await mkdir(feed,{recursive:true});await mkdir(secrets,{recursive:true,mode:0o700})
const key=join(secrets,'test.key')
try{await readFile(key)}catch{execFileSync(join(root,'node_modules/.bin/tauri'),['signer','generate','--ci','--write-keys',key],{stdio:'pipe'});await chmod(key,0o600)}
const publicKey=(await readFile(key+'.pub','utf8')).trim()
const version='2.0.0-alpha.2'
const good=join(feed,'signed-test.bin');await writeFile(good,'First-party native updater signature fixture.\n')
execFileSync(join(root,'node_modules/.bin/tauri'),['signer','sign','--private-key-path',key,'--app-version',version,good],{stdio:'pipe'})
const signature=(await readFile(good+'.sig','utf8')).trim()
await writeFile(join(feed,'tampered-test.bin'),'A different payload that must not be accepted.\n')
const manifest=(url,version,signature)=>({version,notes:'Isolated native updater test',pub_date:'2026-11-08T00:00:00Z',platforms:{'windows-x86_64':{url,signature},'linux-x86_64':{url,signature}}})
const base='http://127.0.0.1:18479/'
for(const [name,payload,announced] of [['valid','signed-test.bin',version],['tampered','tampered-test.bin',version],['mismatch','signed-test.bin','2.0.0-alpha.3']])await writeFile(join(feed,`native-${name}.json`),JSON.stringify(manifest(base+payload,announced,signature)))
const installer=process.argv[2]
if(installer){
 const target=join(feed,'native-update.exe');await copyFile(resolve(installer),target)
 execFileSync(join(root,'node_modules/.bin/tauri'),['signer','sign','--private-key-path',key,'--app-version',version,target],{stdio:'pipe'})
 await writeFile(join(feed,'native-install.json'),JSON.stringify(manifest(base+'native-update.exe',version,(await readFile(target+'.sig','utf8')).trim())))
}
await writeFile(join(directory,'public-key.json'),JSON.stringify({publicKey}))
console.log(JSON.stringify({feed,publicKeyFile:join(directory,'public-key.json'),installerIncluded:!!installer}))
