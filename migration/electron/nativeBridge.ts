import { constants } from 'node:fs'
import { mkdtemp, copyFile, chmod, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { verifyMigrationHelper } from './keyHandoff'

export interface InstallContext { directory: string; scope: 'currentUser' | 'allUsers' }
export interface AppImageContext { path: string; device: string; inode: string; mode: number }
export interface MacContext { bundle: string; device: string; inode: string; id: string }
export interface Startup { args?: string[]; environment?: NodeJS.ProcessEnv; timeoutMs?: number }

export class NativeBridge {
  constructor(private readonly helper: string, private readonly sha256: string) {}
  async preserve<T>(action: (native: NativeBridge) => Promise<T>): Promise<T> {
    await verifyMigrationHelper(this.helper, this.sha256)
    const directory = await mkdtemp(join(tmpdir(), 'tia-bridge-helper-'))
    try {
      const helper = join(directory, process.platform === 'win32' ? 'helper.exe' : 'helper')
      await copyFile(this.helper, helper, constants.COPYFILE_EXCL)
      await chmod(helper, 0o700)
      await verifyMigrationHelper(helper, this.sha256)
      return await action(new NativeBridge(helper, this.sha256))
    } finally { await rm(directory, { recursive: true, force: true }) }
  }
  private async request<T>(value: Record<string, unknown>): Promise<T> {
    await verifyMigrationHelper(this.helper, this.sha256)
    const request = JSON.stringify(value)
    if (Buffer.byteLength(request) > 131072) throw new Error('The migration request is too large.')
    return new Promise<T>((resolve, reject) => {
      const child = spawn(this.helper, ['--bridge-operation-stdin'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: false })
      let output = '', size = 0, diagnostic = ''
      const timer = setTimeout(() => { child.kill(); reject(new Error('The migration operation timed out.')) }, 300000)
      child.stdout.on('data', (chunk: Buffer) => { size += chunk.length; if (size > 16384) child.kill(); else output += chunk.toString('utf8') })
      child.stderr.on('data', (chunk: Buffer) => { diagnostic = (diagnostic + chunk.toString('utf8')).slice(-4096) })
      child.once('error', () => { clearTimeout(timer); reject(new Error('The migration component could not start.')) })
      child.once('close', code => {
        clearTimeout(timer)
        if (code !== 0 || size > 16384) { reject(new Error(`The migration operation failed. ${diagnostic.trim()}`)); return }
        try {
          const response = JSON.parse(output)
          if (response.protocol !== 1 || !Object.hasOwn(response, 'result')) throw new Error()
          resolve(response.result as T)
        } catch { reject(new Error('Invalid migration acknowledgement.')) }
      })
      child.stdin.on('error', () => {})
      child.stdin.end(request)
    })
  }
  verifyInstaller(path: string, sha512: string): Promise<void> { return this.request({ operation: 'verify-installer', path, sha512 }) }
  windowsContext(executable: string, guid: string): Promise<InstallContext> { return this.request({ operation: 'windows-context', executable, guid }) }
  windowsArguments(args: string[], context: InstallContext): Promise<string[]> { return this.request({ operation: 'windows-arguments', args, context }) }
  appImageContext(path: string): Promise<AppImageContext> { return this.request({ operation: 'appimage-context', path }) }
  macContext(executable: string, id: string): Promise<MacContext> { return this.request({ operation: 'mac-context', executable, id }) }
  start(path: string, options?: Startup): Promise<{ pid: number }> { return this.request({ operation: 'start', path, startup: options ?? {} }) }
  replaceAppImage(context: AppImageContext, download: string, sha512: string, options?: Startup): Promise<{ pid: number }> { return this.request({ operation: 'replace-appimage', context, download, sha512, startup: options ?? {} }) }
  replaceMac(context: MacContext, download: string, sha512: string, version: string): Promise<{ pid: number }> { return this.request({ operation: 'replace-mac', context, download, sha512, version, startup: {} }) }
}
