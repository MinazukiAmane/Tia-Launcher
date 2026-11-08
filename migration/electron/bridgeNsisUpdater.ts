import { NsisUpdater } from 'electron-updater'
import { win32 } from 'node:path'
import type { StdioOptions } from 'node:child_process'
import { preserveInstallScope, type InstallContext } from './installContext'

export class BridgeNsisUpdater extends NsisUpdater {
  private migrationContext: InstallContext | null = null
  setMigrationContext(context: InstallContext): void {
    this.migrationContext = context
    this.installDirectory = context.directory
  }
  protected override spawnLog(command: string, args: string[] = [], environment?: Record<string, string>, stdio?: StdioOptions): Promise<boolean> {
    const context = this.migrationContext
    if (context && this.installerPath) {
      if (command === this.installerPath) args = preserveInstallScope(args, context)
      else if (win32.basename(command).toLowerCase() === 'elevate.exe' && args[0] === this.installerPath) args = [args[0], ...preserveInstallScope(args.slice(1), context)]
    }
    return super.spawnLog(command, args, environment, stdio)
  }
}
