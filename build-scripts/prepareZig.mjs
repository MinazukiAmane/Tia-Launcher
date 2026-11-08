import {appendFile,mkdir,mkdtemp,readFile} from 'node:fs/promises'
import {createWriteStream} from 'node:fs'
import {createHash} from 'node:crypto'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'
import {Readable,Transform} from 'node:stream'
import {pipeline} from 'node:stream/promises'
import {execFileSync} from 'node:child_process'
const configuration=JSON.parse(await readFile(new URL('./zig-toolchains.json',import.meta.url),'utf8'))
const arch={x64:'x86_64',arm64:'aarch64'}[process.arch]
const platform={linux:'linux',win32:'windows',darwin:'macos'}[process.platform]
const artifact=configuration.platforms[`${arch}-${platform}`]
if(!artifact||!/^https:\/\/ziglang\.org\//.test(artifact.url)||!/^[a-f0-9]{64}$/.test(artifact.sha256))throw new Error('Unsupported or invalid Zig toolchain.')
const directory=await mkdtemp(join(process.env.RUNNER_TEMP??tmpdir(),'tia-zig-'))
const archive=join(directory,artifact.url.endsWith('.zip')?'zig.zip':'zig.tar.xz'),installed=join(directory,'toolchain')
const response=await fetch(artifact.url,{signal:AbortSignal.timeout(120_000)})
if(!response.ok||!response.body)throw new Error('The Zig toolchain could not be downloaded.')
const hash=createHash('sha256')
await pipeline(Readable.fromWeb(response.body),new Transform({transform(chunk,_encoding,done){hash.update(chunk);done(null,chunk)}}),createWriteStream(archive,{flags:'wx'}))
if(hash.digest('hex')!==artifact.sha256)throw new Error('The Zig toolchain checksum is invalid.')
await mkdir(installed)
execFileSync('tar',['-xf',archive,'-C',installed,'--strip-components=1'])
const executable=join(installed,process.platform==='win32'?'zig.exe':'zig')
if(execFileSync(executable,['version'],{encoding:'utf8'}).trim()!==configuration.version)throw new Error('The Zig compiler version is invalid.')
if(process.env.GITHUB_PATH)await appendFile(process.env.GITHUB_PATH,resolve(installed)+'\n')
console.log(`Verified Zig ${configuration.version} for ${arch}-${platform}.`)
