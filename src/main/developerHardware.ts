import { app } from 'electron'
import { constants } from 'fs'
import { access, chmod, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'fs/promises'
import { join } from 'path'
import { spawn } from 'child_process'
import { createHash, createPublicKey, verify } from 'crypto'

export interface HardwareIdentity { deviceId: string; publicKey: string; provider: string }
export interface HardwareSigner { identity(): Promise<HardwareIdentity>; sign(message: Buffer): Promise<Buffer> }
const P256_SPKI_PREFIX = Buffer.from('3059301306072a8648ce3d020106082a8648ce3d030107034200', 'hex')
function canonicalIdentity(data: Buffer | string, provider: string): HardwareIdentity {
  const key = typeof data === 'string' ? createPublicKey(data) : createPublicKey({ key: data, type: 'spki', format: 'der' })
  if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') throw new Error('A hardware P-256 key is required.')
  const spki = key.export({ format: 'der', type: 'spki' })
  return { deviceId: createHash('sha256').update(spki).digest('hex'), publicKey: spki.toString('base64'), provider }
}
export function ecdsaRawToDer(raw: Buffer): Buffer {
  if (raw.length !== 64) throw new Error('Invalid hardware signature.')
  const integer = (input: Buffer): Buffer => {
    let value = input
    while (value.length > 1 && value[0] === 0) value = value.subarray(1)
    if (value[0] & 0x80) value = Buffer.concat([Buffer.from([0]), value])
    return Buffer.concat([Buffer.from([2, value.length]), value])
  }
  const body = Buffer.concat([integer(raw.subarray(0, 32)), integer(raw.subarray(32))])
  return Buffer.concat([Buffer.from([0x30, body.length]), body])
}
function run(executable: string, args: string[], input?: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    let output = Buffer.alloc(0), errors = Buffer.alloc(0), settled = false
    const finish = (error?: Error): void => {
      if (settled) return; settled = true; clearTimeout(timer)
      if (error) reject(error); else resolve(output)
    }
    const timer = setTimeout(() => { child.kill(); finish(new Error('Hardware signing timed out.')) }, 20_000)
    child.on('error', () => finish(new Error('Hardware signing tools are unavailable.')))
    child.stdout.on('data', (data: Buffer) => {
      if (output.length + data.length > 16_384) { child.kill(); finish(new Error('Invalid hardware response.')) }
      else output = Buffer.concat([output, data])
    })
    child.stderr.on('data', (data: Buffer) => { if (errors.length < 2048) errors = Buffer.concat([errors, data]).subarray(0, 2048) })
    child.stdin.on('error', () => {})
    child.on('close', code => finish(code === 0 ? undefined : new Error('Hardware signing failed. Check the TPM/Secure Enclave and its access permissions.')))
    child.stdin.end(input)
  })
}
class DeviceSigner implements HardwareSigner {
  private cachedIdentity: Promise<HardwareIdentity> | null = null
  private queue: Promise<unknown> = Promise.resolve()
  private serialized<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.queue.then(operation, operation)
    this.queue = next.catch(() => {})
    return next
  }
  identity(): Promise<HardwareIdentity> {
    if (!this.cachedIdentity) {
      this.cachedIdentity = this.serialized(async () => {
        if (process.platform === 'linux') return (await this.tpm()).identity
        const raw = await run(this.nativePath(), ['public'])
        const text = raw.toString('ascii').trim()
        if (!/^04[0-9a-f]{128}$/i.test(text)) throw new Error('Invalid hardware device public key.')
        return canonicalIdentity(Buffer.concat([P256_SPKI_PREFIX, Buffer.from(text, 'hex')]), process.platform === 'darwin' ? 'Secure Enclave' : 'TPM / Microsoft Platform Crypto Provider')
      }).catch(error => { this.cachedIdentity = null; throw error })
    }
    return this.cachedIdentity
  }
  async sign(message: Buffer): Promise<Buffer> {
    if (message.length > 1024 || !message.toString('utf8').startsWith('tia-launcher-dev/v1\n')) throw new Error('Invalid developer challenge.')
    const identity = await this.identity()
    const signature = await this.serialized(async () => {
      if (process.platform === 'linux') return (await this.tpm(message)).signature!
      const raw = await run(this.nativePath(), ['sign'], message)
      const text = raw.toString('ascii').trim()
      if (!/^[0-9a-f]+$/i.test(text) || text.length > 160) throw new Error('Invalid hardware signature.')
      const bytes = Buffer.from(text, 'hex')
      return process.platform === 'win32' ? ecdsaRawToDer(bytes) : bytes
    })
    const key = createPublicKey({ key: Buffer.from(identity.publicKey, 'base64'), type: 'spki', format: 'der' })
    if (!verify('sha256', message, key, signature)) throw new Error('Hardware key changed or signature verification failed.')
    return signature
  }
  private nativePath(): string {
    const base = app.isPackaged ? join(process.resourcesPath, 'dev-hardware') : join(process.cwd(), 'build', 'hardware')
    if (process.platform === 'win32') return join(base, 'dev-signer-win-x64.exe')
    if (process.platform === 'darwin') return join(base, 'dev-signer-macos')
    throw new Error('Hardware developer access is unsupported on this platform.')
  }
  private async tpm(message?: Buffer): Promise<{ identity: HardwareIdentity; signature?: Buffer }> {
    try {
      if (!(await stat('/dev/tpmrm0')).isCharacterDevice()) throw new Error('Not TPM')
      await access('/dev/tpmrm0', constants.R_OK | constants.W_OK)
      for (const name of ['createprimary', 'create', 'load', 'readpublic', 'sign']) await access('/usr/bin/tpm2_' + name, constants.X_OK)
    } catch { throw new Error('Developer access requires TPM 2.0, tpm2-tools, and read/write permission on /dev/tpmrm0. On CachyOS install tpm2-tools and grant your account TPM access.') }
    const base = join(app.getPath('userData'), 'developer-hardware')
    await mkdir(base, { recursive: true, mode: 0o700 }); await chmod(base, 0o700)
    const stage = await mkdtemp(join(base, 'operation-'))
    const primary = join(stage, 'primary.ctx'), context = join(stage, 'key.ctx'), keyDir = join(base, 'device-key')
    const command = (name: string, args: string[]): Promise<Buffer> => run('/usr/bin/tpm2_' + name, ['-Q', '-T', 'device:/dev/tpmrm0', ...args])
    try {
      await command('createprimary', ['-C', 'o', '-G', 'ecc', '-g', 'sha256', '-a', 'restricted|decrypt|fixedtpm|fixedparent|sensitivedataorigin|userwithauth|noda', '-c', primary])
      try { await access(keyDir) } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        const generated = join(stage, 'new-key'); await mkdir(generated, { mode: 0o700 })
        await command('create', ['-C', primary, '-G', 'ecc256:ecdsa-sha256', '-g', 'sha256', '-a', 'fixedtpm|fixedparent|sensitivedataorigin|userwithauth|sign|noda', '-u', join(generated, 'key.pub'), '-r', join(generated, 'key.priv')])
        await chmod(join(generated, 'key.pub'), 0o600); await chmod(join(generated, 'key.priv'), 0o600)
        await rename(generated, keyDir)
      }
      // key.priv is a fixed-TPM, fixed-parent wrapped blob, never a plaintext key.
      await command('load', ['-C', primary, '-u', join(keyDir, 'key.pub'), '-r', join(keyDir, 'key.priv'), '-c', context])
      const publicPath = join(stage, 'public.pem')
      await command('readpublic', ['-c', context, '-f', 'pem', '-o', publicPath])
      const identity = canonicalIdentity(await readFile(publicPath, 'utf8'), 'TPM 2.0')
      if (!message) return { identity }
      const input = join(stage, 'message.bin'), output = join(stage, 'signature.der')
      await writeFile(input, message, { mode: 0o600 })
      await command('sign', ['-c', context, '-g', 'sha256', '-s', 'ecdsa', '-f', 'plain', '-o', output, input])
      return { identity, signature: await readFile(output) }
    } finally {
      // The kernel resource manager flushes this command's transient objects.
      await rm(stage, { recursive: true, force: true })
    }
  }
}
export const developerHardware: HardwareSigner = new DeviceSigner()
