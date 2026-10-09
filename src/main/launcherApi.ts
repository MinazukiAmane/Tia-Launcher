
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

export async function fetchLauncherInfo(apiBaseUrl: string, gameBiz: string): Promise<GamePackageEntry> {
  const res = await fetch(`${apiBaseUrl}/api/launcher_info?game_biz=${encodeURIComponent(gameBiz)}`)
  if (!res.ok) throw new Error(`launcher_info request failed: HTTP ${res.status}`)
  const body = (await res.json()) as LauncherInfoResponse
  if (body.retcode !== 0 || !body.data || body.data.game_packages.length === 0) {
    throw new Error(`launcher_info error: ${body.message}`)
  }
  return body.data.game_packages[0]
}
