import { app, safeStorage } from 'electron'
import { randomBytes, createHash, createHmac, createCipheriv } from 'node:crypto'
import { mkdirSync, existsSync, writeFileSync, realpathSync, readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import { BridgeCoordinator } from '../electron/bridgeCoordinator'
import { BridgeNsisUpdater } from '../electron/bridgeNsisUpdater'
import { readWindowsInstallContext } from '../electron/installContext'

const argumentsList=process.argv
const profileIndex=argumentsList.indexOf('--profile')
if(profileIndex<0) throw new Error('An explicit test profile is required.')
const profile=argumentsList[profileIndex+1]
if(!profile || !/tia-bridge-(current|all)/.test(profile)) throw new Error('Only migration test profiles are allowed.')
mkdirSync(profile,{recursive:true})
app.setPath('userData',profile)

function prepareFixture():void {
 if(existsSync(join(profile,'launcher.db'))) return
 if(!safeStorage.isEncryptionAvailable()) throw new Error('Windows encryption is unavailable.')
 const key=randomBytes(32)
 const data=safeStorage.encryptString(key.toString('hex')).toString('base64')
 const envelope={version:1,mode:'os',data,migrated:true,tag:createHmac('sha256',key).update(JSON.stringify([1,'os',data,true])).digest('hex')}
 writeFileSync(join(profile,'launcher.key'),JSON.stringify(envelope))
 const game=join(profile,'GameFixture');mkdirSync(join(game,'Bin'),{recursive:true});mkdirSync(join(game,'Data'),{recursive:true})
 writeFileSync(join(game,'Bin','test-client.txt'),'unchanged-game-fixture')
 const db=new DatabaseSync(join(profile,'launcher.db'))
 db.exec('CREATE TABLE records(scope TEXT,name TEXT,value TEXT,PRIMARY KEY(scope,name));PRAGMA user_version=2;')
 function put(scope:string,name:string,value:unknown):void {
  const nonce=randomBytes(12);const cipher=createCipheriv('aes-256-gcm',key,nonce);cipher.setAAD(Buffer.from(JSON.stringify([scope,name])))
  const ciphertext=Buffer.concat([cipher.update(JSON.stringify(value)),cipher.final()])
  db.prepare('INSERT INTO records VALUES(?,?,?)').run(scope,name,'tia:gcm:1:'+Buffer.concat([nonce,cipher.getAuthTag(),ciphertext]).toString('base64'))
 }
 put('launcher','settings',{lang:'na_id',fpsLimit:144,classicUi:true,launchCommand:'-port 50601'})
 put('launcher','preferences',{launcherLanguage:'id',backgroundMode:'image',confirmedInstallDir:game})
 put('launcher','selectedInstallation',{installDir:game})
 put('game:'+realpathSync(game).toLowerCase(),'install',{version:'0.1.54',installDir:game,files:[]})
 db.close();key.fill(0)
}

app.whenReady().then(async()=>{
 prepareFixture()
 if(argumentsList.includes('--prepare-only')){
  let persisted=false
  for(let attempt=0;attempt<200;attempt++){
   try{persisted=!!JSON.parse(readFileSync(join(profile,'Local State'),'utf8')).os_crypt?.encrypted_key}catch{}
   if(persisted)break
   await new Promise(resolve=>setTimeout(resolve,100))
  }
  if(!persisted)throw new Error('Chromium did not persist the Windows encryption key.')
  console.log('Legacy fixture prepared');app.quit();return
 }
 const configuration=JSON.parse(readFileSync(join(process.resourcesPath,'migration','test-configuration.json'),'utf8'))
 const updater=new BridgeNsisUpdater()
 updater.allowPrerelease=true;updater.autoDownload=false;updater.autoInstallOnAppQuit=false;updater.disableDifferentialDownload=true
 updater.logger={info:()=>{},warn:()=>{},error:()=>{},debug:()=>{}}
 updater.setFeedURL({provider:'generic',url:configuration.feed})
 const update=await updater.checkForUpdates()
 if(!update || update.updateInfo.version!==configuration.targetVersion) throw new Error('Test update was not found.')
 const paths=await updater.downloadUpdate()
 const signedRelease=JSON.parse(readFileSync(join(process.resourcesPath,'migration','release.json'),'utf8'))
 let busy=false
 await new BridgeCoordinator().install({profile,helper:join(process.resourcesPath,'migration','tia-migration-helper.exe'),installer:paths[0],appId:configuration.appId,bridgeVersion:app.getVersion(),targetVersion:configuration.targetVersion,keys:configuration.keys,signedRelease,storage:safeStorage,
  acquireOperation:()=>{if(busy)throw new Error('Already migrating');busy=true;return()=>{busy=false}},
  installation:()=>readWindowsInstallContext(process.execPath,configuration.guid),
  install:context=>{updater.setMigrationContext(context);console.log(JSON.stringify({phase:'installer-dispatched',scope:context.scope,directory:context.directory,databaseSha256:createHash('sha256').update(readFileSync(join(profile,'launcher.db'))).digest('hex')}));updater.quitAndInstall(true,false)}
 })
}).catch(error=>{console.error(error instanceof Error?error.message:'Bridge test failed');app.exit(1)})
