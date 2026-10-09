
import { spawn, execFile } from 'child_process'
import { promisify } from 'util'
import { join } from 'path'
import { access, mkdir } from 'fs/promises'

const execFileAsync = promisify(execFile)

const DWPROTON_RELEASES_API = 'https://dawn.wine/api/v1/repos/dawn-winery/dwproton/releases?limit=1'

export interface DWProtonRelease {
  tagName: string
  downloadUrl: string
  sha512sumUrl: string
}

interface GiteaReleaseAsset {
  name: string
  browser_download_url: string
}
interface GiteaRelease {
  tag_name: string
  assets: GiteaReleaseAsset[]
}

export async function fetchLatestDWProtonRelease(
  apiUrl: string = DWPROTON_RELEASES_API
): Promise<DWProtonRelease> {
  const res = await fetch(apiUrl, { headers: { 'User-Agent': 'csore-launcher' } })
  if (!res.ok) throw new Error(`dawn.wine releases request failed: HTTP ${res.status}`)
  const releases = (await res.json()) as GiteaRelease[]
  if (releases.length === 0) throw new Error('no dwproton releases found')

  const release = releases[0]
  const tarball = release.assets.find((a) => a.name.endsWith('-x86_64.tar.xz'))
  const sha512 = release.assets.find((a) => a.name.endsWith('-x86_64.sha512sum'))
  if (!tarball || !sha512) {
    throw new Error(`release ${release.tag_name} is missing the expected x86_64 tarball/sha512sum assets`)
  }

  return {
    tagName: release.tag_name,
    downloadUrl: tarball.browser_download_url,
    sha512sumUrl: sha512.browser_download_url
  }
}

export function dwprotonInstallDir(baseDir: string, tagName: string): string {
  return join(baseDir, 'proton', tagName)
}

export async function isDWProtonInstalled(baseDir: string, tagName: string): Promise<boolean> {
  try {
    await access(join(dwprotonInstallDir(baseDir, tagName), 'proton'))
    return true
  } catch {
    return false
  }
}

export async function extractDWProtonTarball(tarballPath: string, destDir: string): Promise<void> {
  await mkdir(destDir, { recursive: true })
  await execFileAsync('tar', ['xf', tarballPath, '-C', destDir, '--strip-components=1'])
}

export function launchLinux(protonDir: string, compatDataDir: string, exePath: string, args: string[]): void {
  const child = spawn('umu-run', [exePath, ...args], {
    env: {
      ...process.env,
      PROTONPATH: protonDir,
      GAMEID: 'csore-launcher',
      WINEPREFIX: compatDataDir
    },
    detached: true,
    stdio: 'ignore'
  })
  child.unref()
}
