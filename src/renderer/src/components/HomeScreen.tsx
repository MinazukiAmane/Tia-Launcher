import { useEffect, useState } from 'react'
import heroBackground from '../assets/hero-background.png'
import { NoticesPanel } from './NoticesPanel'
import { ProgressBar } from './ProgressBar'

type ActionState = 'loading' | 'fresh_install' | 'up_to_date' | 'apply_patch' | 'working' | 'error'

interface HomeScreenProps {
  installDir: string | null
  onNeedInstallDir: () => void
}

export function HomeScreen({ installDir, onNeedInstallDir }: HomeScreenProps): React.JSX.Element {
  const [state, setState] = useState<ActionState>('loading')
  const [progress, setProgress] = useState<{ processed: number; total: number; phase: string } | null>(null)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [isMac, setIsMac] = useState(false)

  useEffect(() => {
    const unsubscribe = window.csore.onProgress((update) => {
      setProgress(update)
    })
    return unsubscribe
  }, [])

  useEffect(() => {

    window.csore.getPlatform().then((platform) => setIsMac(platform === 'darwin'))
  }, [])

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

  async function onPrimaryAction(): Promise<void> {
    if (state === 'up_to_date') {

      setErrorMessage(null)
      try {
        await window.csore.launchGame(installDir!)
      } catch (err) {
        setErrorMessage(err instanceof Error ? err.message : 'Could not launch the game.')
      }
      return
    }
    if (!installDir) {
      onNeedInstallDir()
      return
    }
    setState('working')
    setErrorMessage(null)
    try {
      await window.csore.startInstallOrUpdate(installDir)
      await refreshState()
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : 'Install/update failed.')
      setState('error')
    } finally {
      setProgress(null)
    }
  }

  const buttonLabel: Record<ActionState, string> = {
    loading: 'Loading…',
    fresh_install: 'Download',
    up_to_date: 'Play',
    apply_patch: 'Update',
    working: progress?.phase === 'applying_patch' ? 'Applying patch…' : 'Downloading…',
    error: 'Retry'
  }

  return (
    <div className="relative h-screen w-screen overflow-hidden bg-black text-white">
      {/* Hero background: gothic cathedral reference art, with a dark
          gradient overlay so the wordmark/notices (bottom-left) and the
          action button/progress bar (bottom-right) stay legible over it. */}
      <div
        className="absolute inset-0 bg-cover bg-center"
        style={{ backgroundImage: `url(${heroBackground})` }}
      />
      <div className="absolute inset-0 bg-gradient-to-t from-black via-black/40 to-black/10" />
      <div className="absolute inset-0 bg-gradient-to-r from-black/60 via-transparent to-black/30" />

      <div className="absolute bottom-8 left-8 flex flex-col gap-4">
        <h1 className="text-3xl font-bold tracking-tight drop-shadow-lg">CSORE</h1>
        <NoticesPanel />
      </div>

      <div className="absolute bottom-8 right-8 flex flex-col items-end gap-3">
        {isMac && (
          <span className="rounded-full bg-yellow-400/20 px-2 py-0.5 text-xs font-semibold tracking-wide text-yellow-300">
            Experimental (macOS)
          </span>
        )}
        {state === 'working' && progress && (
          <ProgressBar processed={progress.processed} total={progress.total} label={buttonLabel.working} />
        )}
        {errorMessage && <p className="max-w-xs text-right text-sm text-red-400">{errorMessage}</p>}
        <button
          type="button"
          disabled={state === 'loading' || state === 'working'}
          onClick={onPrimaryAction}
          className="flex h-16 w-16 items-center justify-center rounded-full bg-yellow-400 text-black font-bold shadow-lg transition hover:bg-yellow-300 disabled:opacity-60"
        >
          {state === 'up_to_date' ? '▶' : '⬇'}
        </button>
        <span className="text-sm font-medium text-white/80 drop-shadow">{buttonLabel[state]}</span>
      </div>
    </div>
  )
}
