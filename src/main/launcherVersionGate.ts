import { app } from 'electron'

export type VersionStatus = 'checking' | 'current' | 'required' | 'failed'
let status: VersionStatus = 'checking'
export function setLauncherVersionStatus(value: VersionStatus): void { status = value }
export function assertLauncherCurrent(): void {
  if (!app.isPackaged || (status === 'current' || status === 'failed')) return
  throw new Error(status === 'required'
    ? 'Update the launcher to the latest version before using it.'
    : 'The launcher must verify the latest version first. Retry the update check.')
}
