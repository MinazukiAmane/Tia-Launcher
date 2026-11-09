import { spawn } from 'node:child_process'
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readFile, lstat, realpath } from 'node:fs/promises'
import { join } from 'node:path'

interface Storage { decryptString(value: Buffer): string }
interface Receipt { protocol: number; nonce: string; databaseSha256: string; recordsVerified: number; proof: string }

async function sha256(path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

export async function verifyMigrationHelper(helper: string, expected: string): Promise<void> {
  const info = await lstat(helper)
  if (!info.isFile() || info.isSymbolicLink() || !/^[a-f0-9]{64}$/.test(expected) || await sha256(helper) !== expected) throw new Error('The migration component could not be verified.')
}

// Main process only. The helper is bundled and hash-pinned by the bridge release.
export async function handoffDatabaseKey(profile: string, helper: string, helperSha256: string, storage: Storage): Promise<Receipt> {
  const directory = await realpath(profile)
  await verifyMigrationHelper(helper, helperSha256)
  const keyPath = join(directory, 'launcher.key')
  const info = await lstat(keyPath)
  if (!info.isFile() || info.isSymbolicLink() || info.size > 4 * 1024 * 1024) throw new Error('The saved launcher key could not be read safely.')
  const saved = JSON.parse(await readFile(keyPath, 'utf8')) as { version: number; mode: string; data: string; migrated: boolean; tag: string }
  if (saved.version !== 1 || !saved.migrated || !['os', 'file'].includes(saved.mode)) throw new Error('Update the Electron launcher before migrating.')
  const secret = saved.mode === 'os' ? storage.decryptString(Buffer.from(saved.data, 'base64')) : saved.data
  if (!/^[a-f0-9]{64}$/.test(secret)) throw new Error('The saved launcher key could not be opened.')
  const key = Buffer.from(secret, 'hex')
  try {
    const nonce = randomBytes(32).toString('hex')
    const request = JSON.stringify({ protocol: 1, nonce, profile: directory, root_key: key.toString('hex') })
    const receipt = await new Promise<Receipt>((resolve, reject) => {
      const child = spawn(helper, ['--import-key-stdin'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: false })
      let output = '', size = 0
      const timer = setTimeout(() => { child.kill(); reject(new Error('Migration timed out. Original data has been retained.')) }, 90_000)
      child.stdout.on('data', chunk => { size += chunk.length; if (size > 16384) { child.kill(); return }; output += chunk.toString('utf8') })
      // Do not relay subprocess errors that might contain request material.
      child.stderr.resume()
      child.on('error', () => { clearTimeout(timer); reject(new Error('The migration component could not start.')) })
      child.on('close', code => {
        clearTimeout(timer)
        if (code !== 0 || size > 16384) { reject(new Error('Migration could not be verified. Original launcher data has been retained.')); return }
        try { resolve(JSON.parse(output) as Receipt) } catch { reject(new Error('Invalid migration acknowledgement.')) }
      })
      child.stdin.on('error', () => {})
      child.stdin.end(request)
    })
    if (receipt.protocol !== 1 || receipt.nonce !== nonce || !Number.isSafeInteger(receipt.recordsVerified) || receipt.recordsVerified < 0 || !/^[a-f0-9]{64}$/.test(receipt.databaseSha256) || !/^[a-f0-9]{64}$/.test(receipt.proof)) throw new Error('Invalid migration acknowledgement.')
    const expectedReceipt = createHmac('sha256', key).update(JSON.stringify(['tia-migration-v1', nonce, receipt.databaseSha256, String(receipt.recordsVerified)])).digest()
    if (!timingSafeEqual(expectedReceipt, Buffer.from(receipt.proof, 'hex'))) throw new Error('The migration acknowledgement could not be authenticated.')
    return receipt
  } finally { key.fill(0) }
}
