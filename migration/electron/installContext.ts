import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { realpath } from 'node:fs/promises'
import { win32 } from 'node:path'

export interface InstallContext { directory: string; scope: 'currentUser' | 'allUsers' }
export interface RegistryInstallation extends InstallContext { view: '32' | '64' }
const execute = promisify(execFile)

function windowsPath(path: string): string {
  const normal = path.replace(/^\\\\\?\\UNC\\/i, '\\\\').replace(/^\\\\\?\\/, '')
  return win32.normalize(normal).replace(/\\$/, '').toLowerCase()
}

export async function selectInstallation(executable: string, registrations: RegistryInstallation[], resolve: (path: string) => Promise<string> = realpath): Promise<InstallContext> {
  if (!win32.isAbsolute(executable)) throw new Error('The launcher installation path is invalid.')
  const directory = win32.dirname(executable)
  const expected = windowsPath(await resolve(directory))
  const candidates: InstallContext[] = []
  for (const item of registrations) {
    if (!win32.isAbsolute(item.directory)) continue
    let path: string
    try { path = windowsPath(await resolve(item.directory)) } catch { continue }
    if (path === expected) candidates.push(item)
  }
  const scopes = new Set(candidates.map(item => item.scope))
  if (scopes.size !== 1) throw new Error('The existing launcher installation could not be identified safely. No update was installed.')
  // Keep the running executable's path, including custom locations and junctions.
  return { directory, scope: candidates[0].scope }
}

export async function readWindowsInstallContext(executable: string, guid: string): Promise<InstallContext> {
  if (!/^[a-f0-9-]{36}$/i.test(guid)) throw new Error('Invalid installer identity.')
  const registrations: RegistryInstallation[] = []
  for (const [root, scope] of [['HKCU', 'currentUser'], ['HKLM', 'allUsers']] as const) {
    for (const view of ['64', '32'] as const) {
      try {
        const { stdout } = await execute(win32.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'reg.exe'), ['query', `${root}\\Software\\${guid}`, '/v', 'InstallLocation', `/reg:${view}`], { windowsHide: true, timeout: 5000, maxBuffer: 65536 })
        const match = stdout.match(/^\s*InstallLocation\s+REG_SZ\s+(.+?)\s*$/m)
        if (match) registrations.push({ directory: match[1], scope, view })
      } catch (error) {
        if ((error as { code?: unknown }).code !== 1) throw new Error('Windows installation information could not be read. Please retry the update.')
      }
    }
  }
  return selectInstallation(executable, registrations)
}

export function preserveInstallScope(args: string[], context: InstallContext): string[] {
  const next = args.filter(arg => !/^\/(?:allusers|currentuser)$/i.test(arg) && !/^\/D=/i.test(arg))
  return [...next, context.scope === 'allUsers' ? '/allusers' : '/currentuser', `/D=${context.directory}`]
}
