import { afterEach, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { releaseLayout } from '../../migration/installer/release-layout.mjs'

const directories: string[] = []
afterEach(async () => { for (const path of directories.splice(0)) await rm(path,{recursive:true,force:true}) })
async function fixture() {
  const root = await mkdtemp(join(tmpdir(),'tia-release-layout-')); directories.push(root)
  const native = [
    {file:'native.exe',targets:['windows-x86_64'],bridgeFeed:'latest.yml'},
    {file:'native.AppImage',targets:['linux-x86_64'],bridgeFeed:'latest-linux.yml'},
    {file:'native.deb',targets:['linux-x86_64-deb']},
    {file:'native.pacman',targets:['linux-x86_64-pacman']},
    {file:'native.tar.gz',targets:['darwin-x86_64','darwin-aarch64']}
  ]
  const migration = [{file:'native.zip',bridgeFeed:'latest-mac.yml'}]
  const bridge = [{file:'bridge.exe',feed:'latest.yml'},...['AppImage','deb','pacman'].map(extension=>({file:`bridge.${extension}`,feed:'latest-linux.yml'})),{file:'bridge.zip',feed:'latest-mac.yml'}]
  for (const artifact of [...native,...migration,...bridge]) await writeFile(join(root,artifact.file),artifact.file)
  for (const artifact of native) await writeFile(join(root,artifact.file+'.sig'),Buffer.from('trusted comment: timestamp:1\tversion:2.0.0\tfile:test').toString('base64'))
  const definitions = {native,migration,bridge}
  await writeFile(join(root,'release-artifacts.json'),JSON.stringify(definitions))
  return {root,definitions,options:{input:root,output:join(root,'publish'),version:'2.0.0',bridgeVersion:'1.19.0',base:'https://example.com/api/updates'}}
}

it('keeps skipped Electron releases on the bridge and separates native package formats',async()=>{
  const {options} = await fixture()
  await releaseLayout(options)
  const legacy = await readFile(join(options.output,'latest.yml'),'utf8')
  expect(legacy).toContain('version: 1.19.0')
  expect(legacy).toContain('/bridge.exe')
  const bridge = await readFile(join(options.output,'bridge/1.19.0/latest.yml'),'utf8')
  expect(bridge).toContain('version: 2.0.0')
  expect(bridge).toContain('/native/2.0.0/native.exe')
  expect(await readFile(join(options.output,'bridge/1.19.0/latest-mac.yml'),'utf8')).toContain('native.zip')
  const native = JSON.parse(await readFile(join(options.output,'native/latest.json'),'utf8'))
  expect(native.platforms['darwin-aarch64'].url).toContain('native.tar.gz')
  expect(native.platforms['linux-x86_64-deb'].url).toContain('native.deb')
  expect(native.platforms['linux-x86_64-pacman'].url).toContain('native.pacman')
})

it('rejects missing targets, unsafe filenames and signatures for another version',async()=>{
  const {root,definitions,options} = await fixture()
  await expect(releaseLayout({...options,version:'2.0.0-alpha.1'})).rejects.toThrow(/stable/)
  await expect(releaseLayout({...options,base:'http://example.com'})).rejects.toThrow(/HTTPS/)
  await writeFile(join(root,'native.exe.sig'),Buffer.from('trusted comment: timestamp:1\tversion:2.0.1').toString('base64'))
  await expect(releaseLayout(options)).rejects.toThrow(/version/)
  definitions.native[0].file='../outside.exe'
  await writeFile(join(root,'release-artifacts.json'),JSON.stringify(definitions))
  await expect(releaseLayout(options)).rejects.toThrow(/filename/)
  definitions.native.shift()
  await writeFile(join(root,'release-artifacts.json'),JSON.stringify(definitions))
  await expect(releaseLayout(options)).rejects.toThrow(/Missing release target/)
})

it('publishes later native updates without replacing the frozen Electron bridge',async()=>{
  const {options} = await fixture()
  await releaseLayout({...options,migration:false})
  const native = JSON.parse(await readFile(join(options.output,'native/latest.json'),'utf8'))
  expect(Object.keys(native.platforms)).toHaveLength(6)
  await expect(readFile(join(options.output,'latest.yml'))).rejects.toMatchObject({code:'ENOENT'})
  await expect(readFile(join(options.output,'bridge/1.19.0/latest.yml'))).rejects.toMatchObject({code:'ENOENT'})
})

it('keeps immutable bridge metadata identical when retrying the same release',async()=>{
  const {root,definitions,options} = await fixture()
  await writeFile(join(root,'release-artifacts.json'),JSON.stringify({...definitions,metadata:{version:'2.0.0',bridgeVersion:'1.19.0',commit:'a'.repeat(40),releaseDate:'2026-11-09T00:00:00.000Z'}}))
  await releaseLayout({...options,now:new Date('2026-11-09T01:00:00Z')})
  const first=await readFile(join(options.output,'bridge/1.19.0/latest.yml'),'utf8')
  await releaseLayout({...options,now:new Date('2026-11-10T01:00:00Z')})
  expect(await readFile(join(options.output,'bridge/1.19.0/latest.yml'),'utf8')).toBe(first)
})

it('includes the package formats selected by real Electron Linux updaters',async()=>{
 const {options}=await fixture()
 await releaseLayout(options)
 const {load}=await import('js-yaml')
 const {findFile}=await import('electron-updater/out/providers/Provider')
 for(const path of ['latest-linux.yml','bridge/1.19.0/latest-linux.yml']) {
  const data=load(await readFile(join(options.output,path),'utf8')) as {files:{url:string;sha512:string;size:number}[]}
  const files=data.files.map(info=>({url:new URL(info.url),info}))
  for(const extension of ['pacman','deb','AppImage'])expect(findFile(files,extension,['rpm'])?.url.pathname.endsWith('.'+extension)).toBe(true)
 }
})
it('rejects an AppImage-only legacy Linux feed before publication',async()=>{
 const {root,definitions,options}=await fixture()
 definitions.bridge=definitions.bridge.filter(file=>!file.file.endsWith('.pacman'))
 await writeFile(join(root,'release-artifacts.json'),JSON.stringify(definitions))
 await expect(releaseLayout(options)).rejects.toThrow('Missing Linux update format: .pacman')
})
