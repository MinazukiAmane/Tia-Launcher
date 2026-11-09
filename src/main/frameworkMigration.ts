import { app, safeStorage } from 'electron'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { BridgeCoordinator } from '../../migration/electron/bridgeCoordinator'
import { readWindowsInstallContext, type InstallContext } from '../../migration/electron/installContext'
import { authenticateRelease, migrationPlatform, type SignedMigrationRelease } from '../../migration/electron/bridgeRelease'
import { readAppImageContext, replaceAppImage, type AppImageContext } from '../../migration/electron/appImageMigration'
import { readMacContext, replaceMacBundle, type MacContext } from '../../migration/electron/macMigration'
import { startMigratedAppImage } from '../../migration/electron/appImageStartup'
import keys from '../shared/migrationKeys.json'
import identities from '../../migration/installer/identity.json'
import { installLinuxPackage, linuxPackageType } from '../../migration/electron/linuxPackageBridge'

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

export async function prepareFrameworkMigration(installer: string, targetVersion: string, isBusy: () => boolean, install: (context: InstallContext) => void): Promise<void> {
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
      installation: () => readMacContext(process.execPath, identities.production.appId),
      install: async context => {
        const release = authenticateRelease(signedRelease, keys, identities.production.appId, app.getVersion(), targetVersion, platform)
        await replaceMacBundle(context, installer, release.installerSha512, targetVersion, async path => { await startMigratedAppImage(path) })
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
        install: async () => {
          await installLinuxPackage(join(process.resourcesPath, 'migration/tia-migration-helper'), installer, packageType, signedRelease)
          await startMigratedAppImage('/usr/bin/tia-launcher')
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
      installation: () => readAppImageContext(process.env.APPIMAGE),
      install: async context => {
        const release = authenticateRelease(signedRelease, keys, identities.production.appId, app.getVersion(), targetVersion, platform)
        await replaceAppImage(context, installer, release.installerSha512, async path => {
          await startMigratedAppImage(path)
        })
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
    installation: () => readWindowsInstallContext(process.execPath, identities.production.guid),
    install
  })
}
