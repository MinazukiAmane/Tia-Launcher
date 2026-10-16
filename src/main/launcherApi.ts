
export interface PkgEntry {
  url: string
  md5: string
  size: string
  decompressed_size: string
}

export interface AudioPkgEntry extends PkgEntry {
  language: string
}

export interface VersionBlock {
  version: string
  game_pkgs: PkgEntry[]
  audio_pkgs?: AudioPkgEntry[]
  res_list_url: string
}

export interface MainBlock {
  major: VersionBlock | null
  patches: VersionBlock[]
  required_client_version: string
}

export interface GamePackageEntry {
  game: { id: string; biz: string }
  main: MainBlock
}

interface LauncherInfoResponse {
  retcode: number
  message: string
  data: { game_packages: GamePackageEntry[] } | null
}

const unavailableForPlayUntil = new Map<string, number>()

// Use a short Play timeout and cooldown during outages.
export async function fetchLauncherInfo(apiBaseUrl: string, gameBiz: string, options?: { forPlay?: boolean }): Promise<GamePackageEntry> {
 const key = apiBaseUrl + '/' + gameBiz
 if (options?.forPlay && (unavailableForPlayUntil.get(key) ?? 0) > Date.now()) {
  throw new Error('Game update service temporarily unavailable; checking installed files locally.')
 }
 try {
  const result = await requestLauncherInfo(apiBaseUrl, gameBiz, options?.forPlay ? 1 : 3, options?.forPlay ? 4000 : 10000)
  unavailableForPlayUntil.delete(key)
  return result
 } catch (error) {
  if (options?.forPlay) unavailableForPlayUntil.set(key, Date.now() + 30000)
  throw error
 }
}

async function requestLauncherInfo(apiBaseUrl: string, gameBiz: string, maxAttempts: number, timeoutMs: number): Promise<GamePackageEntry> {
  for (let attempt = 0; ; attempt++) {
    let res: Response
    let body: LauncherInfoResponse | undefined
    try {
      res = await fetch(`${apiBaseUrl}/api/launcher_info?game_biz=${encodeURIComponent(gameBiz)}`, { signal: AbortSignal.timeout(timeoutMs), cache: 'no-store' })
      if (res.ok) body = await res.json() as LauncherInfoResponse
    } catch (error) {
      if (error instanceof SyntaxError) throw new Error('launcher_info returned invalid JSON.')
      if (attempt + 1 < maxAttempts) { await new Promise(resolve => setTimeout(resolve, 250 * (attempt + 1))); continue }
      const name = (error as Error).name
      throw new Error(name === 'TimeoutError' || name === 'AbortError'
        ? `launcher_info timed out after ${maxAttempts} attempts (${timeoutMs / 1000} seconds per request). Retry when the API is available.`
        : `launcher_info could not be reached after ${maxAttempts} attempts. Check the connection and API availability.`)
    }
    if (!res.ok) {
      if (attempt + 1 < maxAttempts && [408, 429, 500, 502, 503, 504, 520, 521, 522, 523, 524].includes(res.status)) {
        void res.body?.cancel().catch(() => {})
        await new Promise(resolve => setTimeout(resolve, 250 * (attempt + 1)))
        continue
      }
      const ray = res.headers.get('cf-ray')
      throw new Error(`launcher_info request failed: HTTP ${res.status}${ray ? ` (Cloudflare Ray: ${ray})` : ''}`)
    }
    if (!body || body.retcode !== 0 || !body.data || !Array.isArray(body.data.game_packages) || body.data.game_packages.length === 0) {
      throw new Error(`launcher_info error: ${body?.message ?? 'invalid response'}`)
    }
    return body.data.game_packages[0]
  }
}
