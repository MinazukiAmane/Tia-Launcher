import { useEffect, useRef, useState } from 'react'
import heroBackground from '../assets/hero-background.png'
import { NoticesPanel } from './NoticesPanel'
import { SystemNotificationModal } from './SystemNotificationModal'


type ActionState = 'loading' | 'needs_repair' | 'fresh_install' | 'up_to_date' | 'apply_patch' | 'working' | 'paused' | 'error'


type Settings = Awaited<ReturnType<typeof window.csore.getSettings>>

function PlayIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5 translate-x-[1px] fill-current">
      <path d="M8 5v14l11-7z" />
    </svg>
  )
}

function DownloadIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5 stroke-current" fill="none" strokeWidth={2.5}>
      <path d="M12 3v12" strokeLinecap="round" />
      <path d="M7 10l5 5 5-5" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M5 20h14" strokeLinecap="round" />
    </svg>
  )
}

function PauseIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5 fill-current">
      <rect x="6" y="5" width="4" height="14" rx="1" />
      <rect x="14" y="5" width="4" height="14" rx="1" />
    </svg>
  )
}

function BurgerIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5 stroke-current" fill="none" strokeWidth={2}>
      <path d="M4 7h16M4 12h16M4 17h16" strokeLinecap="round" />
    </svg>
  )
}


export const INSTALL_CONFIRMED_STORAGE_KEY = 'tia-install-path-confirmed'

function isInstallPathConfirmed(dir: string): boolean {
  try {
    return localStorage.getItem(INSTALL_CONFIRMED_STORAGE_KEY) === dir
  } catch {
    return false
  }
}

function FolderIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4 stroke-current" fill="none" strokeWidth={2}>
      <path
        d="M4 6a1 1 0 0 1 1-1h4l2 2h8a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6z"
        strokeLinejoin="round"
      />
    </svg>
  )
}

// Format byte counts for download progress.
function formatBytes(n: number): string {
  if (n < 1024) return `${Math.round(n)} B`
  const kb = n / 1024
  if (kb < 1024) return `${kb.toFixed(1)} KB`
  const mb = kb / 1024
  if (mb < 1024) return `${mb.toFixed(1)} MB`
  const gb = mb / 1024
  return `${gb.toFixed(2)} GB`
}

function formatEta(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '--:--:--'
  const s = Math.round(seconds)
  const hh = Math.floor(s / 3600)
  const mm = Math.floor((s % 3600) / 60)
  const ss = s % 60
  return [hh, mm, ss].map((v) => String(v).padStart(2, '0')).join(':')
}

const PHASE_LABEL: Record<string, string> = {
  downloading: 'Downloading',
  downloading_audio: 'Downloading voice pack',
  assembling: 'Preparing files',
  assembling_audio: 'Preparing voice pack',
  extracting: 'Extracting',
  extracting_audio: 'Extracting voice pack',
  applying_patch: 'Applying patch'
}

interface HomeScreenProps {
  installDir: string | null
  // Player's custom launcher background (data: URL), or null for the default.
  backgroundUrl: string | null
  onNeedInstallDir: () => void
  operationBusy: boolean
  settingsOpen: boolean
  onOpenGameSettings: () => void
}

export function HomeScreen({ installDir, backgroundUrl, onNeedInstallDir, operationBusy, settingsOpen, onOpenGameSettings }: HomeScreenProps): React.JSX.Element {
  const [state, setState] = useState<ActionState>('loading')
  const [progress, setProgress] = useState<{ processed: number; total: number; phase: string } | null>(null)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [isMac, setIsMac] = useState(false)
  const [isHovering, setIsHovering] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [settings, setSettings] = useState<Settings | null>(null)
  const [speedBps, setSpeedBps] = useState(0)


  // shown before a FRESH install's download actually starts.
  const [confirmingInstall, setConfirmingInstall] = useState(false)
  const [createShortcut, setCreateShortcut] = useState(false)


  const [verifying, setVerifying] = useState(false)
  const [verifyMessage, setVerifyMessage] = useState<string | null>(null)
  const [confirmingRepair, setConfirmingRepair] = useState(false)
  const [repairing, setRepairing] = useState(false)
  const [toast, setToast] = useState<string | null>(null)

  const lastSampleRef = useRef<{ processed: number; time: number } | null>(null)


  const pausedOperationRef = useRef<'install' | 'repair' | null>(null)

  useEffect(() => {
    const unsubscribe = window.csore.onProgress((update) => {
      setProgress(update)
    })
    return unsubscribe
  }, [])


  useEffect(() => {
    if (!progress || (progress.phase !== 'downloading' && progress.phase !== 'downloading_audio')) {
      lastSampleRef.current = null
      setSpeedBps(0)
      return
    }
    const now = Date.now()
    const last = lastSampleRef.current
    if (last && now > last.time) {
      const deltaBytes = progress.processed - last.processed
      const deltaSeconds = (now - last.time) / 1000
      if (deltaBytes >= 0 && deltaSeconds > 0.05) {
        const instantaneous = deltaBytes / deltaSeconds
        // Simple smoothing so the number doesn't jitter wildly between
        // individual progress ticks.
        setSpeedBps((prev) => (prev === 0 ? instantaneous : prev * 0.7 + instantaneous * 0.3))
      }
    }
    lastSampleRef.current = { processed: progress.processed, time: now }
  }, [progress])

  useEffect(() => {
    window.csore.getPlatform().then((platform) => setIsMac(platform === 'darwin'))
  }, [])

  useEffect(() => {
    window.csore.getSettings().then(setSettings)
  }, [])

  useEffect(() => {
    if (settingsOpen) setMenuOpen(false)
  }, [settingsOpen])

  async function refreshState(): Promise<void> {
    if (!installDir) {
      setState('fresh_install')
      return
    }
    try {
      const info = await window.csore.getLauncherInfo()
      const installState = await window.csore.getInstallState(installDir)
      if (!installState) {
        setState('fresh_install')
      } else if (installState.needsRepair) {
        setState('needs_repair')
      } else if (installState.pendingAudioPatch) {
        setState('apply_patch')
      } else if (installState.version === info.main.major?.version) {
        setState('up_to_date')
      } else {
        setState('apply_patch')
      }
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : 'Could not reach the server.')
      setState('error')
    }
  }

  useEffect(() => {
    refreshState()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [installDir])

  useEffect(() => window.csore.onDeveloperState(() => {
    if (state !== 'working' && !verifying && !repairing && !operationBusy) void refreshState()
  }), [installDir, state, verifying, repairing, operationBusy])

  async function runInstallOrUpdate(): Promise<void> {
    if (!installDir) return
    setState('working')
    setErrorMessage(null)

    let paused = false

    pausedOperationRef.current = 'install'
    try {
      const result = await window.csore.startInstallOrUpdate(installDir)
      if (result.status === 'paused') {
        paused = true
        setState('paused')
      } else {
        pausedOperationRef.current = null
        await refreshState()
      }
    } catch (err) {
      pausedOperationRef.current = null
      setErrorMessage(err instanceof Error ? err.message : 'Install/update failed.')
      setState('error')
    } finally {
      if (!paused) setProgress(null)
    }
  }

  async function onPrimaryAction(): Promise<void> {
    if (primaryDisabled) return
    if (state === 'needs_repair') {
      await handleCheckIntegrity()
      return
    }
    if (state === 'up_to_date') {
      setErrorMessage(null)

      setVerifying(true)
      try {
        const result = await window.csore.launchGame(installDir!)
        if (!result.launched) {
          // Use the same repair prompt for manual and pre-launch verification.
          setConfirmingRepair(true)
        }
      } catch (err) {
        setErrorMessage(err instanceof Error ? err.message : 'Could not launch the game.')
      } finally {
        setVerifying(false)
      }
      return
    }
    if (state === 'working') {

      await window.csore.pauseInstallOrUpdate()
      return
    }
    if (state === 'paused') {

      if (pausedOperationRef.current === 'repair') {
        await handleConfirmRepair()
      } else {
        await runInstallOrUpdate()
      }
      return
    }
    if (!installDir) {
      onNeedInstallDir()
      return
    }
    if (state === 'fresh_install') {
      // Confirm the destination before downloading.
      if (isInstallPathConfirmed(installDir)) {
        await runInstallOrUpdate()
        return
      }
      setConfirmingInstall(true)
      return
    }
    await runInstallOrUpdate()
  }

  async function handleConfirmInstall(): Promise<void> {
    setConfirmingInstall(false)
    try {
      if (installDir) localStorage.setItem(INSTALL_CONFIRMED_STORAGE_KEY, installDir)
    } catch {
      // storage unavailable: worst case the dialog shows again next time
    }
    await runInstallOrUpdate()
  }

  async function toggleAlternateRenderer(checked: boolean): Promise<void> {
    if (!settings) return
    const next = { ...settings, alternateRenderer: checked }
    setSettings(next)
    await window.csore.setSettings(next)
  }

  async function handleCheckIntegrity(): Promise<void> {
    setMenuOpen(false)
    if (!installDir) return
    setVerifying(true)
    setVerifyMessage(null)
    try {
      const result = await window.csore.verifyInstall(installDir)
      if (result.ok) {
        setVerifyMessage('All files verified OK.')
        await refreshState()
        setTimeout(() => setVerifyMessage(null), 4000)
      } else {
        setConfirmingRepair(true)
      }
    } catch (err) {
      setVerifyMessage(err instanceof Error ? err.message : 'Could not verify the install.')
    } finally {
      setVerifying(false)
    }
  }

  async function handleConfirmRepair(): Promise<void> {
    if (!installDir) return
    setConfirmingRepair(false)
    setRepairing(true)
    setState('working')

    let paused = false
    pausedOperationRef.current = 'repair'
    try {
      const result = await window.csore.repairInstall(installDir)
      if (result.status === 'paused') {
        paused = true
        setState('paused')
      } else {
        pausedOperationRef.current = null
        await refreshState()
      }
    } catch (err) {
      pausedOperationRef.current = null
      setErrorMessage(err instanceof Error ? err.message : 'Repair failed.')
      setState('error')
    } finally {
      setRepairing(false)
      if (!paused) setProgress(null)
    }
  }

  async function handleClearCache(): Promise<void> {
    setMenuOpen(false)
    if (!installDir) return
    try {
      await window.csore.clearDownloadCache(installDir)
      setToast('Download cache cleared.')
    } catch {
      setToast('Could not clear the download cache.')
    } finally {
      setTimeout(() => setToast(null), 3000)
    }
  }

  function handleCreateShortcutClick(): void {
    setMenuOpen(false)

    setToast('Desktop shortcuts are not available yet.')
    setTimeout(() => setToast(null), 3000)
  }

  const isDownloadingPhase = progress?.phase === 'downloading' || progress?.phase === 'downloading_audio'
  const isAssemblingPhase = progress?.phase === 'assembling' || progress?.phase === 'assembling_audio'
  const isExtractingPhase = progress?.phase === 'extracting' || progress?.phase === 'extracting_audio'
  const hasRealTotal = isDownloadingPhase || isAssemblingPhase || isExtractingPhase

  const idleLabel: Record<ActionState, string> = {
    loading: 'Loading…',
    fresh_install: 'Download',
    needs_repair: 'Verify / Repair',
    up_to_date: 'Play',
    apply_patch: 'Update',
    working: 'Downloading',
    paused: 'Paused',
    error: 'Retry'
  }

  const hoverLabel: Record<ActionState, string> = {
    ...idleLabel,
    working: 'Pause',
    paused: 'Resume'
  }

  const primaryDisabled = operationBusy || state === 'loading' || verifying || (state === 'working' && !isDownloadingPhase)
  const label = verifying
    ? 'Checking Integrity'
    : primaryDisabled && state === 'working'
      ? (progress ? PHASE_LABEL[progress.phase] ?? progress.phase : 'Working…')
      : isHovering ? hoverLabel[state] : idleLabel[state]

  function renderIcon(): React.JSX.Element {
    if (state === 'up_to_date') return <PlayIcon />
    if (state === 'working') return isHovering && !primaryDisabled ? <PauseIcon /> : <DownloadIcon />
    if (state === 'paused') return isHovering ? <PlayIcon /> : <PauseIcon />
    return <DownloadIcon />
  }


  const ringFraction =
    progress && progress.total > 0 && hasRealTotal ? Math.min(1, progress.processed / progress.total) : null
  const showRing = (state === 'working' || state === 'paused' || repairing) && ringFraction !== null

  function renderIconWithRing(): React.JSX.Element {
    if (!showRing || ringFraction === null) return renderIcon()
    const r = 11
    const c = 2 * Math.PI * r
    return (
      <span className="relative flex h-7 w-7 items-center justify-center">
        <svg viewBox="0 0 28 28" className="absolute inset-0 h-7 w-7 -rotate-90" fill="none" strokeWidth={2.5}>
          <circle cx="14" cy="14" r={r} className="stroke-black/20" />
          <circle
            cx="14"
            cy="14"
            r={r}
            className="stroke-black"
            strokeLinecap="round"
            strokeDasharray={c}
            strokeDashoffset={c * (1 - ringFraction)}
          />
        </svg>
        <span className="flex scale-75 items-center justify-center">{renderIcon()}</span>
      </span>
    )
  }

  return (
    <div className="relative h-screen w-screen overflow-hidden bg-black text-white">
      <div
        className="absolute inset-0 bg-cover bg-center"
        style={{ backgroundImage: `url(${backgroundUrl ?? heroBackground})` }}
      />
      <div className="absolute inset-0 bg-gradient-to-t from-black via-black/40 to-black/10" />
      <div className="absolute inset-0 bg-gradient-to-r from-black/60 via-transparent to-black/30" />

      <div className="absolute bottom-8 left-8 flex flex-col gap-4">
        <h1 className="text-3xl font-bold tracking-tight drop-shadow-lg">CSO: Re-Server Edition</h1>
        <NoticesPanel />
      </div>

      <div className="absolute bottom-8 right-8 flex flex-col items-end gap-3">
        {isMac && (
          <span className="rounded-full bg-yellow-400/20 px-2 py-0.5 text-xs font-semibold tracking-wide text-yellow-300">
            Experimental (macOS)
          </span>
        )}

        {toast && (
          <p className="max-w-xs rounded bg-black/70 px-3 py-1.5 text-right text-xs text-white/80">{toast}</p>
        )}
        {verifying && <p className="text-xs text-white/60">Checking game integrity…</p>}
        {verifyMessage && <p className="text-xs text-white/70">{verifyMessage}</p>}
        {errorMessage && <p className="max-w-xs text-right text-sm text-red-400">{errorMessage}</p>}

        {/* Detailed hover popup (ref/launcher-cursor-hover-ondownloading- button-change.png): phase, percent + byte counts, speed, ETA. */}
        {isHovering && verifying && !progress && (
          <div className="w-72 rounded-lg border border-white/10 bg-zinc-950/95 p-4 shadow-xl">Checking game integrity…</div>
        )}
        {isHovering && (state === 'working' || repairing || verifying) && progress && (
          <div className="w-72 rounded-lg border border-white/10 bg-zinc-950/95 p-4 shadow-xl">
            <p className="text-sm font-semibold text-white">{PHASE_LABEL[progress.phase] ?? progress.phase}</p>
            {hasRealTotal ? (
              <>
                <p className="mt-2 text-sm text-white">
                  {progress.total > 0 ? Math.round((progress.processed / progress.total) * 100) : 0}%{' '}
                  <span className="text-white/50">
                    {isExtractingPhase
                      ? `(${progress.processed} / ${progress.total} files)`
                      : `(${formatBytes(progress.processed)} / ${formatBytes(progress.total)})`}
                  </span>
                </p>
                <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-white/10">
                  <div
                    className="h-full rounded-full bg-yellow-400"
                    style={{
                      width: `${progress.total > 0 ? Math.min(100, (progress.processed / progress.total) * 100) : 0}%`
                    }}
                  />
                </div>
                {isDownloadingPhase && (
                  <div className="mt-3 flex items-center justify-between text-xs text-white/60">
                    <span>{speedBps > 0 ? `${formatBytes(speedBps)}/S` : '--'}</span>
                    <span>
                      {speedBps > 0 ? formatEta((progress.total - progress.processed) / speedBps) : '--:--:--'}
                    </span>
                  </div>
                )}
              </>
            ) : (
              <p className="mt-2 text-xs text-white/50">Working…</p>
            )}
          </div>
        )}

        <div className="flex items-center gap-2">
          <div onMouseEnter={() => setIsHovering(true)} onMouseLeave={() => setIsHovering(false)}>
            <button
              type="button"
              disabled={primaryDisabled}
              onClick={() => { if (!primaryDisabled) void onPrimaryAction() }}
              className="flex h-11 items-center gap-2 rounded-full bg-yellow-400 px-5 text-sm font-bold text-black shadow-lg transition hover:bg-yellow-300 disabled:bg-zinc-700 disabled:text-white/50 disabled:cursor-not-allowed"
            >
              {renderIconWithRing()}
              {label}
            </button>
          </div>

          <div className="relative">
            <button
              type="button"
              onClick={() => setMenuOpen((v) => !v)}
              title="More options"
              className="flex h-11 w-11 items-center justify-center rounded-full border border-white/10 bg-black/60 text-white/80 hover:bg-white/10 hover:text-white"
            >
              <BurgerIcon />
            </button>

            {menuOpen && (
              <>
                <div className="fixed inset-0 z-10" onClick={() => setMenuOpen(false)} />
                <div className="absolute bottom-full right-0 z-20 mb-2 w-56 overflow-hidden rounded-lg border border-white/10 bg-zinc-950 shadow-xl">
                  <button
                    type="button"
                    onClick={() => {
                      setMenuOpen(false)
                      onOpenGameSettings()
                    }}
                    className="block w-full px-4 py-2.5 text-left text-sm text-white hover:bg-white/10"
                  >
                    Game Settings
                  </button>
                  <button
                    type="button"
                    onClick={handleCreateShortcutClick}
                    className="block w-full px-4 py-2.5 text-left text-sm text-white hover:bg-white/10"
                  >
                    Create Desktop Shortcut
                  </button>
                  <button
                    type="button"
                    disabled={!installDir || verifying}
                    onClick={handleCheckIntegrity}
                    className="block w-full px-4 py-2.5 text-left text-sm text-white hover:bg-white/10 disabled:cursor-not-allowed disabled:text-white/30 disabled:hover:bg-transparent"
                  >
                    Check Game Integrity
                  </button>
                  <button
                    type="button"
                    onClick={handleClearCache}
                    className="block w-full px-4 py-2.5 text-left text-sm text-white hover:bg-white/10"
                  >
                    Clear Download Cache
                  </button>
                </div>
              </>
            )}
          </div>
        </div>

        {settings && (
          <label className="flex items-center gap-2 text-xs text-white/70 drop-shadow">
            <input
              type="checkbox"
              checked={settings.alternateRenderer}
              onChange={(e) => toggleAlternateRenderer(e.target.checked)}
            />
            Try new graphics renderer in-game (Beta)
          </label>
        )}
      </div>

      {confirmingInstall && installDir && (
        <SystemNotificationModal
          title="System Notification"
          confirmLabel="Confirm"
          onCancel={() => setConfirmingInstall(false)}
          onConfirm={handleConfirmInstall}
        >
          <div className="space-y-3">
            <div>
              <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-white/40">Game Install Path</p>
              <div className="flex items-center gap-2 rounded bg-white/5 px-3 py-2 text-white/80">
                <span className="flex-1 truncate">{installDir}</span>
                <button
                  type="button"
                  title="Choose a different folder"
                  onClick={() => onNeedInstallDir()}
                  className="flex h-7 w-7 items-center justify-center rounded text-white/80 hover:bg-white/10 hover:text-white"
                >
                  <FolderIcon />
                </button>
              </div>
            </div>
            {}
            <label className="flex items-center gap-2 text-white/70">
              <input
                type="checkbox"
                checked={createShortcut}
                onChange={(e) => setCreateShortcut(e.target.checked)}
              />
              Create desktop shortcut
            </label>
          </div>
        </SystemNotificationModal>
      )}

      {confirmingRepair && (
        <SystemNotificationModal
          title="Quick Repair Notice"
          confirmLabel="Start Checking"
          onCancel={() => setConfirmingRepair(false)}
          onConfirm={handleConfirmRepair}
        >
          Your game installation will be scanned for missing and corrupted files. This repair process may take
          some time. Interrupting the process may cause file loss or corruption.
        </SystemNotificationModal>
      )}
    </div>
  )
}
