import { afterEach,expect,it } from 'vitest'
import { mkdtemp,readFile,writeFile,rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { linuxBridgeLayout } from '../../migration/installer/linux-bridge-layout.mjs'
const directories:string[]=[]
afterEach(async()=>{await Promise.all(directories.splice(0).map(path=>rm(path,{recursive:true,force:true})))})
async function fixture(){
 const input=await mkdtemp(join(tmpdir(),'tia-linux-feed-'));directories.push(input)
 const native=['AppImage','deb','pacman'].map((extension,i)=>({file:`native.${extension}`,targets:[['linux-x86_64','linux-x86_64-deb','linux-x86_64-pacman'][i]]}))
 const bridge=['x86_64.AppImage','amd64.deb','x64.pacman'].map(suffix=>({file:`Tia-Launcher-1.19.1-linux-${suffix}`,feed:'latest-linux.yml'}))
 for(const artifact of [...native,...bridge])await writeFile(join(input,artifact.file),artifact.file)
 const manifest=JSON.stringify({version:'2.0.0',platforms:Object.fromEntries(native.map(a=>[a.targets[0],{url:`https://tia-launcher.serenetia.com/api/updates/native/2.0.0/${a.file}`,signature:'signed fixture'}]))},null,2)+'\n'
 const file=join(input,'live-feed.json');await writeFile(file,manifest)
 const definition={metadata:{version:'2.0.0',bridgeVersion:'1.19.1',releaseDate:'2026-11-09T00:00:00Z'},native,bridge}
 await writeFile(join(input,'artifacts-linux.json'),JSON.stringify(definition))
 return {input,output:join(input,'publish'),file,manifest,definition}
}
it('repairs Linux continuity without generating Windows or macOS feeds or changing the native manifest',async()=>{
 const f=await fixture();await linuxBridgeLayout(f.input,f.output,f.file)
 expect(await readFile(join(f.output,'native/latest.json'),'utf8')).toBe(f.manifest)
 const {load}=await import('js-yaml')
 for(const [path,version]of [['latest-linux.yml','1.19.1'],['bridge/1.19.1/latest-linux.yml','2.0.0']]){
  const feed=load(await readFile(join(f.output,path),'utf8')) as {version:string;files:{url:string}[]}
  expect(feed.version).toBe(version)
  expect(feed.files).toHaveLength(3)
  for(const format of ['.AppImage','.deb','.pacman'])expect(feed.files.some(file=>file.url.endsWith(format))).toBe(true)
 }
 for(const path of ['latest.yml','latest-mac.yml'])await expect(readFile(join(f.output,path))).rejects.toMatchObject({code:'ENOENT'})
})
it('refuses a native target different from the live signed package URLs',async()=>{
 const f=await fixture();f.definition.native[2].file='different.pacman'
 await writeFile(join(f.input,'artifacts-linux.json'),JSON.stringify(f.definition))
 await expect(linuxBridgeLayout(f.input,f.output,f.file)).rejects.toThrow('does not match')
})
