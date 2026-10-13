
import { spawn } from 'child_process'
import { dirname, join } from 'path'

export type LauncherUninstallPlan =
  | { kind: 'run_uninstaller'; uninstallerPath: string }
  | { kind: 'package_manager'; command: string; args: string[] }
  | { kind: 'delete_appimage'; appImagePath: string }
  | { kind: 'trash_app'; appPath: string }
  | { kind: 'manual'; message: string }
  | { kind: 'unavailable'; message: string }

export interface PlanInput {
  platform: NodeJS.Platform
  isPackaged: boolean
  execPath: string
  appImagePath: string | undefined
  // Whether the NSIS uninstaller exists next to the executable.
  packageType?: string
  uninstallerExists: boolean
}

export const WINDOWS_UNINSTALLER_NAME = 'Uninstall Tia Launcher.exe'

export function planLauncherUninstall(input: PlanInput): LauncherUninstallPlan {
  if (!input.isPackaged) {
    return { kind: 'unavailable', message: 'The launcher can only be uninstalled from an installed build.' }
  }
  if (input.platform === 'win32') {
    const uninstallerPath = join(dirname(input.execPath), WINDOWS_UNINSTALLER_NAME)
    if (!input.uninstallerExists) {
      return {
        kind: 'manual',
        message: 'Uninstaller not found. Remove Tia Launcher from Windows Settings > Apps > Installed apps.'
      }
    }
    return { kind: 'run_uninstaller', uninstallerPath }
  }
  if (input.platform === 'darwin') {
    // execPath: <App>.app/Contents/MacOS/<bin>
    const appPath = dirname(dirname(dirname(input.execPath)))
    return {
      kind: 'trash_app',
      appPath,
    }
  }
  if (input.appImagePath) {
    return { kind: 'delete_appimage', appImagePath: input.appImagePath }
  }
  if (input.packageType === 'pacman') return { kind: 'package_manager', command: 'pkexec', args: ['pacman', '-R', '--noconfirm', 'tia-launcher'] }
  if (input.packageType === 'deb') return { kind: 'package_manager', command: 'pkexec', args: ['apt-get', 'remove', '-y', 'tia-launcher'] }
  return {
    kind: 'manual',
    message:
      'Installed through your package manager. Remove it with:\n' +
      '  Arch/CachyOS:  sudo pacman -R tia-launcher\n' +
      '  Debian/Ubuntu: sudo apt remove tia-launcher'
  }
}

// Keep the launcher open until authentication and package removal succeed.
export function runPackageUninstaller(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true })
    let stderr = ''
    child.stderr?.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-8192) })
    child.once('error', error => reject(new Error(`Could not start the package uninstaller: ${error.message}. Make sure polkit (pkexec) is installed.`)))
    child.once('close', code => {
      if (code === 0) resolve()
      else if (code === 126) reject(new Error('Uninstall canceled at the administrator authentication prompt.'))
      else reject(new Error(`Package uninstall failed (${code ?? 'terminated'}). ${stderr.trim()}`))
    })
  })
}

export async function openWindowsUninstaller(path: string, open: (path: string) => Promise<string>): Promise<void> {
  const error = await open(path)
  if (error) throw new Error(`Could not start the launcher uninstaller: ${error}`)
}
