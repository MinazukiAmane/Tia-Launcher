import { createHash, randomUUID } from 'crypto'
import { createReadStream } from 'fs'
import { cp, lstat, mkdir, mkdtemp, readdir, readlink, realpath, rename, rm, rmdir, writeFile } from 'fs/promises'
import { basename, dirname, join, relative, resolve, sep, isAbsolute } from 'path'
import { readInstallState, type InstallState } from './installState'

export interface MoveProgress {
  phase: 'moving' | 'copying' | 'verifying'
  processed: number
  total: number
}
export interface MoveResult {
  installDir: string
  warning?: string
}

async function hashFile(path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

async function listFiles(root: string, prefix = ''): Promise<string[]> {
  const files: string[] = []
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    const path = join(prefix, entry.name)
    if (entry.isDirectory()) files.push(...await listFiles(root, path))
    else if (entry.isFile() || entry.isSymbolicLink()) files.push(path)
    else throw new Error(`Cannot move unsupported filesystem entry: ${path}`)
  }
  return files
}

async function writeMovedState(root: string, state: InstallState): Promise<void> {
  const temporary = join(root, `.csore_move_state-${randomUUID()}.tmp`)
  try {
    await writeFile(temporary, JSON.stringify(state, null, 2))
    await rename(temporary, join(root, '.csore_install.json'))
  } finally {
    await rm(temporary, { force: true })
  }
}

// Kept separate from the operation lock so filesystem failures can be tested.
export async function moveInstallDirectory(
  sourcePath: string, destinationPath: string,
  onProgress: (progress: MoveProgress) => void = () => {}
): Promise<MoveResult> {
  const source = await realpath(sourcePath)
  const destination = join(await realpath(dirname(resolve(destinationPath))), basename(resolve(destinationPath)))
  const nested = (parent: string, child: string): boolean => {
    const path = relative(parent, child)
    return path === '' || (!path.startsWith('..' + sep) && path !== '..' && !isAbsolute(path))
  }
  if (nested(source, destination) || nested(destination, source)) {
    throw new Error('Choose a different folder outside the current installation.')
  }
  const state = await readInstallState(source)
  if (!state) throw new Error('No installed game found to move.')
  let destinationExisted = false
  try {
    const info = await lstat(destination)
    if (!info.isDirectory() || info.isSymbolicLink() || (await readdir(destination)).length) {
      throw new Error('The destination must be an empty folder. Existing files will not be overwritten.')
    }
    destinationExisted = true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const stage = await mkdtemp(join(dirname(destination), '.csore-move-'))
  await rmdir(stage)
  let renamedSource = false
  let removedEmptyDestination = false
  let committed = false
  try {
    onProgress({ phase: 'moving', processed: 0, total: 1 })
    try {
      await rename(source, stage)
      renamedSource = true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error
      const files = await listFiles(source)
      onProgress({ phase: 'copying', processed: 0, total: files.length })
      await cp(source, stage, { recursive: true, dereference: false, verbatimSymlinks: true, force: false, errorOnExist: true, preserveTimestamps: true })
      let processed = 0
      for (const file of files) {
        const original = join(source, file)
        const copied = join(stage, file)
        const before = await lstat(original)
        const copyInfo = await lstat(copied)
        if (before.isSymbolicLink()) {
          if (!copyInfo.isSymbolicLink() || await readlink(original) !== await readlink(copied)) throw new Error(`Copy verification failed: ${file}`)
        } else {
          if (!copyInfo.isFile() || before.size !== copyInfo.size || await hashFile(original) !== await hashFile(copied)) throw new Error(`Copy verification failed: ${file}`)
          const after = await lstat(original)
          if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error(`Game files changed while moving: ${file}`)
        }
        onProgress({ phase: 'verifying', processed: ++processed, total: files.length })
      }
    }
    await writeMovedState(stage, { ...state, installDir: destination })
    if (destinationExisted) {
      await rmdir(destination) // Fails safely if another app added files during the move.
      removedEmptyDestination = true
    }
    await rename(stage, destination)
    committed = true
  } catch (error) {
    if (renamedSource) {
      await rename(stage, source)
      await writeMovedState(source, state)
    } else {
      await rm(stage, { recursive: true, force: true })
    }
    if (removedEmptyDestination) await mkdir(destination).catch(() => {})
    throw error
  }
  if (committed && !renamedSource) {
    try { await rm(source, { recursive: true }) } catch {
      return { installDir: destination, warning: 'Installation moved successfully, but some files remain at the old location. You can remove those after checking the new installation.' }
    }
  }
  onProgress({ phase: 'moving', processed: 1, total: 1 })
  return { installDir: destination }
}
