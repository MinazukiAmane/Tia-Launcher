import { useEffect, useState } from 'react'
import { SystemNotificationModal } from './SystemNotificationModal'
type DeveloperState = Awaited<ReturnType<typeof window.csore.getDeveloperState>>
type Device = Awaited<ReturnType<typeof window.csore.getDeveloperDevice>>
export function DeveloperEntry(): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [code, setCode] = useState('')
  const [device, setDevice] = useState<Device | null>(null)
  const [busy, setBusy] = useState(false)
  const [preparing, setPreparing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    if (!open) return
    let active = true; setPreparing(true); setDevice(null); setError(null)
    window.csore.getDeveloperDevice().then(value => { if (active) setDevice(value) }).catch(error => { if (active) setError(error instanceof Error ? error.message : String(error)) }).finally(() => { if (active) setPreparing(false) })
    return () => { active = false }
  }, [open])
  async function verify(): Promise<void> {
    if (busy || !device || !code) return
    setBusy(true); setError(null)
    try { await window.csore.unlockDeveloper(code); setCode(''); setOpen(false) }
    catch (error) { setError(error instanceof Error ? error.message : 'Developer verification failed.'); setCode('') }
    finally { setBusy(false) }
  }
  return <>
    <button type="button" tabIndex={-1} aria-label="Developer access" onClick={() => setOpen(true)} className="absolute left-1/2 top-0 z-40 h-4 w-10 -translate-x-1/2 bg-transparent" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties} />
    {open && <SystemNotificationModal title="Developer Access" confirmLabel="Verify" confirmDisabled={!device || !code || preparing} confirmBusy={busy} onCancel={() => { if (!busy) { setOpen(false); setCode('') } }} onConfirm={verify}>
      <div role="dialog" aria-label="Developer Access" className="space-y-3">
        {preparing && <p>Preparing hardware device…</p>}
        {device && <>
          <p className="text-xs">{device.provider}</p>
          <label className="block text-xs">Device ID<input readOnly value={device.deviceId} className="mt-1 w-full rounded bg-black/40 px-2 py-2 font-mono text-xs text-white/70" /></label>
          <label className="block">Developer code<input autoFocus type="password" autoComplete="off" maxLength={128} value={code} disabled={busy} onChange={event => setCode(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') void verify() }} className="mt-2 w-full rounded border border-white/15 bg-black/40 px-3 py-2 text-white outline-none focus:border-yellow-400" /></label>
        </>}
        {error && <p role="alert" className="text-xs text-red-400">{error}</p>}
      </div>
    </SystemNotificationModal>}
  </>
}
export function DeveloperSettings(): React.JSX.Element | null {
  const [state, setState] = useState<DeveloperState | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    window.csore.getDeveloperState().then(setState).catch(() => {})
    return window.csore.onDeveloperState(setState)
  }, [])
  if (!state?.unlocked) return null
  async function update(enabled: boolean): Promise<void> {
    setBusy(true); setError(null)
    try { setState(await window.csore.setDeveloperApiChecks(enabled)) }
    catch (error) { setError(error instanceof Error ? error.message : String(error)); setState(await window.csore.getDeveloperState()) }
    finally { setBusy(false) }
  }
  return <div className="rounded-lg border border-yellow-400/25 bg-yellow-400/5 p-5 space-y-3">
    <div className="flex justify-between items-center"><h3 className="font-bold text-yellow-400">Developer Options</h3><button type="button" disabled={busy} onClick={() => window.csore.lockDeveloper().then(setState)} className="text-xs text-white/50 hover:text-white">Lock</button></div>
    <label className="flex items-center gap-3 text-sm"><input type="checkbox" checked={state.checkApi} disabled={busy} onChange={event => update(event.target.checked)} />Check game API / integrity before Play</label>
    <p className="text-xs text-white/50">OFF allows the selected local client to launch without game version or integrity checks. Language and Launch Command stay the same.</p>
    <p className="text-xs text-white/40">Authorization expires at {new Date(state.expiresAt!).toLocaleTimeString()}. Restarting the launcher locks developer access.</p>
    {error && <p className="text-xs text-red-400">{error}</p>}
  </div>
}
