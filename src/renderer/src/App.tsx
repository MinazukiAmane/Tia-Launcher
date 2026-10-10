import { useEffect, useState } from 'react'
import { HomeScreen } from './components/HomeScreen'
import { SettingsPanel } from './components/SettingsPanel'
import { UpdateWindow } from './components/UpdateWindow'


const INSTALL_DIR_STORAGE_KEY = 'csore-install-dir'

export default function App(): React.JSX.Element {
  const [installDir, setInstallDir] = useState<string | null>(() =>
    localStorage.getItem(INSTALL_DIR_STORAGE_KEY)
  )
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [userDataDir, setUserDataDir] = useState<string>('')
  const [pickError, setPickError] = useState<string | null>(null)

  useEffect(() => {
    window.csore.getUserDataDir().then(setUserDataDir)
  }, [])


  function handleUninstalled(): void {
    localStorage.removeItem(INSTALL_DIR_STORAGE_KEY)
    setInstallDir(null)
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
      <div
        className="absolute top-2 right-2 z-30 flex gap-1"
        style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
      >
        <button
          type="button"
          onClick={() => window.csore.minimizeWindow()}
          className="h-6 w-6 rounded text-white/70 hover:bg-white/10"
        >
          −
        </button>
        <button
          type="button"
          onClick={() => window.csore.closeWindow()}
          className="h-6 w-6 rounded text-white/70 hover:bg-red-500/80"
        >
          ✕
        </button>
      </div>

      <HomeScreen installDir={installDir} onNeedInstallDir={pickInstallDir} />
      {pickError && (
        <p className="absolute top-14 right-3 z-30 max-w-xs rounded bg-red-950/80 px-3 py-2 text-xs text-red-300">
          {pickError}
        </p>
      )}

      <div className="absolute top-3 right-14 z-30 flex items-center gap-2">
        <button
          type="button"
          onClick={() => setSettingsOpen(true)}
          className="flex h-8 w-8 items-center justify-center rounded-full bg-white/10 text-white hover:bg-white/20"
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        >
          ⚙
        </button>
      </div>

      {settingsOpen && (
        <SettingsPanel
          installDir={installDir}
          userDataDir={userDataDir}
          onChangeInstallDir={pickInstallDir}
          onClose={() => setSettingsOpen(false)}
          onUninstalled={handleUninstalled}
        />
      )}

      <UpdateWindow />
    </div>
  )
}
