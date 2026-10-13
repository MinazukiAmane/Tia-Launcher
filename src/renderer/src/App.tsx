import { useEffect, useState } from 'react'
import { HomeScreen, INSTALL_CONFIRMED_STORAGE_KEY } from './components/HomeScreen'
import { SettingsPanel } from './components/SettingsPanel'
import { UpdateWindow } from './components/UpdateWindow'


const INSTALL_DIR_STORAGE_KEY = 'tia-install-dir'


const DONATE_URL = 'https://tako.id/csorseid'

type SettingsScope = 'launcher' | 'game'

function GearIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4 fill-current">
      <path d="M19.14 12.94a7.07 7.07 0 0 0 .05-.94 7.07 7.07 0 0 0-.05-.94l2.03-1.58a.5.5 0 0 0 .12-.64l-1.92-3.32a.5.5 0 0 0-.6-.22l-2.39.96a7.2 7.2 0 0 0-1.62-.94l-.36-2.54a.5.5 0 0 0-.5-.42h-3.84a.5.5 0 0 0-.5.42l-.36 2.54c-.59.24-1.13.56-1.62.94l-2.39-.96a.5.5 0 0 0-.6.22L2.67 8.84a.5.5 0 0 0 .12.64l2.03 1.58a7.07 7.07 0 0 0-.05.94c0 .32.02.63.05.94l-2.03 1.58a.5.5 0 0 0-.12.64l1.92 3.32c.14.24.42.32.6.22l2.39-.96c.49.38 1.03.7 1.62.94l.36 2.54c.04.24.26.42.5.42h3.84c.24 0 .46-.18.5-.42l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.24.1.46 0 .6-.22l1.92-3.32a.5.5 0 0 0-.12-.64zM12 15.5a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7" />
    </svg>
  )
}

function WalletIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4 stroke-current" fill="none" strokeWidth={2}>
      <path d="M3 7a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z" strokeLinejoin="round" />
      <path d="M16 12h2" strokeLinecap="round" />
      <path d="M3 9h18" />
    </svg>
  )
}

function MinimizeIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" className="h-3 w-3 stroke-current" fill="none" strokeWidth={2}>
      <path d="M5 12h14" strokeLinecap="round" />
    </svg>
  )
}

function CloseIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" className="h-3 w-3 stroke-current" fill="none" strokeWidth={2}>
      <path d="M6 6l12 12M18 6L6 18" strokeLinecap="round" />
    </svg>
  )
}

export default function App(): React.JSX.Element {
  const [installDir, setInstallDir] = useState<string | null>(() =>
    localStorage.getItem(INSTALL_DIR_STORAGE_KEY)
  )
  const [settingsScope, setSettingsScope] = useState<SettingsScope | null>(null)
  const [userDataDir, setUserDataDir] = useState<string>('')
  const [pickError, setPickError] = useState<string | null>(null)
  const [backgroundUrl, setBackgroundUrl] = useState<string | null>(null)

  useEffect(() => {
    window.csore.getUserDataDir().then(setUserDataDir)
    window.csore.getBackground().then(setBackgroundUrl).catch(() => setBackgroundUrl(null))
  }, [])


  function handleUninstalled(): void {
    localStorage.removeItem(INSTALL_DIR_STORAGE_KEY)
    localStorage.removeItem(INSTALL_CONFIRMED_STORAGE_KEY)
    setInstallDir(null)
  }

  function openSettings(scope: SettingsScope): void {
    setSettingsScope(scope)
  }

  async function pickInstallDir(): Promise<void> {
    setPickError(null)
    try {
      const chosen = await window.csore.chooseInstallFolder()
      if (!chosen) return
      localStorage.setItem(INSTALL_DIR_STORAGE_KEY, chosen)
      setInstallDir(chosen)
    } catch (err) {

      setPickError(err instanceof Error ? err.message : 'Could not use that folder.')
    }
  }

  return (
    <div className="relative">
      {/* Frameless window (see src/main/index.ts's frame: false): this
          strip is the only way to drag the window, and the buttons below
          must opt back out of the drag region to stay clickable. */}
      <div
        className="absolute top-0 left-0 right-0 h-8 z-30"
        style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
      />
      {/* One unified row, matching the reference's top bar: everything
          window-chrome-related lives together instead of being split
          into separate floating groups at slightly different heights. */}
      <div
        className="absolute top-2 right-2 z-30 flex items-center gap-1"
        style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
      >
        <button
          type="button"
          onClick={() => window.csore.openExternal(DONATE_URL)}
          title="Donate"
          className="flex h-7 w-7 items-center justify-center rounded text-white/70 hover:bg-white/10 hover:text-white"
        >
          <WalletIcon />
        </button>
        <button
          type="button"
          onClick={() => openSettings('launcher')}
          title="Launcher Settings"
          className="flex h-7 w-7 items-center justify-center rounded text-white/70 hover:bg-white/10 hover:text-white"
        >
          <GearIcon />
        </button>
        <div className="mx-1 h-4 w-px bg-white/15" />
        <button
          type="button"
          onClick={() => window.csore.minimizeWindow()}
          title="Minimize"
          className="flex h-7 w-7 items-center justify-center rounded text-white/70 hover:bg-white/10 hover:text-white"
        >
          <MinimizeIcon />
        </button>
        <button
          type="button"
          onClick={() => window.csore.closeWindow()}
          title="Close"
          className="flex h-7 w-7 items-center justify-center rounded text-white/70 hover:bg-red-500/80 hover:text-white"
        >
          <CloseIcon />
        </button>
      </div>

      <HomeScreen backgroundUrl={backgroundUrl} installDir={installDir} onNeedInstallDir={pickInstallDir} settingsOpen={settingsScope !== null} onOpenGameSettings={() => openSettings('game')} />
      {pickError && (
        <p className="absolute top-14 right-3 z-30 max-w-xs rounded bg-red-950/80 px-3 py-2 text-xs text-red-300">
          {pickError}
        </p>
      )}

      {settingsScope && (
        <SettingsPanel
          installDir={installDir}
          userDataDir={userDataDir}
          key={settingsScope}
          scope={settingsScope}
          onChangeInstallDir={pickInstallDir}
          onClose={() => setSettingsScope(null)}
          onUninstalled={handleUninstalled}
          onBackgroundChanged={setBackgroundUrl}
        />
      )}

      <UpdateWindow />
    </div>
  )
}
