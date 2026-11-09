import { authenticateRelease, type SignedMigrationRelease, type MigrationPublicKey, type MigrationPlatform } from './bridgeRelease'
import { handoffDatabaseKey } from './keyHandoff'
import { NativeBridge, type InstallContext } from './nativeBridge'
import type { MigrationRelease } from './bridgeRelease'

export interface BridgeDependencies<Context = InstallContext> {
  profile: string
  helper: string
  installer: string
  appId: string
  bridgeVersion: string
  targetVersion: string
  keys: MigrationPublicKey[]
  platform?: MigrationPlatform
  signedRelease: SignedMigrationRelease
  storage: { decryptString(value: Buffer): string }
  acquireOperation(): () => void
  installation(release: MigrationRelease): Promise<Context>
  install(context: Context, release: MigrationRelease): void | Promise<void>
}

export class BridgeCoordinator<Context = InstallContext> {
  private request: Promise<void> | null = null
  install(dependencies: BridgeDependencies<Context>): Promise<void> {
    if (this.request) return this.request
    const request = this.perform(dependencies)
    this.request = request
    return request.finally(() => { if (this.request === request) this.request = null })
  }
  private async perform(dependencies: BridgeDependencies<Context>): Promise<void> {
    const releaseOperation = dependencies.acquireOperation()
    try {
      const release = authenticateRelease(dependencies.signedRelease, dependencies.keys, dependencies.appId, dependencies.bridgeVersion, dependencies.targetVersion, dependencies.platform)
      const native = new NativeBridge(dependencies.helper, release.helperSha256)
      const context = await dependencies.installation(release)
      await native.verifyInstaller(dependencies.installer, release.installerSha512)
      await handoffDatabaseKey(dependencies.profile, dependencies.helper, release.helperSha256, dependencies.storage)
      // Recheck after the key handoff before allowing the installer to start.
      await native.verifyInstaller(dependencies.installer, release.installerSha512)
      await dependencies.install(context, release)
    } finally { releaseOperation() }
  }
}
