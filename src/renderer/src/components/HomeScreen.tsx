import { useEffect, useRef, useState } from 'react'
import heroBackground from '../assets/hero-background.png'
import { NoticesPanel, CommunityLink } from './NoticesPanel'
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
  applying_patch: 'Applying patch',
  verifying: 'Checking integrity'
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
  const [apiUnavailable, setApiUnavailable] = useState(false)
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

  // Synchronous guard: React state alone cannot block same-frame duplicate clicks.
  const actionInFlightRef = useRef(false)
  const lastKnownGameVersionRef = useRef<string | null>(null)
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
      setApiUnavailable(false)
      setState('fresh_install')
      return
    }
    // Read local installation state even when the API is unavailable.
    let localState: Awaited<ReturnType<typeof window.csore.getInstallState>>
    try {
      localState = await window.csore.getInstallState(installDir)
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : 'Could not read the installation.')
      setState('error')
      return
    }
    try {
      const info = await window.csore.getLauncherInfo()
      setApiUnavailable(false)
      lastKnownGameVersionRef.current = info.main.major?.version ?? null
      setErrorMessage(null)
      if (!localState) setState('fresh_install')
      else if (localState.needsRepair) setState('needs_repair')
      else if (localState.pendingAudioPatch) setState('apply_patch')
      else setState(localState.version === info.main.major?.version ? 'up_to_date' : 'apply_patch')
    } catch (err) {
      setApiUnavailable(true)
      if (localState && !localState.needsRepair && !localState.pendingAudioPatch) {
        setErrorMessage(null)
        setState(lastKnownGameVersionRef.current && localState.version !== lastKnownGameVersionRef.current ? 'apply_patch' : 'up_to_date')
      } else {
        setErrorMessage(err instanceof Error ? err.message : 'Could not reach the server.')
        setState(localState?.needsRepair ? 'needs_repair' : localState?.pendingAudioPatch ? 'apply_patch' : 'error')
      }
    }
  }

  useEffect(() => {
    refreshState()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [installDir])

  async function runInstallOrUpdate(): Promise<void> {
    if (!installDir || actionInFlightRef.current || operationBusy) return
    actionInFlightRef.current = true
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
      actionInFlightRef.current = false
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
      if (actionInFlightRef.current) return
      actionInFlightRef.current = true
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
        actionInFlightRef.current = false
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
    if (!installDir || actionInFlightRef.current || operationBusy) return
    actionInFlightRef.current = true
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
      actionInFlightRef.current = false
      setVerifying(false)
    }
  }

  async function handleConfirmRepair(): Promise<void> {
    if (!installDir || actionInFlightRef.current || operationBusy) return
    actionInFlightRef.current = true
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
      actionInFlightRef.current = false
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
    <div className="home-screen">
      <div
        className="home-background"
        style={{ backgroundImage: `url(${backgroundUrl ?? heroBackground})`, backgroundPosition: backgroundUrl ? 'center' : 'left center' }}
      />
      <div className="home-shade" />
      <nav className="community-rail" aria-label="Community"><CommunityLink /></nav>

      <div className="home-news">
        <NoticesPanel />
      </div>

      <div className="home-actions">
        {isMac && (
          <span className="rounded-full bg-yellow-400/20 px-2 py-0.5 text-xs font-semibold tracking-wide text-yellow-300">
            Experimental (macOS)
          </span>
        )}

        {apiUnavailable && <p role="status" className="home-toast">Game update service unavailable. Play will check your installed files locally.</p>}
        {toast && (
          <p role="status" className="home-toast">{toast}</p>
        )}
        {verifyMessage && <p role="status" className="home-toast">{verifyMessage}</p>}
        {errorMessage && <p role="alert" className="home-error">{errorMessage}</p>}

        {/* Detailed hover popup (ref/launcher-cursor-hover-ondownloading- button-change.png): phase, percent + byte counts, speed, ETA. */}
        {isHovering && verifying && !progress && (
          <div role="status" className="action-progress"><p className="progress-title">Checking integrity</p><p className="text-xs text-white/60">Verifying installed game files…</p></div>
        )}
        {isHovering && (state === 'working' || state === 'paused' || repairing || verifying) && progress && (
          <div role="status" className="action-progress">
            <p className="progress-title">{state === 'paused' ? 'Paused' : PHASE_LABEL[progress.phase] ?? progress.phase}</p>
            {hasRealTotal ? (
              <>
                <p className="progress-amount">
                  {progress.total > 0 ? Math.round((progress.processed / progress.total) * 100) : 0}%{' '}
                  <span className="text-white/50">
                    {isExtractingPhase
                      ? `(${progress.processed} / ${progress.total} files)`
                      : `(${formatBytes(progress.processed)} / ${formatBytes(progress.total)})`}
                  </span>
                </p>
                <div className="progress-track">
                  <div
                    className="progress-fill"
                    style={{
                      width: `${progress.total > 0 ? Math.min(100, (progress.processed / progress.total) * 100) : 0}%`
                    }}
                  />
                </div>
                {isDownloadingPhase && (
                  <div className="mt-3 flex items-center justify-between text-xs text-white/60">
                    <span>{state === 'paused' ? '0 B/s' : speedBps > 0 ? `${formatBytes(speedBps)}/s` : '--'}</span>
                    <span>
                      {state !== 'paused' && speedBps > 0 ? formatEta((progress.total - progress.processed) / speedBps) : '--:--:--'}
                    </span>
                  </div>
                )}
              </>
            ) : (
              <p className="mt-2 text-xs text-white/50">Working…</p>
            )}
          </div>
        )}

        <div className={`action-pill ${primaryDisabled ? 'action-pill-disabled' : ''}`}>
          <div className="primary-action-wrap" tabIndex={primaryDisabled ? 0 : undefined} aria-label={primaryDisabled ? label : undefined} onMouseEnter={() => setIsHovering(true)} onMouseLeave={() => setIsHovering(false)} onFocus={() => setIsHovering(true)} onBlur={() => setIsHovering(false)}>
            <button
              type="button"
              disabled={primaryDisabled}
              onClick={() => { if (!primaryDisabled) void onPrimaryAction() }}
              className="primary-action"
              aria-label={label}
            >
              <span className="action-icon">{renderIconWithRing()}</span>
              <span className="action-label">{label}</span>
            </button>
          </div>

          <div className="relative">
            <button
              type="button"
              onClick={() => setMenuOpen((v) => !v)}
              title="More options"
              aria-expanded={menuOpen}
              aria-controls="game-options-menu"
              className="action-menu-toggle"
            >
              {menuOpen ? <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2"><path d="m6 6 12 12M18 6 6 18" /></svg> : <BurgerIcon />}
            </button>

            {menuOpen && (
              <>
                <div className="fixed inset-0 z-10" onClick={() => setMenuOpen(false)} />
                <div id="game-options-menu" className="absolute bottom-full right-0 z-20 mb-3 w-56 overflow-hidden rounded-lg border border-white/10 bg-zinc-950 shadow-xl">
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
          <label className="renderer-option">
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
          layout="form"
          confirmLabel="Confirm"
          onCancel={() => setConfirmingInstall(false)}
          onConfirm={handleConfirmInstall}
        >
          <div className="space-y-3">
            <div>
              <p className="notice-field-label">Game Install Path</p>
              <div className="notice-path">
                <span className="flex-1 truncate">{installDir}</span>
                <button
                  type="button"
                  title="Choose a different folder"
                  onClick={() => onNeedInstallDir()}
                  className="notice-folder-button"
                >
                  <FolderIcon />
                </button>
              </div>
            </div>
            {}
            <label className="notice-check-row">
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
