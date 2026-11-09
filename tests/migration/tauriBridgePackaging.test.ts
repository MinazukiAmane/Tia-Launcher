import { it, expect } from 'vitest'
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { generateKeyPairSync } from 'node:crypto'
import { authenticateRelease } from '../../migration/electron/bridgeRelease'

it('prepares signed bridge resources while keeping the signing key out of the artifact', async () => {
 const root=await mkdtemp(join(tmpdir(),'tia-bridge-package-'))
 try {
  const { prepareBridgeResources }=await import('../../migration/installer/prepare-bridge-resources.mjs')
  const key=generateKeyPairSync('ed25519').privateKey.export({type:'pkcs8',format:'pem'})
  const keyPath=join(root,'signing.key');await writeFile(keyPath,key,{mode:0o600})
  const helper=join(root,'helper.exe');await writeFile(helper,'native-test-helper')
  const installer=join(root,'installer.exe');await writeFile(installer,'test-installer')
  const output=join(root,'output')
  await prepareBridgeResources({installer,helper,keyPath,output,bridgeVersion:'1.99.0',targetVersion:'2.0.0'})
  const keys=JSON.parse(await readFile(join(output,'migrationKeys.json'),'utf8'))
  const proof=JSON.parse(await readFile(join(output,'resources/migration/release.json'),'utf8'))
  expect(authenticateRelease(proof,keys,'com.serenetia.tia-launcher','1.99.0','2.0.0').targetVersion).toBe('2.0.0')
  expect(JSON.stringify(keys)+JSON.stringify(proof)).not.toContain('PRIVATE KEY')
  expect(await readFile(join(output,'resources/migration/tia-migration-helper.exe'),'utf8')).toBe('native-test-helper')
  await expect(prepareBridgeResources({installer,helper,keyPath,output,bridgeVersion:'2.0.0',targetVersion:'1.99.0'})).rejects.toThrow(/Expected/)
 }finally{await rm(root,{recursive:true,force:true})}
})

it('packages a platform-bound Unix helper with executable permissions', async () => {
 const root=await mkdtemp(join(tmpdir(),'tia-bridge-unix-'))
 try {
  const { prepareBridgeResources }=await import('../../migration/installer/prepare-bridge-resources.mjs')
  const key=generateKeyPairSync('ed25519').privateKey.export({type:'pkcs8',format:'pem'})
  const keyPath=join(root,'signing.key');await writeFile(keyPath,key,{mode:0o600})
  const helper=join(root,'native-helper');await writeFile(helper,'native-test-helper')
  const installer=join(root,'update.zip');await writeFile(installer,'test-mac-update')
  const output=join(root,'output')
  await prepareBridgeResources({installer,helper,keyPath,output,bridgeVersion:'1.99.0',targetVersion:'2.0.0',platform:'macos-arm64'})
  const keys=JSON.parse(await readFile(join(output,'migrationKeys.json'),'utf8'))
  const proof=JSON.parse(await readFile(join(output,'resources/migration/release.json'),'utf8'))
  expect(authenticateRelease(proof,keys,'com.serenetia.tia-launcher','1.99.0','2.0.0','macos-arm64').platform).toBe('macos-arm64')
  expect(()=>authenticateRelease(proof,keys,'com.serenetia.tia-launcher','1.99.0','2.0.0','macos-x64')).toThrow(/does not match/)
  expect(()=>authenticateRelease(proof,keys,'com.serenetia.tia-launcher','1.99.0','2.0.0')).toThrow(/does not match/)
  expect(await readFile(join(output,'resources/migration/tia-migration-helper'),'utf8')).toBe('native-test-helper')
  if(process.platform!=='win32')await expect((await import('node:fs/promises')).stat(join(output,'resources/migration/tia-migration-helper')).then(info=>info.mode&0o111)).resolves.toBe(0o111)
 }finally{await rm(root,{recursive:true,force:true})}
})
