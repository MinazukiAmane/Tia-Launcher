import { DebUpdater, PacmanUpdater } from 'electron-updater'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export type LinuxPackageType = 'deb' | 'pacman'

export function linuxPackageType(resources: string): LinuxPackageType | null {
  try {
    const type = readFileSync(join(resources, 'package-type'), 'utf8').trim()
    return type === 'deb' || type === 'pacman' ? type : null
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

export class BridgeDebUpdater extends DebUpdater {
  installNativePackage(): boolean {
    this.quitAndInstallCalled = false
    return this.install(true, false)
  }
}

export class BridgePacmanUpdater extends PacmanUpdater {
  installNativePackage(): boolean {
    this.quitAndInstallCalled = false
    return this.install(true, false)
  }
}
