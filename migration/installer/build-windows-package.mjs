import {build,Platform,Arch} from 'electron-builder'
import {copyFile,mkdir,mkdtemp,readdir,readFile,rm,stat,writeFile} from 'node:fs/promises'
import {resolve,join,dirname} from 'node:path'
import {fileURLToPath} from 'node:url'
import {UUID} from 'builder-util-runtime'
const root=resolve(import.meta.dirname,'../..')
async function findLoader(directory){
 const direct=join(directory,'WebView2Loader.dll');try{await stat(direct);return direct}catch{}
 for(const name of await readdir(join(directory,'build'))){
  if(!name.startsWith('webview2-com-sys-'))continue
  const path=join(directory,'build',name,'out/x64/WebView2Loader.dll');try{await stat(path);return path}catch{}
 }
 throw new Error('WebView2Loader.dll is missing from the Windows build.')
}
export async function buildWindowsPackage({binary,output,version,flavor='production'}){
 if(!/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.]+)?$/.test(version))throw new Error('Invalid Windows release version.')
 if(!['production','test'].includes(flavor))throw new Error('Invalid Windows package identity.')
 const identity=JSON.parse(await readFile(join(root,'migration/installer/identity.json'),'utf8'))[flavor]
 const guid=identity.guid??UUID.v5(identity.appId,UUID.parse('50e065bc-3134-11e6-9bab-38c9862bdaf3'))
 const artifactName=flavor==='test'?`Tia-Migration-Test-${version}-win-x64.exe`:`Tia-Launcher-${version}-win-x64.exe`
 output=resolve(output);await mkdir(output,{recursive:true})
 const temporary=await mkdtemp(join(output,'.windows-')),stage=join(temporary,'stage')
 await mkdir(stage,{recursive:true})
 await mkdir(join(stage,'resources'),{recursive:true})
 try{
  const bootstrap=join(root,'build/webview2/MicrosoftEdgeWebview2Setup.exe');await stat(bootstrap)
  await copyFile(resolve(binary),join(stage,identity.productName+'.exe'))
  await copyFile(await findLoader(dirname(resolve(binary))),join(stage,'WebView2Loader.dll'))
  for(const [source,destination]of [['build/native/csore-start-x86.exe','client-runtime/csore-start-x86.exe'],['build/native/csore-start-x64.exe','client-runtime/csore-start-x64.exe'],...['cedar-start-x64.exe','cedar-client-x64.dll','launcher-services.json','LICENSE-Minhook.txt'].map(name=>['build/native/cedar/'+name,'game-runtime/'+name]),['build/licenses/Orbitron-OFL.txt','licenses/Orbitron-OFL.txt']]){
   await mkdir(dirname(join(stage,destination)),{recursive:true});await copyFile(join(root,source),join(stage,destination))
  }
  const escape=value=>value.replaceAll('$','$$').replaceAll('"','$\\"')
  const include=join(temporary,'installer.nsh')
  await writeFile(include,`!define TIA_WEBVIEW2_SETUP "${escape(bootstrap)}"\n!include "${escape(join(root,'build-scripts/install-scope.nsh'))}"\n`)
  const config={appId:identity.appId,productName:identity.productName,extraMetadata:{name:flavor==='test'?'tia-migration-test':'tia-launcher',version},directories:{output,buildResources:join(root,'build')},artifactName,electronVersion:'44.10.2',win:{target:'nsis',signAndEditExecutable:false},nsis:{include,guid,oneClick:false,perMachine:false,selectPerMachineByDefault:true,allowToChangeInstallationDirectory:true,createDesktopShortcut:'always',createStartMenuShortcut:true,deleteAppDataOnUninstall:false,runAfterFinish:flavor==='production'},publish:null}
  await build({config,targets:Platform.WINDOWS.createTarget('nsis',Arch.x64),prepackaged:stage,publish:'never'})
  return join(output,artifactName)
 }finally{await rm(temporary,{recursive:true,force:true})}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))console.log(await buildWindowsPackage({binary:process.argv[2]??join(root,'src-tauri/target/release/tia-launcher.exe'),output:process.argv[3]??join(root,'release/native'),version:process.argv[4]??JSON.parse(await readFile(join(root,'package.json'),'utf8')).version,flavor:process.argv[5]==='--test'?'test':'production'}))
