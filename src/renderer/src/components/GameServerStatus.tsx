import { useEffect, useState } from 'react'
import { t } from '../i18n'

export type Status = Awaited<ReturnType<typeof window.csore.getServerStatus>>['status']
const labels: Record<Status, string> = { custom: 'Custom server', online: 'Server Online', maintenance: 'Server maintenance', unknown: 'Server status unavailable' }
export function useServerStatus(enabled = true, settingsOpen = false): Status {
  const [status, setStatus] = useState<Status>('unknown')
  useEffect(() => {
    if (!enabled) { setStatus('unknown'); return }
    let stopped = false
    let timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      try {
        const result = await window.csore.getServerStatus()
        if (!stopped) setStatus(result.status)
      } catch { if (!stopped) setStatus('unknown') }
      if (!stopped) timer = setTimeout(() => { void poll() }, 10_000)
    }
    void poll()
    return () => { stopped = true; clearTimeout(timer) }
  }, [enabled, settingsOpen])
  return enabled ? status : 'unknown'
}
export function GameServerStatus({ status }: { status: Status }): React.JSX.Element {
  return <div role="status" className={`game-server-status is-${status}`} title={t('Game server availability. Play is unavailable during maintenance.')}><span aria-hidden="true" />{t(labels[status])}</div>
}
