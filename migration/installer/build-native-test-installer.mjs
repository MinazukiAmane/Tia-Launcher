import { build, Platform, Arch } from 'electron-builder'
import { UUID } from 'builder-util-runtime'
import { mkdir, copyFile, writeFile } from 'node:fs/promises'
import { resolve, join, dirname } from 'node:path'
import { execFileSync } from 'node:child_process'

const root=resolve(import.meta.dirname,'../..')
const version=process.argv[2]??'2.0.0-alpha.1'
const label=process.argv[3]??'baseline'
if(!/^2\.0\.0-alpha\.\d+$/.test(version)||!['baseline','update'].includes(label))throw new Error('Expected a test prerelease version and baseline/update label')
const output=join(root,'release-test/native-updater',label)
const stage=join(output,'stage');await mkdir(join(stage,'resources'),{recursive:true})
const executable=resolve(process.argv[4]??join(root,'src-tauri/target/x86_64-pc-windows-gnu/debug/tia-launcher.exe'))
await copyFile(executable,join(stage,'Tia Migration Test.exe'))
await copyFile(join(dirname(executable),'WebView2Loader.dll'),join(stage,'WebView2Loader.dll'))
await mkdir(join(stage,'licenses'),{recursive:true})
await copyFile(join(root,'build/licenses/Orbitron-OFL.txt'),join(stage,'licenses/Orbitron-OFL.txt'))
await mkdir(join(stage,'client-runtime'),{recursive:true})
for(const name of ['csore-start-x86.exe','csore-start-x64.exe'])await copyFile(join(root,'build/native',name),join(stage,'client-runtime',name))
await mkdir(join(stage,'game-runtime'),{recursive:true})
for(const name of ['cedar-start-x64.exe','cedar-client-x64.dll','launcher-services.json','LICENSE-Minhook.txt'])await copyFile(join(root,'build/native/cedar',name),join(stage,'game-runtime',name))
if(process.platform==='linux')execFileSync('objcopy',['--strip-debug',join(stage,'Tia Migration Test.exe')])
const appId='com.serenetia.tia-launcher.migration-test'
const guid=UUID.v5(appId,UUID.parse('50e065bc-3134-11e6-9bab-38c9862bdaf3'))
const config={appId,productName:'Tia Migration Test',extraMetadata:{name:'tia-migration-test',version},directories:{output,buildResources:join(root,'build')},artifactName:`Tia-Native-${label}.exe`,electronVersion:'44.10.2',win:{target:'nsis',signAndEditExecutable:false},nsis:{include:join(root,'build-scripts/install-scope.nsh'),guid,oneClick:false,perMachine:false,selectPerMachineByDefault:true,allowToChangeInstallationDirectory:true,createDesktopShortcut:'always',createStartMenuShortcut:true,deleteAppDataOnUninstall:false,runAfterFinish:false},publish:null}
const file=join(output,'builder.json');await writeFile(file,JSON.stringify(config,null,2))
await build({config:file,targets:Platform.WINDOWS.createTarget('nsis',Arch.x64),prepackaged:stage,publish:'never'})
console.log(JSON.stringify({installer:join(output,`Tia-Native-${label}.exe`),version,guid}))
