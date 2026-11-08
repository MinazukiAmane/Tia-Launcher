const { app, safeStorage } = require('electron')
const { DatabaseSync } = require('node:sqlite')
const { randomBytes, createCipheriv, createDecipheriv, pbkdf2Sync, createHmac, createHash } = require('node:crypto')
const { mkdtempSync, writeFileSync, readFileSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { resolve, join } = require('node:path')
const { spawn } = require('node:child_process')
const assert = require('node:assert/strict')
const scriptIndex = process.argv.findIndex(value => resolve(value) === __filename)
const helper = resolve(process.argv[scriptIndex + 1])
const backend = process.argv[scriptIndex + 2]
const temporary = mkdtempSync(join(tmpdir(),'tia-key-recovery-'))
const nativeBinary=process.env.TIA_MACOS_NATIVE_BINARY
const profile=temporary
app.setName('tia-launcher')
app.setPath('userData',profile)
app.disableHardwareAcceleration()
if (process.platform === 'linux' && backend) app.commandLine.appendSwitch('password-store', backend)
const deadline=setTimeout(()=>app.exit(2),240_000)
app.whenReady().then(async()=>{
 try {
  if (backend==='basic') safeStorage.setUsePlainTextEncryption(true)
  assert(safeStorage.isEncryptionAvailable(),'safeStorage must be available in this isolated session')
  const key=randomBytes(32), data=safeStorage.encryptString(key.toString('hex')).toString('base64')
  if (process.platform === 'darwin') {
   const blob=Buffer.from(data,'base64')
   assert.equal(blob.subarray(0,3).toString(),'v10','Unexpected macOS safeStorage format')
   const decipher=createDecipheriv('aes-128-cbc',pbkdf2Sync('isolated-keychain-password','saltysalt',1003,16,'sha1'),Buffer.alloc(16,32))
   assert.equal(Buffer.concat([decipher.update(blob.subarray(3)),decipher.final()]).toString(),key.toString('hex'),'Electron must use the isolated test keychain entry')
  }
  const recovered=safeStorage.decryptString(Buffer.from(data,'base64'))
  assert.equal(recovered,key.toString('hex'))
  const envelope={version:1,mode:'os',data,migrated:true,tag:createHmac('sha256',key).update(JSON.stringify([1,'os',data,true])).digest('hex')}
  writeFileSync(join(profile,'launcher.key'),JSON.stringify(envelope),{mode:0o600})
  const nonce=randomBytes(12), cipher=createCipheriv('aes-256-gcm',key,nonce)
  cipher.setAAD(Buffer.from(JSON.stringify(['launcher','preferences'])))
  const ciphertext=Buffer.concat([cipher.update(JSON.stringify({launcherLanguage:'id',backgroundMode:'image'})),cipher.final()])
  const db=new DatabaseSync(join(profile,'launcher.db'))
  db.exec('CREATE TABLE records(scope TEXT,name TEXT,value TEXT,PRIMARY KEY(scope,name)); PRAGMA user_version=2;')
  db.prepare('INSERT INTO records VALUES(?,?,?)').run('launcher','preferences','tia:gcm:1:'+Buffer.concat([nonce,cipher.getAuthTag(),ciphertext]).toString('base64'))
  db.close()
  const hash=()=>createHash('sha256').update(readFileSync(join(profile,'launcher.db'))).digest('hex')
  const original=hash(),challenge=randomBytes(32).toString('hex')
  const receipt=await new Promise((resolve,reject)=>{
   const child=spawn(helper,[process.platform==='darwin'?'--import-key-stdin':'--recover-profile-stdin'],{stdio:['pipe','pipe','pipe'],windowsHide:true})
   let output='',diagnostic=''
   const timer=setTimeout(()=>{child.kill();reject(new Error('Native key recovery timed out'))},45_000)
   child.stdout.on('data',chunk=>{output+=chunk;if(output.length>16384)child.kill()})
   child.stderr.on('data',chunk=>{if(diagnostic.length<4096)diagnostic+=chunk.toString().slice(0,4096-diagnostic.length)})
   child.on('error',reject)
   child.on('close',code=>{clearTimeout(timer);if(code!==0)return reject(new Error('Native key recovery failed: '+diagnostic.trim()));try{resolve(JSON.parse(output))}catch{reject(new Error('Invalid recovery receipt'))}})
   child.stdin.on('error',()=>{})
   child.stdin.end(JSON.stringify({protocol:1,nonce:challenge,profile,...(process.platform==='darwin'?{root_key:recovered}:{})}))
  })
  assert.equal(receipt.nonce,challenge);assert.equal(receipt.databaseSha256,original);assert.equal(receipt.recordsVerified,1)
  assert.equal(receipt.proof,createHmac('sha256',key).update(JSON.stringify(['tia-migration-v1',challenge,original,'1'])).digest('hex'))
  assert.equal(hash(),original)
  if (process.platform==='darwin' && nativeBinary) {
   const {startMigratedAppImage}=require('../../migration/electron/appImageStartup')
   for (let attempt=0;attempt<2;attempt++) {
    const {pid}=await startMigratedAppImage(resolve(nativeBinary),['--profile',profile],process.env,90_000,message=>process.stderr.write(message))
    try {
     const saved=JSON.parse(readFileSync(join(profile,'launcher.tauri.key'),'utf8'))
     assert.equal(saved.mode,'keychain','The main app must protect its own key after handoff')
     assert(!JSON.stringify(saved).includes(key.toString('hex')))
     const migrated=new DatabaseSync(join(profile,'launcher.db'),{readOnly:true})
     try {
      const sealed=migrated.prepare('SELECT value FROM records WHERE scope=? AND name=?').get('launcher','preferences').value
      const blob=Buffer.from(sealed.slice('tia:gcm:1:'.length),'base64')
      const decipher=createDecipheriv('aes-256-gcm',key,blob.subarray(0,12))
      decipher.setAAD(Buffer.from(JSON.stringify(['launcher','preferences'])))
      decipher.setAuthTag(blob.subarray(12,28))
      const preferences=JSON.parse(Buffer.concat([decipher.update(blob.subarray(28)),decipher.final()]).toString())
      assert.equal(preferences.launcherLanguage,'id');assert.equal(preferences.backgroundMode,'image')
     } finally {migrated.close()}
    } finally {
     try{process.kill(-pid,'SIGTERM')}catch{}
     for(let wait=0;wait<50;wait++) {
      try{process.kill(pid,0)}catch{break}
      await new Promise(resolve=>setTimeout(resolve,100))
     }
     try{process.kill(-pid,'SIGKILL')}catch{}
    }
   }
  }
  key.fill(0)
  console.log(JSON.stringify({ok:true,platform:process.platform,backend:process.platform==='linux'?safeStorage.getSelectedStorageBackend():'keychain'}))
  clearTimeout(deadline);app.exit(0)
 } catch(error){console.error(error.message);clearTimeout(deadline);app.exit(1)}
})
app.on('quit',()=>{try{rmSync(temporary,{recursive:true,force:true})}catch{}})
