import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export async function startMigratedAppImage(
  path: string, args: string[] = [], environment: NodeJS.ProcessEnv = process.env, timeoutMs = 90_000, onStderr?: (message: string) => void
): Promise<{ pid: number }> {
  if (!['linux', 'darwin'].includes(process.platform)) throw new Error('This startup handshake is only supported on Linux and macOS.')
  const directory = await mkdtemp(join(tmpdir(), 'tia-ready-'))
  const socket = join(directory, 'ready.sock')
  const server = createServer()
  const connections = new Set<Socket>()
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(socket, () => { server.removeListener('error', reject); resolve() })
    })
    const nonce = randomBytes(32).toString('hex')
    const env: NodeJS.ProcessEnv = { ...environment, TIA_MIGRATION_NONCE: nonce, TIA_MIGRATION_SOCKET: socket }
    const oldMount = environment.APPDIR?.replace(/\/$/, '')
    if (oldMount?.startsWith('/')) {
      const belongsToOldMount = (value: string): boolean => value === oldMount || value.startsWith(oldMount + '/')
      for (const name of ['PATH', 'LD_LIBRARY_PATH', 'XDG_DATA_DIRS', 'GI_TYPELIB_PATH', 'GIO_EXTRA_MODULES', 'QT_PLUGIN_PATH', 'QT_QPA_PLATFORM_PLUGIN_PATH']) {
        if (env[name]) env[name] = env[name]!.split(':').filter(value => !belongsToOldMount(value)).join(':')
      }
      for (const name of ['GTK_PATH', 'GTK_DATA_PREFIX', 'GTK_EXE_PREFIX', 'GTK_IM_MODULE_FILE', 'GIO_MODULE_DIR', 'GDK_PIXBUF_MODULE_FILE', 'GSETTINGS_SCHEMA_DIR', 'GST_PLUGIN_PATH_1_0', 'GST_PLUGIN_SYSTEM_PATH_1_0', 'GST_PLUGIN_SCANNER_1_0']) {
        if (env[name] && belongsToOldMount(env[name]!)) delete env[name]
      }
    }
    for (const name of ['APPIMAGE', 'APPDIR', 'ARGV0', 'OWD', 'APPIMAGE_EXIT_AFTER_INSTALL', 'APPIMAGE_SILENT_INSTALL', 'ELECTRON_RUN_AS_NODE']) delete env[name]
    return await new Promise<{ pid: number }>((resolve, reject) => {
      const child = spawn(path, args, { env, detached: true, shell: false, stdio: ['ignore', 'ignore', onStderr ? 'pipe' : 'ignore'] })
      let stderrBytes = 0
      child.stderr?.on('data', (chunk: Buffer) => {
        const text = chunk.subarray(0, Math.max(0, 65_536 - stderrBytes)).toString('utf8')
        stderrBytes += chunk.length
        if (text) { try { onStderr?.(text) } catch {} }
      })
      let ready = false, failure: Error | null = null
      let hardStop: ReturnType<typeof setTimeout> | undefined
      const signal = (value: NodeJS.Signals): void => {
        try { if (child.pid) process.kill(-child.pid, value) } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') child.kill(value)
        }
      }
      const fail = (message: string): void => {
        if (ready || failure) return
        failure = new Error(message)
        signal('SIGTERM')
        hardStop = setTimeout(() => signal('SIGKILL'), 5000)
      }
      const timer = setTimeout(() => fail('The updated launcher did not become ready. Your previous launcher will be restored.'), timeoutMs)
      server.on('error', () => fail('The updated launcher startup acknowledgement could not be read.'))
      server.on('connection', pipe => {
        connections.add(pipe)
        let buffer = '', size = 0
        pipe.on('close', () => connections.delete(pipe))
        pipe.on('error', () => fail('The updated launcher startup acknowledgement could not be read.'))
        pipe.on('data', (chunk: Buffer) => {
          if (failure || ready) return
          size += chunk.length
          if (size > 16_384) { fail('The updated launcher sent an invalid startup acknowledgement.'); return }
          buffer += chunk.toString('utf8')
          const end = buffer.indexOf('\n')
          if (end === -1) return
          try {
            const receipt = JSON.parse(buffer.slice(0, end))
            if (receipt.protocol !== 1 || receipt.nonce !== nonce || receipt.status !== 'ready') {
              fail('The updated launcher sent an invalid startup acknowledgement.'); return
            }
            ready = true
            clearTimeout(timer)
            child.unref()
            const errors = child.stderr as Socket | null
            errors?.unref()
            resolve({ pid: child.pid! })
          } catch { fail('The updated launcher sent an invalid startup acknowledgement.'); return }
        })
      })
      child.once('error', () => fail('The updated launcher could not start.'))
      child.once('close', () => {
        clearTimeout(timer); clearTimeout(hardStop)
        if (!ready) reject(failure ?? new Error('The updated launcher closed before it was ready.'))
      })
    })
  } finally {
    for (const connection of connections) connection.destroy()
    if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()))
    await rm(directory, { recursive: true, force: true }).catch(() => {})
  }
}
