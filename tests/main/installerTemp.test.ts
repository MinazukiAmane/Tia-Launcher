import { afterEach, expect, it } from 'vitest'
import { createRequire } from 'node:module'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const require=createRequire(import.meta.url)
const temp=require('../../migration/compat/temp/index.cjs') as {track():void;mkdir(prefix:string,callback:(error:Error|null,path:string)=>void):void;cleanupSync():void}
const {createTempDir}=require('electron-winstaller/lib/temp-utils') as {createTempDir(prefix:string):Promise<string>}
const paths:string[]=[]
afterEach(async()=>{temp.cleanupSync();await Promise.all(paths.splice(0).map(path=>rm(path,{recursive:true,force:true})))})
it('creates private installer directories through the real packager API and keeps unrelated files during cleanup',async()=>{
 const unrelated=await mkdtemp(join(tmpdir(),'tia-unrelated-'));paths.push(unrelated)
 await writeFile(join(unrelated,'keep.txt'),'keep')
 const directory=await createTempDir('tia-installer');paths.push(directory)
 await writeFile(join(directory,'package.nupkg'),'installer fixture')
 if(process.platform!=='win32')expect((await stat(directory)).mode&0o077).toBe(0)
 temp.cleanupSync()
 await expect(stat(directory)).rejects.toMatchObject({code:'ENOENT'})
 expect(await readFile(join(unrelated,'keep.txt'),'utf8')).toBe('keep')
})
it('rejects paths escaping the temporary directory',async()=>{
 await expect(new Promise((resolve,reject)=>temp.mkdir('../outside',(error,path)=>error?reject(error):resolve(path)))).rejects.toThrow(/prefix/)
})
