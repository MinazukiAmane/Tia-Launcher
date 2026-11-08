import { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { resolve, join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { gzipSync } from 'node:zlib'

const root=resolve(import.meta.dirname,'../..')
const assets=[['client-runtime/csore-start-x86.exe','build/native/csore-start-x86.exe'],['client-runtime/csore-start-x64.exe','build/native/csore-start-x64.exe'],...['cedar-start-x64.exe','cedar-client-x64.dll','launcher-services.json','LICENSE-Minhook.txt'].map(name=>['game-runtime/'+name,'build/native/cedar/'+name]),['licenses/Orbitron-OFL.txt','build/licenses/Orbitron-OFL.txt']]
export async function stageLinuxPackage({binary,directory,version,kind='pacman',strip=true}) {
 if(!/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.]+)?(?:\+[A-Za-z0-9.]+)?$/.test(version)||!['pacman','nix'].includes(kind))throw new Error('Invalid native Linux package configuration.')
 const resources=join(directory,'usr/lib/Tia Launcher')
 await mkdir(join(directory,'usr/bin'),{recursive:true})
 await copyFile(resolve(binary),join(directory,'usr/bin/tia-launcher'))
 await chmod(join(directory,'usr/bin/tia-launcher'),0o755)
 if(strip)execFileSync('strip',['--strip-debug',join(directory,'usr/bin/tia-launcher')])
 for(const [destination,source]of assets){const path=join(resources,destination);await mkdir(dirname(path),{recursive:true});await copyFile(join(root,source),path)}
 await writeFile(join(resources,'package-type'),kind+'\n')
 await mkdir(join(directory,'usr/share/applications'),{recursive:true})
 await writeFile(join(directory,'usr/share/applications/tia-launcher.desktop'),'[Desktop Entry]\nType=Application\nName=Tia Launcher\nComment=Tia game library\nExec=tia-launcher\nIcon=tia-launcher\nTerminal=false\nCategories=Game;\nStartupWMClass=tia-launcher\n')
 const icon=join(directory,'usr/share/icons/hicolor/512x512/apps/tia-launcher.png')
 await mkdir(dirname(icon),{recursive:true});await copyFile(join(root,'build/icon.png'),icon)
 return directory
}
async function size(path){const entry=await stat(path);if(!entry.isDirectory())return entry.size;let total=0;for(const name of await readdir(path))total+=await size(join(path,name));return total}
export async function buildLinuxPackage({binary,output,version,arch=process.arch,strip=true,kind='pacman'}) {
 if(!['x64','arm64'].includes(arch))throw new Error('Unsupported Linux package architecture.')
 await mkdir(resolve(output),{recursive:true})
 const temporary=await mkdtemp(join(resolve(output),'.package-'))
 try {
  await stageLinuxPackage({binary,directory:temporary,version,kind,strip})
  if(kind==='nix'){
   const path=join(resolve(output),`Tia-Launcher-${version}-linux-${arch}.tar.gz`)
   execFileSync('tar',['--sort=name','--numeric-owner','--owner=0','--group=0','-czf',path,'-C',temporary,'usr'])
   return path
  }
  const architecture=arch==='x64'?'x86_64':'aarch64'
  const info=[`pkgname = tia-launcher`,`pkgbase = tia-launcher`,`pkgver = ${version.replace(/[-+]/g,'_')}-1`,`pkgdesc = Tia game library`,`url = https://tia-launcher.serenetia.com`,`builddate = ${Math.floor(Date.now()/1000)}`,`packager = Serenetia`,`size = ${await size(temporary)}`,`arch = ${architecture}`,`license = custom`,...['webkit2gtk-4.1','gtk3','libayatana-appindicator','gst-plugins-base','gst-plugins-good','gst-plugins-bad','gst-libav','python'].map(dependency=>'depend = '+dependency)].join('\n')+'\n'
  await writeFile(join(temporary,'.PKGINFO'),info)
  const tree=execFileSync('bsdtar',['--format=mtree','--options=!all,use-set,type,uid,gid,mode,time,size,sha256,link','--uid','0','--gid','0','-cf','-','.PKGINFO','usr'],{cwd:temporary,maxBuffer:16*1024*1024})
  await writeFile(join(temporary,'.MTREE'),gzipSync(tree))
  const path=join(resolve(output),`Tia-Launcher-${version}-linux-${arch}.pacman`)
  execFileSync('tar',['--zstd','--sort=name','--numeric-owner','--owner=0','--group=0','-cf',path,'-C',temporary,'.PKGINFO','.MTREE','usr'])
  return path
 } finally {await rm(temporary,{recursive:true,force:true})}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const options={binary:process.argv[2]??join(root,'src-tauri/target/release/tia-launcher'),output:process.argv[3]??join(root,'release/native'),version:JSON.parse(await readFile(join(root,'package.json'),'utf8')).version,kind:process.argv[4]??'pacman'}
 console.log(await buildLinuxPackage(options))
}
