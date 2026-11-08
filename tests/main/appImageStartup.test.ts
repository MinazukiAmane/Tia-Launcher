import { afterEach, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startMigratedAppImage } from '../../migration/electron/appImageStartup'

const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))) })
async function fixture(body: string) {
 const directory = await mkdtemp(join(tmpdir(), 'tia-startup-')); directories.push(directory)
 const script = join(directory, 'startup.cjs')
 await writeFile(script, body)
 return script
}
const linux = process.platform === 'linux'
it.skipIf(!linux)('waits for a matching readiness receipt and removes Electron AppImage environment variables', async () => {
 const script = await fixture(`
 const net = require('node:net');
 if (process.env.LD_LIBRARY_PATH !== '/keep:/old-mount2') process.exit(3);
 if (process.env.GIO_MODULE_DIR) process.exit(4);
 if (['APPIMAGE','APPDIR','ARGV0','OWD','ELECTRON_RUN_AS_NODE'].some(name => process.env[name])) process.exit(2);
 setTimeout(() => net.connect(process.env.TIA_MIGRATION_SOCKET).end(JSON.stringify({protocol:1,nonce:process.env.TIA_MIGRATION_NONCE,status:'ready'})+'\\n'), 100);
 setTimeout(() => process.exit(0), 500);
 `)
 const started = Date.now()
 const result = await startMigratedAppImage(process.execPath, [script], { ...process.env, APPIMAGE: '/old', APPDIR: '/old-mount', ARGV0: '/old', OWD: '/old', ELECTRON_RUN_AS_NODE: '1', LD_LIBRARY_PATH: '/keep:/old-mount/usr/lib:/old-mount2', GIO_MODULE_DIR: '/old-mount/usr/lib/gio/modules' })
 expect(result.pid).toBeGreaterThan(0)
 expect(Date.now() - started).toBeGreaterThanOrEqual(80)
})
it.skipIf(!linux)('rejects early exits, forged receipts and oversized acknowledgements', async () => {
 for (const body of [
  'process.exit(0)',
  `require('node:net').connect(process.env.TIA_MIGRATION_SOCKET).end(JSON.stringify({protocol:1,nonce:'wrong',status:'ready'})+'\\n'); setInterval(()=>{},1000)`,
  `require('node:net').connect(process.env.TIA_MIGRATION_SOCKET).end('x'.repeat(17000)); setInterval(()=>{},1000)`
 ]) {
  const script = await fixture(body)
  await expect(startMigratedAppImage(process.execPath, [script], process.env, 3000)).rejects.toThrow(/before it was ready|invalid startup/)
 }
})
it.skipIf(!linux)('times out silent startups and rejects binaries that cannot start', async () => {
 const script = await fixture('setInterval(()=>{},1000)')
 await expect(startMigratedAppImage(process.execPath, [script], process.env, 150)).rejects.toThrow(/did not become ready/)
 await expect(startMigratedAppImage('/missing/tia-launcher')).rejects.toThrow(/could not start/)
})
