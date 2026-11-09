import { NsisUpdater } from 'electron-updater'
import { win32 } from 'node:path'
import type { StdioOptions } from 'node:child_process'
import { NativeBridge, type InstallContext } from './nativeBridge'

export class BridgeNsisUpdater extends NsisUpdater {
  private migrationArguments: string[] | null = null
  async setMigrationContext(context: InstallContext, native: NativeBridge): Promise<void> {
    this.migrationArguments = await native.windowsArguments([], context)
    this.installDirectory = undefined
  }
  protected override spawnLog(command: string, args: string[] = [], environment?: Record<string, string>, stdio?: StdioOptions): Promise<boolean> {
    const migration = this.migrationArguments
    if (migration && this.installerPath) {
      if (command === this.installerPath) args = [...args, ...migration]
      else if (win32.basename(command).toLowerCase() === 'elevate.exe' && args[0] === this.installerPath) args = [args[0], ...args.slice(1), ...migration]
    }
    return super.spawnLog(command, args, environment, stdio)
  }
}
