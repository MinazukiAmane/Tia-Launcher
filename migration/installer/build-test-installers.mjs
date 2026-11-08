import { build as bundle } from 'esbuild'
import { build, Platform, Arch } from 'electron-builder'
import { createPackage } from '@electron/asar'
import { UUID } from 'builder-util-runtime'
import { readFile, writeFile, mkdir, cp, copyFile, readdir } from 'node:fs/promises'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { resolve, join, dirname } from 'node:path'
import { execFileSync } from 'node:child_process'

const root=resolve(import.meta.dirname,'../..')
const output=join(root,'release-test/framework-migration')
const identity=JSON.parse(await readFile(join(root,'migration/installer/identity.json'),'utf8')).test
const guid=UUID.v5(identity.appId,UUID.parse('50e065bc-3134-11e6-9bab-38c9862bdaf3'))
const native=join(root,'src-tauri/target/x86_64-pc-windows-gnu/debug/tia-launcher.exe')
const helper=join(root,'src-tauri/target/x86_64-pc-windows-gnu/debug/tia-migration-helper.exe')
const runtime=resolve(process.argv.slice(2).find(arg=>!arg.startsWith('--'))??join(root,'../CSORE-Launcher/release/win-unpacked'))
const bridgeVersion='1.99.0'
const targetVersion='2.0.0-alpha.1'
await mkdir(output,{recursive:true})
await readFile(native);await readFile(helper)
const configPath=join(output,'builder.json')
const nativeStage=join(output,'native-stage');await mkdir(join(nativeStage,'resources'),{recursive:true})
await copyFile(native,join(nativeStage,identity.productName+'.exe'))
await copyFile(join(dirname(native),'WebView2Loader.dll'),join(nativeStage,'WebView2Loader.dll'))
await mkdir(join(nativeStage,'licenses'),{recursive:true})
await copyFile(join(root,'build/licenses/Orbitron-OFL.txt'),join(nativeStage,'licenses/Orbitron-OFL.txt'))
await mkdir(join(nativeStage,'client-runtime'),{recursive:true})
for (const name of ['csore-start-x86.exe','csore-start-x64.exe']) await copyFile(join(root,'build/native',name),join(nativeStage,'client-runtime',name))
await mkdir(join(nativeStage,'game-runtime'),{recursive:true})
for (const name of ['cedar-start-x64.exe','cedar-client-x64.dll','launcher-services.json','LICENSE-Minhook.txt']) await copyFile(join(root,'build/native/cedar',name),join(nativeStage,'game-runtime',name))
if(process.platform==='linux')execFileSync('objcopy',['--strip-debug',join(nativeStage,identity.productName+'.exe')])

async function installer(stage,version,label) {
 const config={appId:identity.appId,productName:identity.productName,extraMetadata:{name:'tia-migration-test',version},directories:{output:join(output,label),buildResources:join(root,'build')},artifactName:`Tia-Migration-Test-${label}.exe`,electronVersion:'44.10.2',win:{target:'nsis',signAndEditExecutable:false},nsis:{...(label==='native'?{include:join(root,'build-scripts/install-scope.nsh')}:{ }),guid,oneClick:false,perMachine:false,selectPerMachineByDefault:true,allowToChangeInstallationDirectory:true,createDesktopShortcut:'always',createStartMenuShortcut:true,deleteAppDataOnUninstall:false,runAfterFinish:false},publish:{provider:'generic',url:'http://127.0.0.1:18479',channel:'latest'}}
 await writeFile(configPath,JSON.stringify(config,null,2))
 await build({config:configPath,targets:Platform.WINDOWS.createTarget('nsis',Arch.x64),prepackaged:stage,publish:'never'})
 return join(output,label,`Tia-Migration-Test-${label}.exe`)
}
const nativeInstaller=process.argv.includes('--reuse-native')?join(output,'native/Tia-Migration-Test-native.exe'):await installer(nativeStage,targetVersion,'native')
const pair=generateKeyPairSync('ed25519')
const publicKey=pair.publicKey.export({type:'spki',format:'pem'}).toString()
const keyId=createHash('sha256').update(pair.publicKey.export({type:'spki',format:'der'})).digest('hex')
const body=JSON.stringify({protocol:1,appId:identity.appId,bridgeVersion,targetVersion,platform:'windows-x64',installerSha512:createHash('sha512').update(await readFile(nativeInstaller)).digest('base64'),helperSha256:createHash('sha256').update(await readFile(helper)).digest('hex')})
const signed={body,keyId,signature:sign(null,Buffer.from('Tia launcher framework migration v1\0'+body),pair.privateKey).toString('base64')}
const stage=join(output,'bridge-stage');await mkdir(join(stage,'resources/migration'),{recursive:true})
for(const item of await readdir(runtime,{withFileTypes:true})) {
 if(!item.isFile()||item.name.startsWith('Uninstall'))continue
 await copyFile(join(runtime,item.name),join(stage,item.name==='Tia Launcher.exe'?identity.productName+'.exe':item.name))
}
await cp(join(runtime,'locales'),join(stage,'locales'),{recursive:true})
await copyFile(helper,join(stage,'resources/migration/tia-migration-helper.exe'))
await copyFile(join(runtime,'resources/elevate.exe'),join(stage,'resources/elevate.exe'))
await writeFile(join(stage,'resources/migration/release.json'),JSON.stringify(signed))
await writeFile(join(stage,'resources/migration/test-configuration.json'),JSON.stringify({appId:identity.appId,guid,keys:[{id:keyId,publicKey}],targetVersion,feed:'http://127.0.0.1:18479'}))
await writeFile(join(stage,'resources/app-update.yml'),'provider: generic\nurl: http://127.0.0.1:18479\nupdaterCacheDirName: tia-migration-test-updater\n')
const application=join(output,'bridge-app');await mkdir(application,{recursive:true})
await bundle({entryPoints:[join(root,'migration/windows/bridge-fixture.ts')],outfile:join(application,'index.cjs'),platform:'node',target:'node22',format:'cjs',bundle:true,external:['electron']})
await writeFile(join(application,'package.json'),JSON.stringify({name:'tia-migration-test',productName:identity.productName,version:bridgeVersion,main:'index.cjs'}))
await createPackage(application,join(stage,'resources/app.asar'))
const bridgeInstaller=await installer(stage,bridgeVersion,'bridge')
await writeFile(join(output,'test-plan.json'),JSON.stringify({appId:identity.appId,guid,bridgeVersion,targetVersion,bridgeInstaller,nativeInstaller},null,2))
console.log(JSON.stringify({bridgeInstaller,nativeInstaller,guid}))
