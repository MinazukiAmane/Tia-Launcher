import { GAMES, type GameDefinition, type GameId } from './gameCatalog'
import silverBackground from './assets/silver-palace.jpg'
import { userError } from './userErrors'
import { t, loadLauncherLanguage, useLauncherLanguage } from './i18n'
import { useEffect, useState } from 'react'
import { migrateLegacyPreferences } from './persistence'
import { HomeScreen } from './components/HomeScreen'
import { SettingsPanel } from './components/SettingsPanel'
import { UpdateWindow } from './components/UpdateWindow'
import launcherIcon from './assets/game-icon.png'
import heroBackground from './assets/hero-background.png'



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
  useLauncherLanguage()
  const [selectedGame, setSelectedGame] = useState<GameDefinition>(GAMES[0])
  const [gameBusy, setGameBusy] = useState(false)
  const [switchingGame, setSwitchingGame] = useState(false)
  const [installDir, setInstallDir] = useState<string | null>(null)
  const [settingsScope, setSettingsScope] = useState<SettingsScope | null>(null)
  const [movingInstallation, setMovingInstallation] = useState(false)
  const [storageReady, setStorageReady] = useState(false)
  const [storageError, setStorageError] = useState<string | null>(null)
  const [userDataDir, setUserDataDir] = useState<string>('')
  const [pickError, setPickError] = useState<string | null>(null)
  const [backgroundUrl, setBackgroundUrl] = useState<string | null>(null)

  async function loadSavedData(): Promise<void> {
    setStorageReady(false)
    setStorageError(null)
    try {
      const catalog = await window.csore.getGameCatalog()
      setSelectedGame(catalog.games.find(game => game.biz === catalog.selected) ?? GAMES[0])
      await migrateLegacyPreferences()
      await loadLauncherLanguage()
      setInstallDir(await window.csore.getSelectedInstallDir())
      setStorageReady(true)
    } catch (error) {
      setStorageError(userError(error, 'storage'))
    }
  }

  useEffect(() => {
    void loadSavedData()
    window.csore.getUserDataDir().then(setUserDataDir).catch(() => {})
    window.csore.getBackground().then(setBackgroundUrl).catch(() => setBackgroundUrl(null))
  }, [])

  async function switchGame(biz: GameId): Promise<void> {
    if (switchingGame || gameBusy || movingInstallation || !storageReady) return
    setPickError(null)
    setSwitchingGame(true)
    try {
      const game = await window.csore.selectGame(biz)
      setSettingsScope(null)
      setInstallDir(null)
      setSelectedGame(game)
      setInstallDir(await window.csore.getSelectedInstallDir())
    } catch (error) { setPickError(userError(error, 'storage')) }
    finally { setSwitchingGame(false) }
  }

  function handleUninstalled(): void {
    setInstallDir(null)
  }

  function openSettings(scope: SettingsScope): void {
    if (storageReady) setSettingsScope(scope)
  }

  async function pickInstallDir(): Promise<void> {
    if (!storageReady) return
    setPickError(null)
    try {
      const chosen = await window.csore.chooseInstallFolder()
      if (!chosen) return
      setInstallDir(chosen)
    } catch (err) {
      setPickError(userError(err, 'folder'))
    }
  }

  function handleInstallationMoved(path: string): void {
    setInstallDir(path)
  }

  return (
    <div className="launcher-shell">
      <aside className="launcher-sidebar" aria-label={t("Launcher navigation")}>
        <img className="launcher-brand" src={launcherIcon} alt="Tia Launcher" draggable={false} />
        <div className="sidebar-games">
        {GAMES.map(game => <button key={game.biz} type="button" className="sidebar-game"
          disabled={movingInstallation || gameBusy || switchingGame || !storageReady}
          aria-label={game.title} aria-pressed={selectedGame.biz === game.biz}
          aria-current={selectedGame.biz === game.biz && !settingsScope ? 'page' : undefined}
          title={game.title} onClick={() => { if (game.biz === selectedGame.biz) setSettingsScope(null); else void switchGame(game.biz) }}>
          <img src={game.biz === 'cedar_global' ? silverBackground : heroBackground} alt="" draggable={false} />
          <span>{game.badge}<span>{game.biz === 'cedar_global' ? 'PALACE' : 'RSE'}</span></span>
        </button>)}
        </div>
        <button type="button" className="sidebar-library" title={t("Launcher Settings")} aria-label={t("Open launcher settings")} disabled={movingInstallation} onClick={() => openSettings('launcher')}>
          <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true"><path d="M3 3h7v7H3zm11 0h7v7h-7zM3 14h7v7H3zm11 0h7v7h-7z" /></svg>
        </button>
      </aside>
      <div className="launcher-stage">
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
        className="window-controls"
        style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
      >
        <button
          type="button"
          onClick={() => window.csore.openExternal(DONATE_URL)}
          title={t("Donate")}
          className="window-control"
        >
          <WalletIcon />
        </button>
        <button
          type="button"
          disabled={movingInstallation}
          onClick={() => openSettings('launcher')}
          title={t("Launcher Settings")}
          className="window-control"
        >
          <GearIcon />
        </button>
        <div className="mx-1 h-4 w-px bg-white/15" />
        <button
          type="button"
          onClick={() => window.csore.minimizeWindow()}
          title={t("Minimize")}
          className="window-control"
        >
          <MinimizeIcon />
        </button>
        <button
          type="button"
          disabled={movingInstallation}
          onClick={() => window.csore.closeWindow()}
          title={t("Close")}
          className="window-control window-control-close"
        >
          <CloseIcon />
        </button>
      </div>

      <HomeScreen key={selectedGame.biz} game={selectedGame} onBusyChange={setGameBusy} backgroundUrl={backgroundUrl} installDir={installDir} onNeedInstallDir={pickInstallDir} operationBusy={movingInstallation || switchingGame || !storageReady} settingsOpen={settingsScope !== null} onOpenGameSettings={() => openSettings('game')} />
      {storageError && (
        <div role="alert" className="absolute top-14 right-3 z-50 max-w-sm rounded bg-red-950 px-4 py-3 text-sm text-red-100">
          <p>{t("Could not load saved launcher data.")}</p>
          <p className="mt-2 text-xs">{t(storageError)}</p>
          <button type="button" className="mt-3 rounded bg-white/15 px-3 py-1" onClick={() => void loadSavedData()}>{t("Retry")}</button>
        </div>
      )}
      {pickError && (
        <p className="absolute top-14 right-3 z-30 max-w-xs rounded bg-red-950/80 px-3 py-2 text-xs text-red-300">
          {t(pickError)}
        </p>
      )}

      {settingsScope && (
        <SettingsPanel
          game={selectedGame}
          installDir={installDir}
          userDataDir={userDataDir}
          key={selectedGame.biz + settingsScope}
          scope={settingsScope}
          onChangeInstallDir={pickInstallDir}
          onInstallationMoved={handleInstallationMoved}
          onMoveBusyChanged={setMovingInstallation}
          onClose={() => setSettingsScope(null)}
          onUninstalled={handleUninstalled}
          onBackgroundChanged={setBackgroundUrl}
        />
      )}

      </div>
      <UpdateWindow />
    </div>
  )
}
