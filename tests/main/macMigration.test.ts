import { afterEach, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import AdmZip from 'adm-zip'
import { readMacContext, replaceMacBundle } from '../../migration/electron/macMigration'

const directories:string[]=[]
afterEach(async()=>{await Promise.all(directories.splice(0).map(path=>rm(path,{recursive:true,force:true})))})
async function fixture(id='com.serenetia.tia-launcher',version='2.0.0') {
 const directory=await realpath(await mkdtemp(join(tmpdir(),'tia-mac-bundle-')));directories.push(directory)
 const bundle=join(directory,"My Tia's Launcher.app"),executable=join(bundle,'Contents/MacOS/Tia Launcher')
 await mkdir(join(bundle,'Contents/MacOS'),{recursive:true});await writeFile(executable,'old launcher');await chmod(executable,0o755)
 const identity={id,version,executable:'Tia Launcher'}
 await writeFile(join(bundle,'Contents/Info.plist'),JSON.stringify({...identity,version:'1.99.0'}))
 const readIdentity=async(path:string)=>JSON.parse(await readFile(join(path,'Contents/Info.plist'),'utf8'))
 const context=await readMacContext(executable,id,readIdentity)
 const zip=new AdmZip()
 zip.addFile('Tia Launcher.app/Contents/Info.plist',Buffer.from(JSON.stringify(identity)))
 zip.addFile('Tia Launcher.app/Contents/MacOS/Tia Launcher',Buffer.from('new launcher'),' ',0o755)
 const archive=join(directory,'update.zip');zip.writeZip(archive)
 const hash=createHash('sha512').update(await readFile(archive)).digest('base64')
 return {directory,bundle,executable,context,archive,hash,readIdentity,zip}
}
it.skipIf(process.platform==='win32')('keeps the existing bundle path, executes the new launcher and removes backup files after readiness',async()=>{
 const f=await fixture()
 await replaceMacBundle(f.context,f.archive,f.hash,'2.0.0',async binary=>{
  expect(binary).toBe(f.executable)
  expect(await readFile(binary,'utf8')).toBe('new launcher')
 },f.readIdentity)
 expect((await readdir(f.directory)).sort()).toEqual(["My Tia's Launcher.app",'update.zip'])
})
it.skipIf(process.platform==='win32')('restores the original complete bundle when startup fails',async()=>{
 const f=await fixture()
 await expect(replaceMacBundle(f.context,f.archive,f.hash,'2.0.0',async()=>{throw new Error('startup failed')},f.readIdentity)).rejects.toThrow('startup failed')
 expect(await readFile(f.executable,'utf8')).toBe('old launcher')
})
it.skipIf(process.platform==='win32')('rejects a different signed application version and changed downloads before moving the current bundle',async()=>{
 const f=await fixture()
 await expect(replaceMacBundle(f.context,f.archive,f.hash,'2.0.1',async()=>{},f.readIdentity)).rejects.toThrow(/identity or version/)
 await writeFile(f.archive,'changed')
 await expect(replaceMacBundle(f.context,f.archive,f.hash,'2.0.0',async()=>{},f.readIdentity)).rejects.toThrow(/has changed/)
 expect(await readFile(f.executable,'utf8')).toBe('old launcher')
})
it.skipIf(process.platform==='win32')('rejects linked archive entries instead of following them outside the bundle',async()=>{
 const f=await fixture()
 const altered=new AdmZip(await readFile(f.archive))
 altered.addFile('Tia Launcher.app/Contents/linked',Buffer.from('/tmp'))
 altered.getEntry('Tia Launcher.app/Contents/linked')!.attr=(0o120777<<16)>>>0
 altered.writeZip(f.archive)
 const hash=createHash('sha512').update(await readFile(f.archive)).digest('base64')
 await expect(replaceMacBundle(f.context,f.archive,hash,'2.0.0',async()=>{},f.readIdentity)).rejects.toThrow(/linked or special/)
 expect(await readFile(f.executable,'utf8')).toBe('old launcher')
})
