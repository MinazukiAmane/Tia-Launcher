import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod,lstat,mkdtemp,readFile,rm } from 'node:fs/promises'
import { join,resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
const directory=resolve(process.argv[2])
const definition=JSON.parse(await readFile(join(directory,'artifacts-linux.json'),'utf8'))
const pins=JSON.parse(await readFile('src/shared/migrationKeys.json','utf8'))
const {authenticateRelease}=await import(pathToFileURL(resolve('release/bridge-verifier.mjs')).href)
for(const kind of ['AppImage','deb','pacman']) {
 const entries=definition.bridge.filter(a=>a.file.endsWith('.'+kind))
 if(entries.length!==1)throw new Error(`Expected one ${kind} bridge.`)
 const path=join(directory,entries[0].file),temporary=await mkdtemp(resolve('release/.bridge-check-'))
 try {
  let resources
  if(kind==='AppImage') {
   await chmod(path,0o755)
   execFileSync(path,['--appimage-extract'],{cwd:temporary,stdio:'ignore'})
   resources=join(temporary,'squashfs-root/resources')
  } else {
   if(kind==='deb') {
    const name=execFileSync('dpkg-deb',['-f',path,'Package'],{encoding:'utf8'}).trim()
    if(name!=='tia-launcher')throw new Error('The bridge would install a second launcher package.')
    execFileSync('dpkg-deb',['-x',path,temporary])
   } else {
    const info=execFileSync('bsdtar',['-xOf',path,'.PKGINFO'],{encoding:'utf8'})
    if(!/^pkgname = tia-launcher$/m.test(info))throw new Error('The bridge would install a second launcher package.')
    execFileSync('bsdtar',['-xf',path,'-C',temporary])
   }
   resources=join(temporary,'opt/Tia Launcher/resources')
   if((await readFile(join(resources,'package-type'),'utf8')).trim()!==kind)throw new Error('The packaged updater would select the wrong package format.')
  }
  const helper=join(resources,'migration/tia-migration-helper')
  if(!(await lstat(helper)).isFile()||!((await lstat(helper)).mode&0o111))throw new Error('The migration helper is not executable.')
  const helperHash=createHash('sha256').update(await readFile(helper)).digest('hex')
  const packageType=kind==='AppImage'?'':`-${kind}`
  const signed=JSON.parse(await readFile(join(resources,`migration/release-linux-x64${packageType}.json`),'utf8'))
  const proof=authenticateRelease(signed,pins,'com.serenetia.tia-launcher',definition.metadata.bridgeVersion,definition.metadata.version,'linux-x64')
  if(proof.helperSha256!==helperHash)throw new Error('The packaged migration helper hash changed.')
  const native=definition.native.find(a=>a.file.endsWith('.'+kind))
  execFileSync(helper,['--bridge-operation-stdin'],{input:JSON.stringify({operation:'verify-installer',path:join(directory,native.file),sha512:proof.installerSha512}),stdio:['pipe','pipe','pipe'],timeout:300000})
  console.log(`Verified real ${kind} bridge package and signed native handoff.`)
 } finally {await rm(temporary,{recursive:true,force:true})}
}
