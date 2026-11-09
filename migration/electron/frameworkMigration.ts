import { app, safeStorage } from 'electron'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { BridgeCoordinator } from './bridgeCoordinator'
import { NativeBridge, type InstallContext, type AppImageContext, type MacContext } from './nativeBridge'
import { authenticateRelease, migrationPlatform, type SignedMigrationRelease } from './bridgeRelease'
import keys from '../../src/shared/migrationKeys.json'
import identities from '../installer/identity.json'
import { installLinuxPackage, linuxPackageType } from './linuxPackageBridge'

let migrating = false
const coordinator = new BridgeCoordinator()
const appImageCoordinator = new BridgeCoordinator<AppImageContext>()
const macCoordinator = new BridgeCoordinator<MacContext>()
const packageCoordinator = new BridgeCoordinator<string>()
export function isFrameworkMigrationInProgress(): boolean { return migrating }
export function acquireFrameworkMigration(isBusy: () => boolean): () => void {
  if (migrating || isBusy()) throw new Error('Close the game and finish the current download before updating the launcher.')
  migrating = true
  return () => { migrating = false }
}

export function needsFrameworkMigration(current: string, target: string): boolean {
  return /^1\./.test(current) && Number(target.match(/^(\d+)\./)?.[1]) >= 2
}

export async function prepareFrameworkMigration(installer: string, targetVersion: string, isBusy: () => boolean, install: (context: InstallContext, release: import('./bridgeRelease').MigrationRelease) => void | Promise<void>): Promise<void> {
  if (!['win32', 'linux', 'darwin'].includes(process.platform) || !['x64', 'arm64'].includes(process.arch) || (process.platform === 'win32' && process.arch !== 'x64')) throw new Error('This launcher migration is not available for your platform yet.')
  let signedRelease: SignedMigrationRelease
  const packageType = process.platform === 'linux' && !process.env.APPIMAGE ? linuxPackageType(process.resourcesPath) : null
  try {
    const platform = migrationPlatform(process.platform, process.arch)
    let body: string
    try { body = await readFile(join(process.resourcesPath, 'migration', `release-${platform}${packageType ? `-${packageType}` : ''}.json`), 'utf8') }
    catch (error) {
      if (packageType || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      body = await readFile(join(process.resourcesPath, 'migration', 'release.json'), 'utf8')
    }
    signedRelease = JSON.parse(body)
  } catch { throw new Error('The framework migration component is missing. Reinstall the bridge release before updating.') }
  if (process.platform === 'darwin') {
    const platform = migrationPlatform(process.platform, process.arch)
    await macCoordinator.install({
      platform, profile: app.getPath('userData'), helper: join(process.resourcesPath, 'migration', 'tia-migration-helper'),
      installer, appId: identities.production.appId, bridgeVersion: app.getVersion(), targetVersion, keys, signedRelease, storage: safeStorage,
      acquireOperation: () => acquireFrameworkMigration(isBusy),
      installation: release => new NativeBridge(join(process.resourcesPath, 'migration/tia-migration-helper'), release.helperSha256).macContext(process.execPath, identities.production.appId),
      install: async context => {
        const release = authenticateRelease(signedRelease, keys, identities.production.appId, app.getVersion(), targetVersion, platform)
        await new NativeBridge(join(process.resourcesPath, 'migration/tia-migration-helper'), release.helperSha256).replaceMac(context, installer, release.installerSha512, targetVersion)
        app.quit()
      }
    })
    return
  }
  if (process.platform === 'linux') {
    const platform = migrationPlatform(process.platform, process.arch)
    if (packageType) {
      if (!installer.endsWith(`.${packageType}`)) throw new Error('The launcher update package does not match this installation.')
      await packageCoordinator.install({
        platform, profile: app.getPath('userData'), helper: join(process.resourcesPath, 'migration/tia-migration-helper'),
        installer, appId: identities.production.appId, bridgeVersion: app.getVersion(), targetVersion, keys, signedRelease, storage: safeStorage,
        acquireOperation: () => acquireFrameworkMigration(isBusy),
        installation: async () => packageType,
        install: async (_context, release) => {
          await new NativeBridge(join(process.resourcesPath, 'migration/tia-migration-helper'), release.helperSha256).preserve(async native => {
            await installLinuxPackage(join(process.resourcesPath, 'migration/tia-migration-helper'), installer, packageType, signedRelease)
            await native.start('/usr/bin/tia-launcher')
          })
          app.quit()
        }
      })
      return
    }
    await appImageCoordinator.install({
      platform,
      profile: app.getPath('userData'),
      helper: join(process.resourcesPath, 'migration', 'tia-migration-helper'),
      installer,
      appId: identities.production.appId,
      bridgeVersion: app.getVersion(),
      targetVersion,
      keys,
      signedRelease,
      storage: safeStorage,
      acquireOperation: () => acquireFrameworkMigration(isBusy),
      installation: release => {
        if (!process.env.APPIMAGE) throw new Error('Automatic migration requires an AppImage.')
        return new NativeBridge(join(process.resourcesPath, 'migration/tia-migration-helper'), release.helperSha256).appImageContext(process.env.APPIMAGE)
      },
      install: async context => {
        const release = authenticateRelease(signedRelease, keys, identities.production.appId, app.getVersion(), targetVersion, platform)
        await new NativeBridge(join(process.resourcesPath, 'migration/tia-migration-helper'), release.helperSha256).replaceAppImage(context, installer, release.installerSha512)
        app.quit()
      }
    })
    return
  }
  await coordinator.install({
    profile: app.getPath('userData'),
    helper: join(process.resourcesPath, 'migration', 'tia-migration-helper.exe'),
    installer,
    appId: identities.production.appId,
    bridgeVersion: app.getVersion(),
    targetVersion,
    keys,
    signedRelease,
    storage: safeStorage,
    acquireOperation: () => acquireFrameworkMigration(isBusy),
    installation: release => new NativeBridge(join(process.resourcesPath, 'migration/tia-migration-helper.exe'), release.helperSha256).windowsContext(process.execPath, identities.production.guid),
    install
  })
}
