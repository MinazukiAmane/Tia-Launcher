
import { spawn, execFile } from 'child_process'
import { promisify } from 'util'
import { join, dirname } from 'path'
import { access, mkdir, rm, rename } from 'fs/promises'
import { createHash } from 'crypto'
import { createReadStream } from 'fs'
import { pipeline } from 'stream/promises'
import { buildWrappedCommand, quoteShellArgUnix } from './launchCommand'
import { logInfo, logDebug, logError } from '../logger'

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

async function sha512OfFile(path: string): Promise<string> {
  const hash = createHash('sha512')
  await pipeline(createReadStream(path), hash)
  return hash.digest('hex')
}

// The sha512sum file format is `<hex digest>  <filename>` (coreutils-style),
// one line. We only need the digest.
function parseSha512sum(contents: string): string {
  const firstToken = contents.trim().split(/\s+/)[0]
  if (!firstToken || !/^[0-9a-f]{128}$/i.test(firstToken)) {
    throw new Error(`sha512sum file did not contain a parseable digest: ${contents.slice(0, 200)}`)
  }
  return firstToken.toLowerCase()
}

export async function verifyTarballSha512(tarballPath: string, sha512sumUrl: string): Promise<void> {
  const res = await fetch(sha512sumUrl)
  if (!res.ok) throw new Error(`failed to fetch sha512sum: HTTP ${res.status}`)
  const expected = parseSha512sum(await res.text())
  const actual = await sha512OfFile(tarballPath)
  if (actual !== expected) {
    throw new Error(
      `DWProton tarball failed sha512 verification (expected ${expected}, got ${actual}) -- refusing to extract`
    )
  }
}

export async function extractDWProtonTarball(tarballPath: string, destDir: string): Promise<void> {
  const tmpDestDir = `${destDir}.extracting-${process.pid}-${Date.now()}`
  await mkdir(tmpDestDir, { recursive: true })
  try {
    await execFileAsync('tar', ['xf', tarballPath, '-C', tmpDestDir, '--strip-components=1'])
    await mkdir(dirname(destDir), { recursive: true })
    await rm(destDir, { recursive: true, force: true })
    await rename(tmpDestDir, destDir)
  } catch (err) {
    await rm(tmpDestDir, { recursive: true, force: true })
    throw err
  }
}

export function launchLinux(
  protonDir: string,
  compatDataDir: string,
  exePath: string,
  args: string[],
  launchCommand?: string | null
): Promise<void> {
  logInfo('launchLinux: attempting launch', { exePath, protonDir })
  const env = {
    ...process.env,
    PROTONPATH: protonDir,
    GAMEID: 'csore-launcher',
    WINEPREFIX: compatDataDir
  }
  const realCommand = ['umu-run', exePath, ...args].map(quoteShellArgUnix).join(' ')
  const wrapped = buildWrappedCommand(launchCommand, realCommand)
  if (wrapped) logDebug('launchLinux: resolved launch command', { command: wrapped })

  return new Promise((resolve, reject) => {
    const child =
      wrapped === null
        ? spawn('umu-run', [exePath, ...args], {
            cwd: dirname(exePath),
            env,
            detached: true,
            stdio: 'ignore'
          })
        : spawn(wrapped, {
            cwd: dirname(exePath),
            env,
            detached: true,
            stdio: 'ignore',
            // Launch Command wrappers require a shell.
            shell: true
          })

    child.once('error', (err: NodeJS.ErrnoException) => {
      const launchErr =
        wrapped === null && err.code === 'ENOENT'
          ? new Error(
              'umu-launcher is not installed (umu-run not found on PATH). Install it from https://github.com/Open-Wine-Components/umu-launcher and try again.'
            )
          : new Error(`Could not start the game: ${err.message}`)
      logError('launchLinux: failed', { exePath, error: launchErr.message })
      reject(launchErr)
    })
    child.once('spawn', () => {
      child.unref()
      logInfo('launchLinux: succeeded', { exePath })
      resolve()
    })
  })
}
