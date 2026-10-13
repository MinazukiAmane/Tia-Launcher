import { execFile } from 'child_process'
import { promisify } from 'util'
import { readFile, readdir, readlink } from 'fs/promises'
import { basename, dirname, join } from 'path'
import { logError } from './logger'

const execFileAsync = promisify(execFile)
const normalized = (value: string): string => value.replace(/\\/g, '/').toLowerCase()

export async function isGameProcessRunning(exePath: string): Promise<boolean> {
  const target = normalized(exePath)
  const name = normalized(basename(exePath))
  if (process.platform === 'win32') {
    const filterName = basename(exePath).replace(/'/g, "''")
    const { stdout } = await execFileAsync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command',
      `Get-CimInstance Win32_Process -Filter "Name='${filterName}'" | Select-Object ExecutablePath | ConvertTo-Json -Compress`
    ], { windowsHide: true, timeout: 10_000, maxBuffer: 1024 * 1024 })
    if (!stdout.trim()) return false
    const result = JSON.parse(stdout) as { ExecutablePath?: string } | { ExecutablePath?: string }[]
    return (Array.isArray(result) ? result : [result]).some(item => normalized(item.ExecutablePath ?? '') === target)
  }
  if (process.platform === 'linux') {
    const pids = (await readdir('/proc')).filter(pid => /^\d+$/.test(pid))
    for (const pid of pids) {
      try {
        const args = (await readFile(join('/proc', pid, 'cmdline'), 'utf8')).split('\0')
        const matching = args.filter(arg => normalized(arg).split('/').at(-1) === name)
        if (!matching.length) continue
        if (matching.some(arg => normalized(arg).includes(target))) return true
        const cwd = await readlink(join('/proc', pid, 'cwd'))
        if (normalized(cwd) === normalized(dirname(exePath))) return true
      } catch { /* Processes disappear or belong to another user. */ }
    }
    return false
  }
  if (process.platform === 'darwin') {
    const { stdout } = await execFileAsync('ps', ['-axo', 'pid=,command='], { timeout: 10_000, maxBuffer: 4 * 1024 * 1024 })
    for (const line of stdout.split('\n')) {
      if (normalized(line).includes(target)) return true
      // Wine may report a C: path instead of the host path.
      if (!normalized(line).split(/\s+/).some(arg => arg.replace(/^"|"$/g, '').split('/').at(-1) === name)) continue
      const pid = line.trim().match(/^\d+/)?.[0]
      if (!pid) continue
      try {
        const { stdout: cwd } = await execFileAsync('lsof', ['-a', '-p', pid, '-d', 'cwd', '-Fn'], { timeout: 5_000, maxBuffer: 64 * 1024 })
        if (cwd.split('\n').some(value => value.startsWith('n') && normalized(value.slice(1)) === normalized(dirname(exePath)))) return true
      } catch { /* Candidate exited before its directory could be inspected. */ }
    }
    return false
  }
  throw new Error('Game process monitoring is not supported on this platform.')
}

export interface GameSessionOptions {
  suspend: () => void
  restore: () => void
  probe?: (exePath: string) => Promise<boolean>
  pollMs?: number
  startupTimeoutMs?: number
}

export class GameSession {
  private timer: ReturnType<typeof setTimeout> | null = null
  private generation = 0
  private running = false
  get active(): boolean { return this.running }
  constructor(private readonly options: GameSessionOptions) {}

  start(exePath: string): void {
    if (this.running) return
    this.running = true
    const generation = ++this.generation
    const deadline = Date.now() + (this.options.startupTimeoutMs ?? 30_000)
    let observed = false
    let absentCount = 0
    let failureCount = 0
    // Let the launch IPC response reach the renderer before destroying it.
    this.timer = setTimeout(() => {
      if (generation !== this.generation) return
      this.options.suspend()
      void poll()
    }, 150)
    const finish = (): void => {
      if (generation !== this.generation) return
      this.stop()
      this.options.restore()
    }
    const poll = async (): Promise<void> => {
      if (generation !== this.generation) return
      try {
        const found = await (this.options.probe ?? isGameProcessRunning)(exePath)
        if (generation !== this.generation) return
        failureCount = 0
        if (found) { observed = true; absentCount = 0 }
        else if (observed) {
          if (++absentCount >= 2) { finish(); return }
        } else if (Date.now() >= deadline) { finish(); return }
      } catch (err) {
        if (generation !== this.generation) return
        logError('Game process monitoring failed', { error: (err as Error).message })
        // Never leave the launcher inaccessible after repeated monitor failures.
        if (++failureCount >= 3) { finish(); return }
      }
      this.timer = setTimeout(() => void poll(), this.options.pollMs ?? 2_000)
    }
  }

  stop(): void {
    ++this.generation
    this.running = false
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }
}
