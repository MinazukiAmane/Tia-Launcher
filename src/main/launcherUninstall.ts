
import { basename, dirname, join } from 'path'

export type LauncherUninstallPlan =
  | { kind: 'run_uninstaller'; uninstallerPath: string }
  | { kind: 'delete_appimage'; appImagePath: string }
  | { kind: 'reveal_app'; appPath: string; message: string }
  | { kind: 'manual'; message: string }
  | { kind: 'unavailable'; message: string }

export interface PlanInput {
  platform: NodeJS.Platform
  isPackaged: boolean
  execPath: string
  appImagePath: string | undefined
  // Whether the NSIS uninstaller exists next to the executable.
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
      kind: 'reveal_app',
      appPath,
      message: `Drag "${basename(appPath)}" to the Trash (it has been revealed in Finder).`
    }
  }
  if (input.appImagePath) {
    return { kind: 'delete_appimage', appImagePath: input.appImagePath }
  }
  return {
    kind: 'manual',
    message:
      'Installed through your package manager. Remove it with:\n' +
      '  Arch/CachyOS:  sudo pacman -R tia-launcher\n' +
      '  Debian/Ubuntu: sudo apt remove tia-launcher'
  }
}
