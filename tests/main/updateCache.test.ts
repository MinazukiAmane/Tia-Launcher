import {afterEach,expect,it} from 'vitest'
import {createHash} from 'node:crypto'
import {mkdtemp,mkdir,rm,writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {DownloadedUpdateHelper} from 'electron-updater/out/DownloadedUpdateHelper'
const directories:string[]=[]
afterEach(async()=>{await Promise.all(directories.splice(0).map(path=>rm(path,{recursive:true,force:true})))})
it('reuses identical parsed release metadata while rejecting a changed hash and tampered cached payload',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'tia-update-cache-'));directories.push(directory)
 const helper=new DownloadedUpdateHelper(directory)
 await mkdir(helper.cacheDirForPendingUpdate,{recursive:true})
 const name='launcher.exe',file=join(helper.cacheDirForPendingUpdate,name),bytes=Buffer.from('authenticated release fixture')
 await writeFile(file,bytes)
 const sha512=createHash('sha512').update(bytes).digest('base64')
 const info={version:'2.0.1',files:[{url:name,sha512,size:bytes.length}],path:name,sha512,releaseDate:'2026-11-08T00:00:00Z'}
 const resolved={url:new URL('https://updates.test/'+name),info:info.files[0]}
 const logger={info:()=>{},warn:()=>{},error:()=>{}}
 await helper.setDownloadedFile(file,null,info,resolved,name,true)
 const parsed=JSON.parse(JSON.stringify(info))
 await expect(helper.validateDownloadedPath(file,parsed,{...resolved,info:{...resolved.info}},logger)).resolves.toBe(file)
 await expect(helper.validateDownloadedPath(file,parsed,{...resolved,info:{...resolved.info,sha512:'changed'}},logger)).resolves.toBeNull()
 await writeFile(file,'modified payload')
 await expect(new DownloadedUpdateHelper(directory).validateDownloadedPath(file,parsed,resolved,logger)).resolves.toBeNull()
})
