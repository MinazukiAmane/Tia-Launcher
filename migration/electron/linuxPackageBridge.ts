import { spawn } from 'node:child_process'
import type { SignedMigrationRelease } from './bridgeRelease'
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

export async function installLinuxPackage(helper: string, artifact: string, kind: LinuxPackageType, release: SignedMigrationRelease): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn('/usr/bin/pkexec', ['--disable-internal-agent', helper, '--install-linux-package-stdin'], { stdio: ['pipe', 'pipe', 'pipe'] })
    let diagnostic = ''
    child.stdout.on('data', () => {})
    child.stderr.on('data', (chunk: Buffer) => { diagnostic = (diagnostic + chunk.toString()).slice(-4096) })
    child.on('error', reject)
    child.stdin.on('error', () => {})
    child.on('close', code => code === 0 ? resolve() : reject(new Error(code === 126 || code === 127 ? 'Approve the system update prompt to finish updating the launcher.' : `The launcher package could not be installed. ${diagnostic.trim()}`)))
    child.stdin.end(JSON.stringify({ artifact, kind, release }))
  })
}
