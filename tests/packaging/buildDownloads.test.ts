import { afterEach, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { downloadReleaseAsset } from '../../migration/installer/prepare-build-downloads.mjs'

const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, {recursive:true,force:true}))) })
async function fixture(tag: string, options: { badData?: boolean; badRedirect?: boolean; transient?: boolean } = {}) {
 const directory=await mkdtemp(join(tmpdir(),'tia-build-download-'));directories.push(directory)
 const bytes=Buffer.from('verified release payload'),checksum=createHash('sha256').update(bytes).digest('hex')
 const calls: {url:string;headers:Record<string,string>}[]=[];let assetRequests=0
 const request=async (url:string,init:{headers:Record<string,string>}) => {
  calls.push({url,headers:init.headers})
  if(url.includes('/releases/tags/'))return new Response(JSON.stringify({assets:[{name:'tool.zip',id:123,size:bytes.length,digest:`sha256:${checksum}`}]}))
  if(url.includes('/releases/assets/')) {
   if(options.transient && ++assetRequests<3)return new Response('',{status:504})
   return new Response(null,{status:302,headers:{location:options.badRedirect?'https://attacker.example/tool.zip':'https://release-assets.githubusercontent.com/fixture/tool.zip'}})
  }
  return new Response(options.badData?Buffer.alloc(bytes.length):bytes)
 }
 return {spec:{repository:'fixture/build-tools',tag,name:'tool.zip',destination:join(directory,'tool.zip'),checksum},bytes,calls,request}
}
it('verifies payloads, reuses verified cache and keeps API credentials away from asset hosts',async()=>{
 const f=await fixture('valid')
 await downloadReleaseAsset(f.spec,{request:f.request,token:'fixture-token',retryDelay:0})
 expect(await readFile(f.spec.destination)).toEqual(f.bytes)
 expect(f.calls.at(-1)?.headers.Authorization).toBeUndefined()
 expect(f.calls[0].headers.Authorization).toBe('Bearer fixture-token')
 const count=f.calls.length
 await downloadReleaseAsset(f.spec,{request:f.request,token:'fixture-token',retryDelay:0})
 expect(f.calls).toHaveLength(count)
})
it('rejects altered bytes before placing them in the dependency cache',async()=>{
 const f=await fixture('bad-data',{badData:true})
 await expect(downloadReleaseAsset(f.spec,{request:f.request,retryDelay:0})).rejects.toThrow('checksum mismatch')
 await expect(readFile(f.spec.destination)).rejects.toMatchObject({code:'ENOENT'})
})
it('rejects redirects outside the official release asset hosts',async()=>{
 const f=await fixture('bad-redirect',{badRedirect:true})
 await expect(downloadReleaseAsset(f.spec,{request:f.request,retryDelay:0})).rejects.toThrow('Unexpected build asset redirect')
 expect(f.calls.some(call=>call.url.includes('attacker.example'))).toBe(false)
})
it('retries temporary HTTP failures while still verifying the final payload',async()=>{
 const f=await fixture('retry',{transient:true})
 await downloadReleaseAsset(f.spec,{request:f.request,retryDelay:0})
 expect(await readFile(f.spec.destination)).toEqual(f.bytes)
 expect(f.calls.filter(call=>call.url.includes('/releases/assets/'))).toHaveLength(3)
})
