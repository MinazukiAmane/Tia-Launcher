import { copyFile,mkdir,readFile,writeFile } from 'node:fs/promises'
import { join,resolve,basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { hashFile,requireLinuxFormats,updaterFeed } from './release-layout.mjs'
export async function linuxBridgeLayout(input,output,liveManifest) {
 const definition=JSON.parse(await readFile(join(input,'artifacts-linux.json'),'utf8'))
 const {version,bridgeVersion,releaseDate}=definition.metadata
 if(!/^2\.\d+\.\d+$/.test(version)||!/^1\.\d+\.\d+$/.test(bridgeVersion))throw new Error('Invalid bridge versions.')
 const raw=await readFile(liveManifest,'utf8'),live=JSON.parse(raw)
 if(live.version!==version)throw new Error('Bridge target does not match the current native release.')
 const base='https://tia-launcher.serenetia.com/api/updates',legacy=[],native=[],sums=[]
 const now=new Date(releaseDate)
 if(!Number.isFinite(now.getTime()))throw new Error('Missing deterministic release date.')
 await mkdir(join(output,'bridge',bridgeVersion),{recursive:true})
 for(const artifact of definition.bridge) {
  if(artifact.feed!=='latest-linux.yml'||basename(artifact.file)!==artifact.file||!/^Tia-Launcher-[A-Za-z0-9._-]+$/.test(artifact.file))throw new Error('Unexpected bridge artifact.')
  const source=join(input,artifact.file),metadata=await hashFile(source)
  await copyFile(source,join(output,artifact.file))
  legacy.push({url:`${base}/${artifact.file}`,sha512:metadata.hash,size:metadata.size})
  sums.push(`${(await hashFile(source,'sha256','hex')).hash}  ${artifact.file}`)
 }
 for(const target of ['linux-x86_64','linux-x86_64-deb','linux-x86_64-pacman']) {
  const entry=live.platforms[target],artifact=definition.native.find(a=>a.targets.includes(target))
  if(!artifact||entry.url!==`${base}/native/${version}/${artifact.file}`||!entry.signature)throw new Error('Native bridge package does not match the live release.')
  const metadata=await hashFile(join(input,artifact.file))
  native.push({url:entry.url,sha512:metadata.hash,size:metadata.size})
 }
 requireLinuxFormats(legacy);requireLinuxFormats(native)
 await writeFile(join(output,'latest-linux.yml'),updaterFeed(bridgeVersion,legacy,now))
 await writeFile(join(output,'bridge',bridgeVersion,'latest-linux.yml'),updaterFeed(version,native,now))
 await writeFile(join(output,'bridge',bridgeVersion,'SHA256SUMS'),sums.sort().join('\n')+'\n')
 await mkdir(join(output,'native'),{recursive:true})
 await writeFile(join(output,'native/latest.json'),raw)
 console.log(`Prepared Linux bridge ${bridgeVersion} with AppImage, deb and pacman continuity to ${version}.`)
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))await linuxBridgeLayout(...process.argv.slice(2))
