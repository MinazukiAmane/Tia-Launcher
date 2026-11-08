import { describe, it, expect } from 'vitest'
import { planLauncherUninstall, runPackageUninstaller, openWindowsUninstaller } from '../../src/main/launcherUninstall'

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

  it('moves the .app bundle to Trash on macOS', () => {
    const plan = planLauncherUninstall({
      ...base,
      platform: 'darwin',
      execPath: '/Applications/Tia Launcher.app/Contents/MacOS/Tia Launcher'
    })
    expect(plan).toMatchObject({ kind: 'trash_app', appPath: '/Applications/Tia Launcher.app' })
  })

  it('deletes the AppImage, or gives package-manager commands, on Linux', () => {
    expect(
      planLauncherUninstall({ ...base, platform: 'linux', execPath: '/tmp/.mount/x', appImagePath: '/home/u/Tia.AppImage' })
    ).toEqual({ kind: 'delete_appimage', appImagePath: '/home/u/Tia.AppImage' })
    const manual = planLauncherUninstall({ ...base, platform: 'linux', execPath: '/opt/Tia Launcher/tia' })
    expect(manual.kind).toBe('manual')
  })
})

it('uses the native package manager for pacman and deb installed builds', () => {
  const input = { ...base, platform: 'linux' as const, execPath: '/opt/Tia Launcher/tia' }
  expect(planLauncherUninstall({ ...input, packageType: 'pacman' })).toEqual({ kind: 'package_manager', command: 'pkexec', args: ['pacman', '-R', '--noconfirm', 'tia-launcher'] })
  expect(planLauncherUninstall({ ...input, packageType: 'deb' })).toEqual({ kind: 'package_manager', command: 'pkexec', args: ['apt-get', 'remove', '-y', 'tia-launcher'] })
})
it('reports Windows shell failures instead of claiming the uninstaller started', async () => {
  await expect(openWindowsUninstaller('fixture.exe', async () => 'access denied')).rejects.toThrow('access denied')
  await expect(openWindowsUninstaller('fixture.exe', async () => '')).resolves.toBeUndefined()
})
it('waits for package removal and reports authentication cancellation and errors', async () => {
  await expect(runPackageUninstaller(process.execPath, ['-e', 'process.exit(0)'])).resolves.toBeUndefined()
  await expect(runPackageUninstaller(process.execPath, ['-e', 'process.exit(126)'])).rejects.toThrow(/canceled/)
  await expect(runPackageUninstaller(process.execPath, ['-e', 'console.error("fixture removal failed");process.exit(1)'])).rejects.toThrow('fixture removal failed')
})
