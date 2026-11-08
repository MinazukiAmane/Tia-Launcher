import { build, Platform, Arch } from 'electron-builder'
import { build as bundleScript } from 'esbuild'
import { execFileSync } from 'node:child_process'
import { mkdir, readFile, writeFile, copyFile, readdir, chmod, rm, symlink } from 'node:fs/promises'
import { join, resolve, dirname } from 'node:path'
import { pathToFileURL } from 'node:url'
import { prepareBridgeResources } from './prepare-bridge-resources.mjs'
import { buildWindowsPackage } from './build-windows-package.mjs'
import { buildLinuxPackage } from './build-linux-package.mjs'
import { hashFile } from './release-layout.mjs'

const root = resolve(import.meta.dirname, '../..')
const [version, bridgeVersion, mode = 'migration'] = process.argv.slice(2)
const nativeOnly = mode === 'native'
if (!['native','migration'].includes(mode)) throw new Error('Unknown release mode.')
if (!/^2\.\d+\.\d+$/.test(version) || !/^1\.\d+\.\d+$/.test(bridgeVersion)) throw new Error('Expected stable native 2.x and bridge 1.x versions.')
const platform = process.platform
if (!['win32','linux','darwin'].includes(platform) || process.arch !== 'x64' && platform !== 'darwin') throw new Error('Unsupported release builder.')
for (const name of ['TAURI_SIGNING_PRIVATE_KEY',...(!nativeOnly?['TIA_MIGRATION_SIGNING_KEY']:[])]) if (!process.env[name]) throw new Error(`Missing release secret: ${name}`)
const output = join(root, 'release/candidate'), resources = join(root, 'release/bridge-resources')
await mkdir(output, {recursive:true})
const execute = (program, args, env = {}) => execFileSync(program, args, {cwd:root, stdio:'inherit', env:{...process.env,...env}})
const cli = (...args) => execute(process.execPath, [join(root,'node_modules/@tauri-apps/cli/tauri.js'),...args])
async function find(directory, suffix) {
  const names = (await readdir(directory)).filter(name => name.endsWith(suffix))
  if (names.length !== 1) throw new Error(`Expected one ${suffix} artifact in ${directory}.`)
  return join(directory,names[0])
}
const originals = new Map()
async function replace(path, transform) {
  const original = await readFile(path,'utf8'); originals.set(path,original)
  await writeFile(path,transform(original))
}
const definitions = {native:[],migration:[],bridge:[],downloads:[]}
async function artifact(source, name, targets, bridgeFeed) {
  const file = join(output,name); await copyFile(source,file)
  cli('signer','sign','--app-version',version,file)
  definitions.native.push({file:name,targets,...(bridgeFeed?{bridgeFeed}:{})})
  return file
}
const secret = join(root,'release/.migration-signing.pem')
try {
  if (!nativeOnly) { await writeFile(secret,process.env.TIA_MIGRATION_SIGNING_KEY,{mode:0o600,flag:'wx'}); await chmod(secret,0o600) }
  await replace(join(root,'package.json'),body=>JSON.stringify({...JSON.parse(body),version},null,2)+'\n')
  await replace(join(root,'src-tauri/tauri.conf.json'),body=>JSON.stringify({...JSON.parse(body),version},null,2)+'\n')
  await replace(join(root,'src-tauri/Cargo.toml'),body=>body.replace(/^version = "[^"]+"/m,`version = "${version}"`))
  originals.set(join(root,'src-tauri/Cargo.lock'),await readFile(join(root,'src-tauri/Cargo.lock'),'utf8'))
  const config = ['--config','src-tauri/tauri.production.conf.json']
  let migrationInstaller, helper, platforms, feed, bridgeTargets
  if (platform === 'win32') {
    execute('powershell',['-NoProfile','-File','migration/windows/prepare-webview2.ps1'])
    cli('build','--no-bundle','--ci',...config)
    execute('cargo',['build','--release','--manifest-path','src-tauri/Cargo.toml','--no-default-features','--features','migration-helper','--bin','tia-migration-helper'])
    migrationInstaller = await buildWindowsPackage({binary:join(root,'src-tauri/target/release/tia-launcher.exe'),output:join(root,'release/windows'),version})
    migrationInstaller = await artifact(migrationInstaller,`Tia-Launcher-${version}-win-x64.exe`,['windows-x86_64'],'latest.yml')
    helper = join(root,'src-tauri/target/release/tia-migration-helper.exe')
    platforms = ['windows-x64']; feed = 'latest.yml'; bridgeTargets = Platform.WINDOWS.createTarget('nsis',Arch.x64)
  } else if (platform === 'linux') {
    cli('build','--bundles','appimage,deb','--ci',...config,'--config','src-tauri/tauri.linux.conf.json')
    execute('cargo',['build','--release','--manifest-path','src-tauri/Cargo.toml','--no-default-features','--features','migration-helper','--bin','tia-migration-helper'])
    migrationInstaller = await artifact(await find(join(root,'src-tauri/target/release/bundle/appimage'),'.AppImage'),`Tia-Launcher-${version}-linux-x86_64.AppImage`,['linux-x86_64'],'latest-linux.yml')
    await artifact(await find(join(root,'src-tauri/target/release/bundle/deb'),'.deb'),`Tia-Launcher-${version}-linux-amd64.deb`,['linux-x86_64-deb'])
    await artifact(await buildLinuxPackage({binary:join(root,'src-tauri/target/release/tia-launcher'),output:join(root,'release/linux'),version}),`Tia-Launcher-${version}-linux-x64.pacman`,['linux-x86_64-pacman'])
    helper = join(root,'src-tauri/target/release/tia-migration-helper')
    platforms = ['linux-x64']; feed = 'latest-linux.yml'; bridgeTargets = Platform.LINUX.createTarget('AppImage',Arch.x64)
  } else {
    const official = process.env.TIA_OFFICIAL_MACOS === '1'
    if (official && (!process.env.APPLE_SIGNING_IDENTITY || !process.env.APPLE_API_KEY || !process.env.APPLE_API_KEY_ID || !process.env.APPLE_API_ISSUER)) throw new Error('Official macOS releases require Developer ID and notarization credentials.')
    if (!official) for (const name of ['APPLE_SIGNING_IDENTITY','APPLE_CERTIFICATE','APPLE_CERTIFICATE_PASSWORD','APPLE_API_KEY','APPLE_API_KEY_ID','APPLE_API_ISSUER']) delete process.env[name]
    const identity = official ? process.env.APPLE_SIGNING_IDENTITY : null
    cli('build','--target','universal-apple-darwin','--bundles','app','--ci',...config,'--config','src-tauri/tauri.macos.conf.json','--config',JSON.stringify({bundle:{macOS:{signingIdentity:identity}}}))
    const bundleRoot = join(root,'src-tauri/target/universal-apple-darwin/release/bundle')
    const app = await find(join(bundleRoot,'macos'),'.app')
    if (!official) execute('/usr/bin/codesign',['--force','--deep','--options','runtime','--timestamp=none','--sign','-',app])
    execute('/usr/bin/codesign',['--verify','--deep','--strict',app])
    if (official) { execute('/usr/bin/xcrun',['stapler','validate',app]); execute('/usr/sbin/spctl',['--assess','--type','execute',app]) }
    const dmgStage = join(root,'release/mac-dmg-stage')
    await mkdir(dmgStage,{recursive:true})
    await rm(join(dmgStage,'Tia Launcher.app'),{recursive:true,force:true})
    await rm(join(dmgStage,'Applications'),{force:true})
    execute('/usr/bin/ditto',[app,join(dmgStage,'Tia Launcher.app')])
    await symlink('/Applications',join(dmgStage,'Applications'))
    const dmg = join(output,`Tia-Launcher-${version}-mac-universal.dmg`)
    execute('/usr/bin/hdiutil',['create','-volname','Tia Launcher','-srcfolder',dmgStage,'-fs','HFS+','-format','UDZO','-ov',dmg])
    execute('/usr/bin/codesign',['--force','--sign',official?process.env.APPLE_SIGNING_IDENTITY:'-',...(official?['--timestamp']:['--timestamp=none']),dmg])
    if (official) {
      execute('/usr/bin/xcrun',['notarytool','submit',dmg,'--key',process.env.APPLE_API_KEY,'--key-id',process.env.APPLE_API_KEY_ID,'--issuer',process.env.APPLE_API_ISSUER,'--wait'])
      execute('/usr/bin/xcrun',['stapler','staple',dmg])
      execute('/usr/bin/xcrun',['stapler','validate',dmg])
    }
    execute('/usr/bin/hdiutil',['verify',dmg])
    definitions.downloads.push({file:dmg.split('/').at(-1)})
    const archive = join(output,`Tia-Launcher-${version}-mac-universal.app.tar.gz`)
    execute('/usr/bin/tar',['-czf',archive,'-C',dirname(app),app.split('/').at(-1)])
    cli('signer','sign','--app-version',version,archive)
    definitions.native.push({file:archive.split('/').at(-1),targets:['darwin-x86_64','darwin-aarch64']})
    migrationInstaller = join(output,`Tia-Launcher-${version}-mac-universal.zip`)
    execute('/usr/bin/ditto',['-c','-k','--sequesterRsrc','--keepParent',app,migrationInstaller])
    definitions.migration.push({file:migrationInstaller.split('/').at(-1),bridgeFeed:'latest-mac.yml'})
    for (const target of ['aarch64-apple-darwin','x86_64-apple-darwin']) execute('cargo',['build','--release','--target',target,'--manifest-path','src-tauri/Cargo.toml','--no-default-features','--features','migration-helper','--bin','tia-migration-helper'])
    helper = join(root,'release/tia-migration-helper')
    execute('/usr/bin/lipo',['-create',...['aarch64-apple-darwin','x86_64-apple-darwin'].map(target=>join(root,`src-tauri/target/${target}/release/tia-migration-helper`)),'-output',helper])
    execute('/usr/bin/codesign',['--force','--options','runtime','--sign',official?process.env.APPLE_SIGNING_IDENTITY:'-',helper])
    platforms = ['macos-x64','macos-arm64']; feed = 'latest-mac.yml'; bridgeTargets = Platform.MAC.createTarget(['dmg','zip'],Arch.universal)
  }
  if (!nativeOnly) {
  const pins = JSON.parse(await readFile(join(root,'src/shared/migrationKeys.json'),'utf8'))
  for (const target of platforms) {
    const proof = await prepareBridgeResources({installer:migrationInstaller,helper,keyPath:secret,output:resources,bridgeVersion,targetVersion:version,platform:target})
    if (!pins.some(pin=>pin.id===proof.keyId)) throw new Error('Migration signing key does not match the compiled public pin.')
  }
  const verifierPath = join(root,'release/bridge-verifier.mjs')
  await bundleScript({entryPoints:[join(root,'migration/electron/bridgeRelease.ts')],outfile:verifierPath,bundle:true,platform:'node',format:'esm',target:'node24'})
  const {authenticateRelease,verifyInstaller} = await import(pathToFileURL(verifierPath).href)
  async function verifyPackagedBridge(context) {
    const directory = context.electronPlatformName==='darwin'
      ? join(context.appOutDir,context.packager.appInfo.productFilename+'.app','Contents/Resources/migration')
      : join(context.appOutDir,'resources/migration')
    for (const target of platforms) {
      const signed = JSON.parse(await readFile(join(directory,`release-${target}.json`),'utf8'))
      const proof = authenticateRelease(signed,pins,'com.serenetia.tia-launcher',bridgeVersion,version,target)
      const packagedHelper = join(directory,target==='windows-x64'?'tia-migration-helper.exe':'tia-migration-helper')
      if ((await hashFile(packagedHelper,'sha256','hex')).hash!==proof.helperSha256) throw new Error('Packaging changed the hash-pinned migration helper.')
      await verifyInstaller(migrationInstaller,proof.installerSha512)
    }
  }
  await writeFile(join(root,'package.json'),JSON.stringify({...JSON.parse(originals.get(join(root,'package.json'))),version:bridgeVersion},null,2)+'\n')
  if (platform==='darwin') execute(process.execPath,['migration/installer/prepare-macos-bindings.mjs'])
  execute(process.execPath,[join(root,'node_modules/electron-vite/bin/electron-vite.js'),'build'])
  const builder = {
    extends:join(root,'electron-builder.yml'),
    directories:{output:join(root,'release/bridge')},
    afterPack:verifyPackagedBridge,
    afterSign:verifyPackagedBridge,
    disableSanityCheckAsar:false,
    extraMetadata:{version:bridgeVersion,main:'./out/main/index.js',author:{name:'Serenetia',email:'amane@serenetia.com'}},
    extraResources:[
      {from:'build/licenses/Orbitron-OFL.txt',to:'licenses/Orbitron-OFL.txt'},
      {from:'build/native',to:'client-runtime',filter:['csore-start-*.exe']},
      {from:'build/native/cedar',to:'game-runtime',filter:['cedar-start-x64.exe','cedar-client-x64.dll','launcher-services.json','LICENSE-Minhook.txt']},
      {from:'build/icon.png',to:'icon.png'},
      {from:join(resources,'resources/migration'),to:'migration'}
    ],
    artifactName:`Tia-Launcher-${bridgeVersion}-${platform === 'win32'?'win-x64.exe':platform === 'linux'?'linux-x86_64.AppImage':'mac-universal.${ext}'}`,
    publish:{provider:'generic',url:`https://tia-launcher.serenetia.com/api/updates/bridge/${bridgeVersion}`},
    ...(platform==='darwin'?{mac:{identity:process.env.TIA_OFFICIAL_MACOS==='1'?process.env.APPLE_SIGNING_IDENTITY:null,signIgnore:['Contents/Resources/migration/tia-migration-helper'],x64ArchFiles:'**/@bsdiff-rust/node-darwin-*/**',singleArchFiles:'**/@bsdiff-rust/node-darwin-*/**'}}:{})
  }
  await build({config:builder,targets:bridgeTargets,publish:'never'})
  const suffix = platform==='win32'?'.exe':platform==='linux'?'.AppImage':'.zip'
  const bridge = await find(join(root,'release/bridge'),suffix)
  const name = bridge.split(/[\\/]/).at(-1)
  await copyFile(bridge,join(output,name)); definitions.bridge.push({file:name,feed})
  }
  await writeFile(join(output,`artifacts-${platform}.json`),JSON.stringify(definitions,null,2)+'\n')
  console.log(`Built native ${version} and Electron bridge ${bridgeVersion} for ${platform}.`)
} finally {
  await rm(secret,{force:true})
  for (const [path,body] of originals) await writeFile(path,body)
}
