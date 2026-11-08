import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { constants, createWriteStream } from 'node:fs'
import { access, chmod, copyFile, lstat, mkdir, mkdtemp, realpath, rename, rm } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { pipeline } from 'node:stream/promises'
import * as yauzl from 'yauzl'
import { verifyInstaller } from './bridgeRelease'

export interface BundleIdentity { id: string; executable: string; version: string }
export interface MacContext { bundle: string; device: number; inode: number; id: string }
type ReadIdentity = (bundle: string) => Promise<BundleIdentity>
const execute = promisify(execFile)
export async function readBundleIdentity(bundle: string): Promise<BundleIdentity> {
  const plist = join(bundle, 'Contents/Info.plist')
  const read = async (field: string): Promise<string> => (await execute('/usr/bin/plutil', ['-extract', field, 'raw', '-o', '-', plist], {timeout:10_000,maxBuffer:8192})).stdout.trim()
  const [id, executable, version] = await Promise.all(['CFBundleIdentifier', 'CFBundleExecutable', 'CFBundleShortVersionString'].map(read))
  if (!executable || executable === '.' || executable === '..' || /[\/\\\0]/.test(executable)) throw new Error('The application executable is invalid.')
  return {id,executable,version}
}
export async function readMacContext(executable: string, expectedId: string, readIdentity: ReadIdentity = readBundleIdentity): Promise<MacContext> {
  if (!isAbsolute(executable)) throw new Error('The application location could not be verified.')
  let bundle = dirname(executable)
  while (!bundle.endsWith('.app') && dirname(bundle) !== bundle) bundle = dirname(bundle)
  const info = await lstat(bundle)
  if (!bundle.endsWith('.app') || !info.isDirectory() || info.isSymbolicLink() || await realpath(bundle) !== bundle) throw new Error('The installed application bundle could not be verified.')
  const identity = await readIdentity(bundle)
  if (identity.id !== expectedId || resolve(bundle,'Contents/MacOS',identity.executable) !== executable) throw new Error('The installed application identity does not match this launcher.')
  await access(dirname(bundle),constants.W_OK | constants.X_OK)
  return {bundle,device:info.dev,inode:info.ino,id:expectedId}
}
async function extractBundle(archive: string, directory: string): Promise<string> {
  const zip = await yauzl.openPromise(archive,{lazyEntries:true,autoClose:true})
  const roots = new Set<string>()
  let size=0, count=0
  try {
    for await (const entry of zip.eachEntry()) {
      const name=entry.fileName.replace(/\/$/,'')
      const parts=name.split('/')
      if (!name || name.includes('\\') || name.includes('\0') || parts.some(part=>!part || part==='.' || part==='..') || isAbsolute(name)) throw new Error('The update contains an unsafe application path.')
      if (parts[0]==='__MACOSX') continue
      if (!parts[0].endsWith('.app')) throw new Error('The update contains unexpected files outside its application bundle.')
      roots.add(parts[0]); size+=entry.uncompressedSize; count++
      if (roots.size!==1 || size>1024*1024*1024 || count>30000) throw new Error('The application archive is invalid or too large.')
      const kind=(entry.externalFileAttributes>>>16)&0xf000
      if (kind && kind!==0x8000 && kind!==0x4000) throw new Error('The update contains an unsupported linked or special file.')
      const path=resolve(directory,...parts)
      if (!path.startsWith(directory+sep)) throw new Error('The application archive path is invalid.')
      if (entry.fileName.endsWith('/')) { await mkdir(path,{recursive:true}); continue }
      await mkdir(dirname(path),{recursive:true})
      const stream=await zip.openReadStreamPromise(entry)
      await pipeline(stream,createWriteStream(path,{flags:'wx',mode:0o600}))
      const mode=(entry.externalFileAttributes>>>16)&0o755
      await chmod(path,mode || 0o644)
    }
  } finally { zip.close() }
  if (roots.size!==1) throw new Error('The update has no application bundle.')
  return join(directory,[...roots][0])
}
export async function replaceMacBundle(
  context: MacContext, download: string, sha512: string, version: string,
  start: (executable: string) => Promise<void>, readIdentity: ReadIdentity = readBundleIdentity
): Promise<void> {
  const staging=await mkdtemp(join(dirname(context.bundle),'.tia-update-'))
  const backup=join(staging,'previous.app')
  let moved=false, installed=false, preserveBackup=false
  try {
    const archive=join(staging,'update.zip')
    await copyFile(download,archive,constants.COPYFILE_EXCL)
    await verifyInstaller(archive,sha512)
    const extracted=join(staging,'extracted'); await mkdir(extracted)
    const next=await extractBundle(archive,extracted)
    const identity=await readIdentity(next)
    if (identity.id!==context.id || identity.version!==version) throw new Error('The downloaded application identity or version does not match the signed update.')
    const binary=join(next,'Contents/MacOS',identity.executable)
    if (basename(identity.executable)!==identity.executable) throw new Error('The update executable is invalid.')
    const code=await lstat(binary)
    if (!code.isFile() || code.isSymbolicLink() || !(code.mode&0o111)) throw new Error('The updated launcher executable could not be verified.')
    const current=await lstat(context.bundle)
    if (current.dev!==context.device || current.ino!==context.inode || current.isSymbolicLink()) throw new Error('The installed launcher changed while preparing the update.')
    await rename(context.bundle,backup); moved=true
    await rename(next,context.bundle); installed=true
    await start(join(context.bundle,'Contents/MacOS',identity.executable))
  } catch(error) {
    if (moved) {
      try {
        if (installed) await rename(context.bundle,join(staging,'failed.app'))
        await rename(backup,context.bundle)
      } catch {
        preserveBackup=true
        throw new Error(`The previous launcher is retained at ${backup}. Restore it before retrying.`,{cause:error})
      }
    }
    throw error
  } finally { if (!preserveBackup) await rm(staging,{recursive:true,force:true}).catch(()=>{}) }
}
