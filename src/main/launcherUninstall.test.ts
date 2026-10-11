import { describe, it, expect } from 'vitest'
import { planLauncherUninstall } from './launcherUninstall'

const base = { isPackaged: true, appImagePath: undefined, uninstallerExists: true }

describe('planLauncherUninstall', () => {
  it('refuses in an unpackaged dev build', () => {
    expect(
      planLauncherUninstall({ ...base, isPackaged: false, platform: 'linux', execPath: '/x/electron' }).kind
    ).toBe('unavailable')
  })

  it('runs the NSIS uninstaller on Windows when present, falls back to manual otherwise', () => {
    const run = planLauncherUninstall({
      ...base,
      platform: 'win32',
      execPath: 'C:\\Program Files\\Tia Launcher\\Tia Launcher.exe'
    })
    expect(run.kind).toBe('run_uninstaller')
    expect(
      planLauncherUninstall({ ...base, platform: 'win32', execPath: 'C:\\a\\b.exe', uninstallerExists: false }).kind
    ).toBe('manual')
  })

  it('reveals the .app bundle on macOS', () => {
    const plan = planLauncherUninstall({
      ...base,
      platform: 'darwin',
      execPath: '/Applications/Tia Launcher.app/Contents/MacOS/Tia Launcher'
    })
    expect(plan).toMatchObject({ kind: 'reveal_app', appPath: '/Applications/Tia Launcher.app' })
  })

  it('deletes the AppImage, or gives package-manager commands, on Linux', () => {
    expect(
      planLauncherUninstall({ ...base, platform: 'linux', execPath: '/tmp/.mount/x', appImagePath: '/home/u/Tia.AppImage' })
    ).toEqual({ kind: 'delete_appimage', appImagePath: '/home/u/Tia.AppImage' })
    const manual = planLauncherUninstall({ ...base, platform: 'linux', execPath: '/opt/Tia Launcher/tia' })
    expect(manual.kind).toBe('manual')
  })
})
