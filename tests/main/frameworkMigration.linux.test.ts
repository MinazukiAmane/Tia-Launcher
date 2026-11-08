import { afterEach, expect, it, vi } from 'vitest'
import { createHash, createHmac, generateKeyPairSync, sign } from 'node:crypto'
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { DatabaseCipher } from '../../src/main/databaseCipher'

const mocks = vi.hoisted(() => ({ profile: '', keys: [] as {id:string;publicKey:string}[], quit: vi.fn(), start: vi.fn().mockResolvedValue({pid:123}) }))
vi.mock('electron', () => ({ app: {getPath: () => mocks.profile, getVersion: () => '1.99.0', quit: mocks.quit}, safeStorage: {decryptString: () => {throw new Error('Unexpected OS key access')}} }))
vi.mock('../../src/shared/migrationKeys.json', () => ({ default: mocks.keys }))
vi.mock('../../migration/electron/appImageStartup', () => ({startMigratedAppImage: mocks.start}))

const resourcesDescriptor = Object.getOwnPropertyDescriptor(process,'resourcesPath')
const previousAppImage = process.env.APPIMAGE
const directories: string[] = []
afterEach(async () => {
 if (resourcesDescriptor) Object.defineProperty(process,'resourcesPath',resourcesDescriptor)
 else delete (process as unknown as Record<string,unknown>).resourcesPath
 if (previousAppImage === undefined) delete process.env.APPIMAGE
 else process.env.APPIMAGE = previousAppImage
 mocks.keys.splice(0); vi.clearAllMocks(); mocks.start.mockResolvedValue({pid:123})
 await Promise.all(directories.splice(0).map(path => rm(path,{recursive:true,force:true})))
})

async function fixture() {
 const directory = await mkdtemp(join(tmpdir(),'tia-linux-bridge-')); directories.push(directory)
 mocks.profile = join(directory,'profile'); await mkdir(mocks.profile)
 const resources = join(directory,'resources'); await mkdir(join(resources,'migration'),{recursive:true})
 Object.defineProperty(process,'resourcesPath',{configurable:true,value:resources})
 const current = join(directory,'Custom Launcher.AppImage')
 await writeFile(current,'previous launcher'); await chmod(current,0o751); process.env.APPIMAGE=current
 const installer = join(directory,'download.AppImage')
 const payload = Buffer.from([0x7f,0x45,0x4c,0x46,2,1,1,0,0x41,0x49,2,0])
 await writeFile(installer,payload)
 const helper = join(resources,'migration/tia-migration-helper')
 await copyFile(resolve('src-tauri/target/debug/tia-migration-helper'),helper); await chmod(helper,0o755)
 const key = Buffer.alloc(32,23)
 const envelope = {version:1,mode:'file',data:key.toString('hex'),migrated:true,tag:''}
 envelope.tag=createHmac('sha256',key).update(JSON.stringify([1,'file',envelope.data,true])).digest('hex')
 await writeFile(join(mocks.profile,'launcher.key'),JSON.stringify(envelope))
 const db=new DatabaseSync(join(mocks.profile,'launcher.db'))
 db.exec('CREATE TABLE records(scope TEXT,name TEXT,value TEXT,PRIMARY KEY(scope,name)); PRAGMA user_version=2;')
 db.prepare('INSERT INTO records VALUES(?,?,?)').run('launcher','preferences',new DatabaseCipher(key).seal('launcher','preferences',JSON.stringify({launcherLanguage:'id',backgroundMode:'image'})))
 db.close()
 const pair=generateKeyPairSync('ed25519'), publicKey=pair.publicKey.export({type:'spki',format:'pem'}).toString()
 const keyId=createHash('sha256').update(pair.publicKey.export({type:'spki',format:'der'})).digest('hex')
 mocks.keys.push({id:keyId,publicKey})
 const body=JSON.stringify({protocol:1,appId:'com.serenetia.tia-launcher',bridgeVersion:'1.99.0',targetVersion:'2.0.0',platform:`linux-${process.arch}`,installerSha512:createHash('sha512').update(payload).digest('base64'),helperSha256:createHash('sha256').update(await readFile(helper)).digest('hex')})
 await writeFile(join(resources,'migration/release.json'),JSON.stringify({body,keyId,signature:sign(null,Buffer.from('Tia launcher framework migration v1\0'+body),pair.privateKey).toString('base64')}))
 return {installer,current,payload}
}
it.skipIf(process.platform !== 'linux')('preserves the custom AppImage path and only quits after the new launcher acknowledges readiness',async () => {
 const f=await fixture()
 const {prepareFrameworkMigration,isFrameworkMigrationInProgress}=await import('../../src/main/frameworkMigration')
 mocks.start.mockImplementationOnce(async path => {
  expect(path).toBe(f.current)
  expect(await readFile(path)).toEqual(f.payload)
  expect(await readFile(join(mocks.profile,'launcher.tauri.key'),'utf8')).toContain('"version":1')
  expect(mocks.quit).not.toHaveBeenCalled()
  expect(isFrameworkMigrationInProgress()).toBe(true)
  return {pid:123}
 })
 await prepareFrameworkMigration(f.installer,'2.0.0',()=>false,()=>{throw new Error('Windows installer must not run')})
 expect(mocks.quit).toHaveBeenCalledOnce()
 expect(isFrameworkMigrationInProgress()).toBe(false)
})
it.skipIf(process.platform !== 'linux')('restores the previous AppImage and releases the operation lock if native startup fails',async () => {
 const f=await fixture()
 const {prepareFrameworkMigration,isFrameworkMigrationInProgress}=await import('../../src/main/frameworkMigration')
 mocks.start.mockRejectedValueOnce(new Error('native startup failed'))
 await expect(prepareFrameworkMigration(f.installer,'2.0.0',()=>false,()=>{})).rejects.toThrow('native startup failed')
 expect(await readFile(f.current,'utf8')).toBe('previous launcher')
 expect(mocks.quit).not.toHaveBeenCalled()
 expect(isFrameworkMigrationInProgress()).toBe(false)
})
