import { DatabaseCipher, DatabaseIntegrityError } from './databaseCipher'
import { DatabaseSync } from 'node:sqlite'
import { existsSync, mkdirSync, realpathSync, renameSync, copyFileSync, unlinkSync } from 'fs'
import { readFile, rename } from 'fs/promises'
import { dirname, join, resolve } from 'path'
import { randomUUID } from 'crypto'

const ciphers = new Map<string, DatabaseCipher>()

const directoryKey = Symbol.for('tia.launcher.databaseDirectory')
const directories = globalThis as typeof globalThis & { [directoryKey]?: string }

export function configureDatabaseDirectory(directory: string): void {
  directories[directoryKey] = resolve(directory)
}

export function databasePath(directory?: string): string {
  if (!directory && !directories[directoryKey]) throw new Error('Launcher database has not been initialized.')
  return join(directory ? resolve(directory) : directories[directoryKey]!, 'launcher.db')
}

export function gameScope(directory: string): string {
  let path = resolve(directory)
  try { path = realpathSync.native(path) } catch {
    try { path = join(realpathSync.native(dirname(path)), path.slice(dirname(path).length + 1)) } catch { /* New destination. */ }
  }
  return 'game:' + (process.platform === 'win32' ? path.toLowerCase() : path)
}

function openDatabase(path: string): DatabaseSync {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  if (!existsSync(path) && existsSync(path + '.bak')) {
    copyFileSync(path + '.bak', path)
    throw new Error('Launcher database was missing. A backup was restored; restart the launcher and verify the game before playing.')
  }
  let db: DatabaseSync | undefined
  try {
    db = new DatabaseSync(path)
    db.exec('PRAGMA busy_timeout=5000; PRAGMA synchronous=EXTRA; PRAGMA foreign_keys=ON;')
    const version = Number(db.prepare('PRAGMA user_version').get()!.user_version)
    if (version > 2) throw new Error('This launcher database requires a newer launcher version.')
    if (version === 0) {
      db.exec(`BEGIN IMMEDIATE;
        CREATE TABLE IF NOT EXISTS records (scope TEXT NOT NULL, name TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(scope,name));
        PRAGMA user_version=1;
        COMMIT;`)
    }
    if (version < 2 && ciphers.has(path)) throw new DatabaseIntegrityError()
    db.prepare('SELECT name FROM records LIMIT 1').get()
    return db
  } catch (error) {
    db?.close()
    const code = (error as { errcode?: number }).errcode
    if (code === 11 || code === 26) {
      const backup = path + '.bak'
      if (existsSync(backup)) {
        const check = new DatabaseSync(backup, { readOnly: true })
        try {
          if (check.prepare('PRAGMA quick_check').get()!.quick_check !== 'ok') throw new Error('Database backup is damaged.')
        } finally { check.close() }
        const damaged = path + '.damaged-' + Date.now()
        renameSync(path, damaged)
        if (existsSync(path + '-journal')) renameSync(path + '-journal', damaged + '-journal')
        copyFileSync(backup, path)
        throw new Error('Launcher database was damaged. A backup was restored; restart the launcher and verify the game before playing.')
      }
      throw new Error('Launcher database is damaged and no backup is available. Your game files have not been changed. Restore the database backup before continuing.')
    }
    throw error
  }
}

function withDatabase<T>(directory: string | undefined, action: (db: DatabaseSync) => T, durable = false): T {
  const path = databasePath(directory)
  const db = openDatabase(path)
  let temporary: string | undefined
  try {
    const result = action(db)
    if (durable && result !== false) {
      try {
        temporary = path + '.' + randomUUID() + '.tmp'
        db.prepare('VACUUM INTO ?').run(temporary)
        renameSync(temporary, path + '.bak')
        temporary = undefined
      } catch (error) { console.warn('Launcher database backup could not be refreshed:', error) }
    }
    return result
  } finally {
    db.close()
    if (temporary && existsSync(temporary)) {
      try { unlinkSync(temporary) } catch { /* A leftover backup must not invalidate a committed write. */ }
    }
  }
}

export function readRecord<T>(scope: string, name: string, directory?: string): T | null | undefined {
  return withDatabase(directory, db => {
    const row = db.prepare('SELECT value FROM records WHERE scope=? AND name=?').get(scope, name)
    return row ? JSON.parse(decodeRecord(databasePath(directory), scope, name, String(row.value))) as T | null : undefined
  })
}

export function writeRecords(scope: string, values: Record<string, unknown>, directory?: string, durable = true): void {
  withDatabase(directory, db => {
    db.exec('BEGIN IMMEDIATE')
    try {
      const statement = db.prepare('INSERT INTO records(scope,name,value) VALUES(?,?,?) ON CONFLICT(scope,name) DO UPDATE SET value=excluded.value')
      let changed = false
      const existing = db.prepare('SELECT value FROM records WHERE scope=? AND name=?')
      for (const [name, value] of Object.entries(values)) {
        const serialized = JSON.stringify(value)
        const previous = existing.get(scope, name)?.value
        if (previous !== undefined) {
          try { if (decodeRecord(databasePath(directory), scope, name, String(previous)) === serialized) continue } catch (error) {
            if (name !== 'verifyCache') throw error
          }
        }
        statement.run(scope, name, encodeRecord(databasePath(directory), scope, name, serialized))
        changed = true
      }
      db.exec('COMMIT')
      return changed
    } catch (error) { db.exec('ROLLBACK'); throw error }
  }, durable)
}

export async function migrateRecord<T>(scope: string, name: string, legacyPath: string, directory?: string): Promise<T | null> {
  const existing = readRecord<T>(scope, name, directory)
  if (existing !== undefined) return existing
  let value: T
  let archived = false
  try {
    let raw: string
    try { raw = await readFile(legacyPath, 'utf8') } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      raw = await readFile(legacyPath + '.migrated.bak', 'utf8')
      archived = true
    }
    value = JSON.parse(raw) as T
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      writeRecords(scope, { [name]: null }, directory)
      return null
    }
    throw error
  }
  // Another migration may have completed while the legacy file was read.
  const current = readRecord<T>(scope, name, directory)
  if (current !== undefined) return current
  writeRecords(scope, { [name]: value }, directory)
  if (!archived) {
    try { await rename(legacyPath, legacyPath + '.migrated.bak') } catch { /* The committed database is authoritative. */ }
  }
  return value
}

export function moveGameRecords(source: string, destination: string, state: unknown): void {
  const from = gameScope(source), to = gameScope(destination)
  withDatabase(undefined, db => {
    db.exec('BEGIN IMMEDIATE')
    try {
      const rows = db.prepare('SELECT name,value FROM records WHERE scope=?').all(from)
      db.prepare('DELETE FROM records WHERE scope=?').run(to)
      const insert = db.prepare('INSERT INTO records(scope,name,value) VALUES(?,?,?)')
      for (const row of rows) {
        const name = String(row.name)
        // A path move changes the authenticated record identity.
        if (name !== 'verifyCache') insert.run(to, name, encodeRecord(databasePath(), to, name, decodeRecord(databasePath(), from, name, String(row.value))))
      }
      db.prepare('INSERT INTO records(scope,name,value) VALUES(?,?,?) ON CONFLICT(scope,name) DO UPDATE SET value=excluded.value').run(to, 'install', encodeRecord(databasePath(), to, 'install', JSON.stringify(state)))
      const selectedRows = db.prepare("SELECT scope,value FROM records WHERE name='selectedInstallation'").all()
      for (const selected of selectedRows) {
        const current = JSON.parse(decodeRecord(databasePath(), String(selected.scope), 'selectedInstallation', String(selected.value))) as { installDir?: string } | null
        if (current?.installDir && gameScope(current.installDir) === from) {
          db.prepare("UPDATE records SET value=? WHERE scope=? AND name='selectedInstallation'").run(encodeRecord(databasePath(), String(selected.scope), 'selectedInstallation', JSON.stringify({ installDir: destination })), selected.scope)
        }
      }
      const preferenceRows = db.prepare("SELECT scope,value FROM records WHERE name='preferences'").all()
      for (const saved of preferenceRows) {
        const preferences = JSON.parse(decodeRecord(databasePath(), String(saved.scope), 'preferences', String(saved.value))) as { confirmedInstallDir?: string }
        if (preferences?.confirmedInstallDir && gameScope(preferences.confirmedInstallDir) === from) {
          db.prepare("UPDATE records SET value=? WHERE scope=? AND name='preferences'").run(encodeRecord(databasePath(), String(saved.scope), 'preferences', JSON.stringify({ ...preferences, confirmedInstallDir: destination })), saved.scope)
        }
      }
      db.prepare('DELETE FROM records WHERE scope=?').run(from)
      db.exec('COMMIT')
    } catch (error) { db.exec('ROLLBACK'); throw error }
  }, true)
}

export function forgetGameRecords(directory: string): void {
  writeRecords(gameScope(directory), { install: null, pendingAudio: null, checkpoint: null, verifyCache: null })
}

const legacyGameFiles = {
  install: '.csore_install.json',
  pendingAudio: '.csore_pending_audio_patch.json',
  checkpoint: '.csore_fresh_game.json',
  verifyCache: '.csore_verify_cache.json'
} as const

export async function readGameRecord<T>(directory: string, name: keyof typeof legacyGameFiles): Promise<T | null> {
  const scope = gameScope(directory)
  if (readRecord(scope, 'legacyMigrated') === true) return readRecord<T>(scope, name) ?? null
  const values: Record<string, unknown> = {}
  const imported: string[] = []
  for (const [key, filename] of Object.entries(legacyGameFiles)) {
    if (readRecord(scope, key) !== undefined) continue
    if (key === 'verifyCache' && databaseIsProtected()) { values[key] = null; continue }
    const path = join(directory, filename)
    try {
      let archived = false
      let raw: string
      try { raw = await readFile(path, 'utf8') } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        raw = await readFile(path + '.migrated.bak', 'utf8')
        archived = true
      }
      const value: unknown = JSON.parse(raw)
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Invalid saved game metadata: ${filename}. Game files have not been changed.`)
      const record = value as Record<string, unknown>
      if (key === 'install' && (typeof record.version !== 'string' || !Array.isArray(record.files))) throw new Error('Invalid saved installation metadata. Game files have not been changed.')
      if (key === 'pendingAudio' && (typeof record.toVersion !== 'string' || !Array.isArray(record.audioPkgs))) throw new Error('Invalid saved audio patch metadata. Game files have not been changed.')
      values[key] = key === 'install' && archived ? { ...record, needsRepair: true } : value
      if (!archived) imported.push(path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        if (key !== 'verifyCache') throw error
      }
      values[key] = null
    }
  }
  if (Object.keys(values).length) {
    // Keep every pre-update checkpoint together, including interrupted audio patches.
    for (const key of Object.keys(values)) if (readRecord(scope, key) !== undefined) delete values[key]
    writeRecords(scope, { ...values, legacyMigrated: true })
    for (const path of imported) {
      try { await rename(path, path + '.migrated.bak') } catch { /* Retain the legacy file if archival fails. */ }
    }
  }
  if (readRecord(scope, 'legacyMigrated') !== true) writeRecords(scope, { legacyMigrated: true })
  return readRecord<T>(scope, name) ?? null
}


function encodeRecord(path: string, scope: string, name: string, plain: string): string {
  return ciphers.get(path)?.seal(scope, name, plain) ?? plain
}

function decodeRecord(path: string, scope: string, name: string, raw: string): string {
  return ciphers.get(path)?.open(scope, name, raw) ?? raw
}

export function databaseIsProtected(): boolean { return ciphers.has(databasePath()) }

// Called once, before exposing any IPC or reading saved settings.
export function protectDatabase(key: Buffer, allowMigration: boolean, directory?: string): void {
  const path = databasePath(directory)
  const cipher = new DatabaseCipher(key)
  const db = openDatabase(path)
  let migrated = false
  try {
    const version = Number(db.prepare('PRAGMA user_version').get()!.user_version)
    if (version < 2 && !allowMigration) throw new DatabaseIntegrityError()
    const rows = db.prepare('SELECT scope,name,value FROM records').all()
    if (version === 2) {
      // Authenticate existing data once during startup, including rarely used settings.
      for (const row of rows) {
        try { cipher.open(String(row.scope), String(row.name), String(row.value)) } catch (error) {
          if (row.name !== 'verifyCache') throw error
          db.prepare('DELETE FROM records WHERE scope=? AND name=?').run(row.scope, row.name)
        }
      }
      // Resume cleanup if a previous migration stopped after committing rows.
      if (allowMigration) { db.exec('VACUUM'); migrated = true }
    } else {
      db.exec('PRAGMA secure_delete=ON; BEGIN IMMEDIATE')
      try {
        const update = db.prepare('UPDATE records SET value=? WHERE scope=? AND name=?')
        for (const row of rows) {
          const scope = String(row.scope), name = String(row.name), raw = String(row.value)
          JSON.parse(raw)
          // Old plaintext cache stamps are not an authenticated verification.
          if (name === 'verifyCache') { db.prepare('DELETE FROM records WHERE scope=? AND name=?').run(scope, name); continue }
          update.run(cipher.seal(scope, name, raw), scope, name)
        }
        db.exec('PRAGMA user_version=2; COMMIT')
      } catch (error) { db.exec('ROLLBACK'); throw error }
      // Remove plaintext from SQLite free pages and the pre-migration backup.
      db.exec('VACUUM')
      migrated = true
    }
    ciphers.set(path, cipher)
  } finally { db.close() }
  // VACUUM INTO keeps recovery data encrypted too.
  if (migrated) {
    const temporary = path + '.' + randomUUID() + '.tmp'
    const snapshot = openDatabase(path)
    try {
      snapshot.prepare('VACUUM INTO ?').run(temporary)
      renameSync(temporary, path + '.bak')
    } finally {
      snapshot.close()
      if (existsSync(temporary)) unlinkSync(temporary)
    }
  }
}
