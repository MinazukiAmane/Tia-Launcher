import { constants } from 'node:fs'
import { access, chmod, copyFile, link, lstat, mkdtemp, open, realpath, rename, rm } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
import { verifyInstaller } from './bridgeRelease'

export interface AppImageContext {
  path: string
  device: number
  inode: number
  mode: number
}

export async function readAppImageContext(path: string | undefined): Promise<AppImageContext> {
  if (!path || !isAbsolute(path)) throw new Error('Update this installation using your package manager. Automatic migration requires an AppImage.')
  const info = await lstat(path)
  if (!info.isFile() || info.isSymbolicLink() || await realpath(path) !== path || !(info.mode & 0o111)) {
    throw new Error('The current AppImage location could not be verified.')
  }
  await access(dirname(path), constants.W_OK | constants.X_OK)
  return { path, device: info.dev, inode: info.ino, mode: info.mode & 0o777 }
}

async function requireAppImage(path: string): Promise<void> {
  const file = await open(path, 'r')
  try {
    const header = Buffer.alloc(12)
    const { bytesRead } = await file.read(header, 0, header.length, 0)
    if (bytesRead !== header.length || !header.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])) || !header.subarray(8, 11).equals(Buffer.from([0x41, 0x49, 2]))) {
      throw new Error('The downloaded update is not a supported AppImage.')
    }
  } finally { await file.close() }
}

export async function replaceAppImage(
  context: AppImageContext, downloaded: string, sha512: string,
  start: (path: string) => Promise<void>
): Promise<void> {
  const current = await readAppImageContext(context.path)
  if (current.device !== context.device || current.inode !== context.inode || current.mode !== context.mode) {
    throw new Error('The launcher installation changed while preparing the update. Please restart and retry.')
  }
  const staging = await mkdtemp(join(dirname(context.path), '.tia-update-'))
  const next = join(staging, 'next.AppImage')
  const previous = join(staging, 'previous.AppImage')
  let replaced = false
  let preserveBackup = false
  try {
    await copyFile(downloaded, next, constants.COPYFILE_EXCL)
    await verifyInstaller(next, sha512)
    await requireAppImage(next)
    await chmod(next, context.mode)
    const file = await open(next, 'r')
    try { await file.sync() } finally { await file.close() }
    await link(context.path, previous)
    const saved = await lstat(previous)
    if (saved.dev !== context.device || saved.ino !== context.inode) throw new Error('The launcher installation changed while preparing the update.')
    await rename(next, context.path)
    replaced = true
    await start(context.path)
  } catch (error) {
    if (replaced) {
      try { await rename(previous, context.path) } catch {
        preserveBackup = true
        throw new Error(`The update could not start. Your previous launcher is saved at ${previous}.`, { cause: error })
      }
    }
    throw error
  } finally {
    if (!preserveBackup) await rm(staging, { recursive: true, force: true }).catch(() => {})
  }
}
