import { safeStorage } from 'electron'
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { readFile, writeFile, rename, mkdir, lstat, chmod, open, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { databasePath, protectDatabase } from './localDatabase'
import { DatabaseIntegrityError } from './databaseCipher'
import { retryTransientFileAccess } from './fileAccess'
import { logInfo } from './logger'

interface SavedKey {
  version: 1
  mode: 'os' | 'file'
  data: string
  migrated: boolean
  tag: string
}

function authenticateKey(saved: Omit<SavedKey, 'tag'>, key: Buffer): string {
  return createHmac('sha256', key).update(JSON.stringify([saved.version, saved.mode, saved.data, saved.migrated])).digest('hex')
}

async function syncKeyDirectory(directory: string): Promise<void> {
  if (process.platform === 'win32') return
  const handle = await open(directory, 'r')
  try { await handle.sync() } finally { await handle.close() }
}

export interface KeyStorage {
  available(): boolean
  encrypt(value: string): Buffer
  decrypt(value: Buffer): string
}

// Only startup touches the OS credential store; Play uses the in-memory key.
export async function initializeDatabaseProtection(directory: string, storage: KeyStorage): Promise<void> {
  const keyPath = join(directory, 'launcher.key')
  await mkdir(directory, { recursive: true, mode: 0o700 })
  let saved: SavedKey | undefined
  try {
    const info = await lstat(keyPath)
    if (!info.isFile() || info.nlink !== 1 || info.size > 16384) throw new DatabaseIntegrityError()
    saved = JSON.parse(await readFile(keyPath, 'utf8')) as SavedKey
    if (saved.version !== 1 || !['os', 'file'].includes(saved.mode) || typeof saved.migrated !== 'boolean') throw new DatabaseIntegrityError()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new DatabaseIntegrityError()
  }
  let key: Buffer
  if (saved) {
    try {
      const plain = saved.mode === 'os' ? storage.decrypt(Buffer.from(saved.data, 'base64')) : saved.data
      if (!/^[a-f0-9]{64}$/.test(plain)) throw new DatabaseIntegrityError()
      key = Buffer.from(plain, 'hex')
      if (typeof saved.tag !== 'string' || !/^[a-f0-9]{64}$/.test(saved.tag) || !timingSafeEqual(Buffer.from(saved.tag, 'hex'), Buffer.from(authenticateKey(saved, key), 'hex'))) throw new DatabaseIntegrityError()
    } catch { throw new DatabaseIntegrityError() }
  } else {
    // Never replace a missing key for an already protected database or backup.
    for (const path of [databasePath(directory), databasePath(directory) + '.bak']) {
      try {
        await lstat(path)
        const db = new DatabaseSync(path, { readOnly: true })
        try { if (Number(db.prepare('PRAGMA user_version').get()!.user_version) >= 2) throw new DatabaseIntegrityError() }
        finally { db.close() }
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    }
    key = randomBytes(32)
    saved = { version: 1, mode: 'file', data: key.toString('hex'), migrated: false, tag: '' }
    if (storage.available()) saved = { ...saved, mode: 'os', data: storage.encrypt(key.toString('hex')).toString('base64') }
    saved.tag = authenticateKey(saved, key)
    // Persist the key before migration so an interrupted upgrade is recoverable.
    await writeFile(keyPath, JSON.stringify(saved), { flag: 'wx', mode: 0o600, flush: true })
    await syncKeyDirectory(directory)
  }
  protectDatabase(key, !saved.migrated, directory)
  const upgradeKey = saved.mode === 'file' && storage.available()
  if (!saved.migrated || upgradeKey) {
    const next = { ...saved, migrated: true }
    if (upgradeKey) { next.mode = 'os'; next.data = storage.encrypt(key.toString('hex')).toString('base64') }
    next.tag = authenticateKey(next, key)
    const temporary = keyPath + '.' + randomBytes(8).toString('hex') + '.tmp'
    try {
      await writeFile(temporary, JSON.stringify(next), { flag: 'wx', mode: 0o600, flush: true })
      await retryTransientFileAccess(() => rename(temporary, keyPath))
      await syncKeyDirectory(directory)
    } finally { await rm(temporary, { force: true }) }
    saved = next
  }
  if (process.platform !== 'win32') await chmod(keyPath, 0o600)
  logInfo('database: authenticated encryption ready', { keyProtection: saved.mode === 'os' ? 'os-keystore' : 'owner-only-file' })
}

export function initializeLauncherDatabase(directory: string): Promise<void> {
  return initializeDatabaseProtection(directory, {
    available: () => safeStorage.isEncryptionAvailable() && (process.platform !== 'linux' || !['basic_text', 'unknown'].includes(safeStorage.getSelectedStorageBackend())),
    encrypt: value => safeStorage.encryptString(value),
    decrypt: value => safeStorage.decryptString(value)
  })
}
