import { resolveLaunchOptions } from './launcher/launchCommand'

export type ServerStatus = { status: 'online' | 'maintenance' | 'unknown' | 'custom'; checkedAt: string | null }
const unknown: ServerStatus = { status: 'unknown', checkedAt: null }
export function createStatusReader(baseUrl: string): (launchCommand?: string | null) => Promise<ServerStatus> {
  let cached = unknown
  let expires = 0
  let pending: Promise<ServerStatus> | undefined
  return async (launchCommand) => {
    if (hasCustomServer(launchCommand)) return { status: 'custom', checkedAt: null }
    if (Date.now() < expires) return cached
    if (pending) return pending
    pending = (async () => {
      try {
        const response = await fetch(`${baseUrl}/api/game_status`, { signal: AbortSignal.timeout(8000), cache: 'no-store' })
        if (!response.ok) throw new Error('Status unavailable')
        const value = await response.json() as ServerStatus
        const checked = Date.parse(value.checkedAt ?? '')
        if (!['online', 'maintenance', 'unknown'].includes(value.status) || !Number.isFinite(checked) || Math.abs(Date.now() - checked) > 60_000) throw new Error('Invalid status')
        cached = { status: value.status, checkedAt: value.checkedAt }
      } catch { cached = unknown }
      expires = Date.now() + 10_000
      return cached
    })()
    try { return await pending } finally { pending = undefined }
  }
}

export function hasCustomServer(command?: string | null): boolean {
  let args: string[]
  try { args = resolveLaunchOptions([], command).args } catch { return false }
  const ip = args.indexOf('-ip')
  const port = args.indexOf('-port')
  const address = ip < 0 ? '' : args[ip + 1] ?? ''
  const number = port < 0 ? '' : args[port + 1] ?? ''
  return (ip >= 0 && /^[a-zA-Z0-9.:[\]_-]+$/.test(address) && !address.startsWith('-')) ||
    (port >= 0 && /^\d+$/.test(number) && Number(number) >= 1 && Number(number) <= 65535)
}
