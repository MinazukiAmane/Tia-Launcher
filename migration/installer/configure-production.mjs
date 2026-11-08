import { createHash, createPublicKey, generateKeyPairSync } from 'node:crypto'
import { chmod, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { execFileSync } from 'node:child_process'
const root=resolve(import.meta.dirname,'../..')
const directory=join(root,'migration-secrets')
await mkdir(directory,{recursive:true,mode:0o700});await chmod(directory,0o700)
const native=join(directory,'native-updater.key'), migration=join(directory,'electron-migration.pem')
try{await stat(native)}catch(error){
 if(error.code!=='ENOENT')throw error
 execFileSync(join(root,'node_modules/.bin/tauri'),['signer','generate','--ci','--write-keys',native],{stdio:'pipe'})
}
await chmod(native,0o600)
try{await stat(migration)}catch(error){
 if(error.code!=='ENOENT')throw error
 const pair=generateKeyPairSync('ed25519')
 await writeFile(migration,pair.privateKey.export({type:'pkcs8',format:'pem'}),{mode:0o600,flag:'wx'})
}
await chmod(migration,0o600)
const publicKey=(await readFile(native+'.pub','utf8')).trim()
const raw=await readFile(migration)
let proofKey
try{proofKey=createPublicKey(raw)}finally{raw.fill(0)}
const keyId=createHash('sha256').update(proofKey.export({type:'spki',format:'der'})).digest('hex')
const pins=[{id:keyId,publicKey:proofKey.export({type:'spki',format:'pem'}).toString()}]
const endpoints=['https://tia-launcher.serenetia.com/api/updates/native/latest.json']
await writeFile(join(root,'src/shared/migrationKeys.json'),JSON.stringify(pins,null,2)+'\n')
await writeFile(join(root,'src-tauri/native-updates.json'),JSON.stringify({enabled:true,endpoints,publicKey},null,2)+'\n')
await writeFile(join(root,'src-tauri/tauri.production.conf.json'),JSON.stringify({productName:'Tia Launcher',identifier:'com.serenetia.tia-launcher',bundle:{shortDescription:'Tia Launcher game library',createUpdaterArtifacts:false},plugins:{updater:{pubkey:publicKey,endpoints,requireSignedVersion:true,allowDowngrades:false}}},null,2)+'\n')
console.log('Production public pins configured. Private release keys remain in the ignored migration-secrets directory.')
