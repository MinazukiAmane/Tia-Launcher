import { createHash, createPrivateKey, createPublicKey, sign } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, readFile, mkdir, writeFile, copyFile, chmod } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'

async function digest(path, algorithm, encoding) {
 const info=await lstat(path)
 if(!info.isFile()||info.isSymbolicLink())throw new Error('Release inputs must be regular files.')
 const hash=createHash(algorithm)
 for await(const chunk of createReadStream(path))hash.update(chunk)
 return hash.digest(encoding)
}
export async function prepareBridgeResources({installer,helper,keyPath,output,bridgeVersion,targetVersion,platform='windows-x64'}) {
 if(!/^1\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(bridgeVersion)||!/^2\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[A-Za-z0-9.-]+)?$/.test(targetVersion))throw new Error('Expected a stable Electron 1.x bridge and a Tauri 2.x target.')
 if(!['windows-x64','linux-x64','linux-arm64','macos-x64','macos-arm64'].includes(platform))throw new Error('Unsupported migration platform.')
 const keyInfo=await lstat(keyPath)
 if(!keyInfo.isFile()||keyInfo.isSymbolicLink()||keyInfo.size>16384||(process.platform!=='win32'&&(keyInfo.mode&0o077)!==0))throw new Error('The release signing key must be a private, regular file.')
 const raw=await readFile(keyPath)
 let privateKey
 try{privateKey=createPrivateKey(raw)}finally{raw.fill(0)}
 if(privateKey.asymmetricKeyType!=='ed25519')throw new Error('An Ed25519 signing key is required.')
 const publicKey=createPublicKey(privateKey)
 const keyId=createHash('sha256').update(publicKey.export({type:'spki',format:'der'})).digest('hex')
 const identity=JSON.parse(await readFile(new URL('./identity.json',import.meta.url),'utf8')).production
 const body=JSON.stringify({protocol:1,appId:identity.appId,bridgeVersion,targetVersion,platform,installerSha512:await digest(installer,'sha512','base64'),helperSha256:await digest(helper,'sha256','hex')})
 const signed={body,keyId,signature:sign(null,Buffer.from('Tia launcher framework migration v1\0'+body),privateKey).toString('base64')}
 const directory=resolve(output)
 await mkdir(join(directory,'resources/migration'),{recursive:true})
 const helperName=platform==='windows-x64'?'tia-migration-helper.exe':'tia-migration-helper'
 const helperPath=join(directory,'resources/migration',helperName)
 await copyFile(helper,helperPath)
 if(process.platform!=='win32')await chmod(helperPath,0o755)
 await writeFile(join(directory,'resources/migration/release.json'),JSON.stringify(signed))
 await writeFile(join(directory,`resources/migration/release-${platform}.json`),JSON.stringify(signed))
 await writeFile(join(directory,'migrationKeys.json'),JSON.stringify([{id:keyId,publicKey:publicKey.export({type:'spki',format:'pem'}).toString()}],null,2)+'\n')
 return {keyId,output:directory}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
 try {
  const args=process.argv.slice(2)
  const options={}
  const names={installer:'installer',helper:'helper',key:'keyPath',out:'output','bridge-version':'bridgeVersion','target-version':'targetVersion',platform:'platform'}
  for(let index=0;index<args.length;index+=2){const name=names[args[index]?.replace(/^--/,'')];if(!name||!args[index+1])throw new Error('Expected --installer, --helper, --key, --out, --bridge-version and --target-version.');options[name]=args[index+1]}
  if(['installer','helper','keyPath','output','bridgeVersion','targetVersion'].some(name=>!options[name]))throw new Error('All six release arguments are required.')
  console.log(JSON.stringify(await prepareBridgeResources(options)))
 }catch(error){console.error(error.message);process.exitCode=1}
}
