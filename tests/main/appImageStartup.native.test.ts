import { expect, it } from 'vitest'
import { createHash, createHmac, randomBytes } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { DatabaseCipher } from '../../src/main/databaseCipher'
import { startMigratedAppImage } from '../../migration/electron/appImageStartup'
import { readAppImageContext, replaceAppImage } from '../../migration/electron/appImageMigration'

it.skipIf(process.env.TIA_NATIVE_STARTUP_SMOKE !== '1' || process.platform !== 'linux')('receives readiness from the real Tauri WebView after reading existing encrypted preferences', async () => {
 const production = process.env.TIA_NATIVE_PRODUCTION_STARTUP === '1'
 if (production && !process.env.XDG_CONFIG_HOME) throw new Error('Production startup tests require an isolated XDG configuration directory.')
 const profile = production ? join(process.env.XDG_CONFIG_HOME!, 'tia-launcher-bootstrap') : await mkdtemp(join(tmpdir(), 'tia-native-startup-'))
 if (production) {
  const temporary = dirname(await realpath(process.env.XDG_CONFIG_HOME!))
  if (!basename(temporary).startsWith('tia-native-desktop-') || ((await lstat(temporary)).mode&0o077)!==0) throw new Error('Refusing a configuration directory outside the private desktop test harness.')
  await lstat(profile).then(()=>{throw new Error('Refusing to overwrite an existing launcher profile.')},error=>{if(error.code!=='ENOENT')throw error})
 }
 await mkdir(profile,{recursive:true,mode:0o700})
 let pid: number | undefined
 try {
  const key = randomBytes(32), data = key.toString('base64')
  await writeFile(join(profile, 'launcher.tauri.key'), JSON.stringify({version:1,mode:'file',data,tag:createHmac('sha256',key).update(JSON.stringify([1,'file',data])).digest('hex')}))
  await chmod(join(profile, 'launcher.tauri.key'), 0o600)
  const db = new DatabaseSync(join(profile, 'launcher.db'))
  db.exec('CREATE TABLE records(scope TEXT,name TEXT,value TEXT,PRIMARY KEY(scope,name)); PRAGMA user_version=2;')
  const cipher = new DatabaseCipher(key)
  const sealed = cipher.seal('launcher', 'preferences', JSON.stringify({launcherLanguage:'id',backgroundMode:'image',confirmedInstallDir:null}))
  db.prepare('INSERT INTO records VALUES(?,?,?)').run('launcher','preferences',sealed)
  db.close()
  const binary = process.env.TIA_NATIVE_STARTUP_BINARY ?? resolve('src-tauri/target/debug/tia-launcher')
  const environment = {
   ...process.env,
   GDK_BACKEND:'x11',
   APPIMAGE_EXTRACT_AND_RUN:'1',
   NO_AT_BRIDGE:'1',
   LIBGL_ALWAYS_SOFTWARE:'1',
   WEBKIT_DISABLE_DMABUF_RENDERER:'1',
   WEBKIT_DISABLE_COMPOSITING_MODE:'1'
  }
  const launch = async (path: string): Promise<void> => {
   const result = await startMigratedAppImage(path, production ? [] : ['--profile', profile], environment, 60_000, message => process.stderr.write(message))
   pid = result.pid
  }
  if (binary.endsWith('.AppImage')) {
   const current = join(profile, 'Custom Tia Launcher.AppImage')
   const original = 'previous launcher fixture'
   await writeFile(current,original,{mode:0o751}); await chmod(current,0o751)
   const digest = createHash('sha512')
   for await (const chunk of createReadStream(binary)) digest.update(chunk)
   const hash = digest.digest('base64')
   const context = await readAppImageContext(current)
   const keyPath = join(profile,'launcher.tauri.key')
   const goodKey = await readFile(keyPath,'utf8')
   const badKey = JSON.parse(goodKey); badKey.tag='0'.repeat(64)
   await writeFile(keyPath,JSON.stringify(badKey))
   await expect(replaceAppImage(context,binary,hash,launch)).rejects.toThrow(/closed before it was ready/)
   expect(await readFile(current,'utf8')).toBe(original)
   await writeFile(keyPath,goodKey)
   await replaceAppImage(context,binary,hash,launch)
  } else {
   await launch(binary)
  }
  const saved = new DatabaseSync(join(profile,'launcher.db'),{readOnly:true})
  try {
   const value = saved.prepare('SELECT value FROM records WHERE scope=? AND name=?').get('launcher','preferences')!.value as string
   expect(JSON.parse(cipher.open('launcher','preferences',value))).toMatchObject({launcherLanguage:'id',backgroundMode:'image'})
  } finally { saved.close() }
  expect(await readFile(join(profile,'launcher.tauri.key'),'utf8')).toContain('"mode":"file"')
 } finally {
  if (pid) {
   try { process.kill(-pid,'SIGTERM') } catch {}
   for (let i=0;i<50;i++) {
    try { process.kill(pid,0) } catch { break }
    await new Promise(resolve => setTimeout(resolve,100))
   }
   try { process.kill(-pid,'SIGKILL') } catch {}
  }
  await rm(profile,{recursive:true,force:true})
 }
}, 150_000)
