import { t, changeLauncherLanguage, useLauncherLanguage } from '../i18n'
import { LAUNCHER_LANGUAGES, type LauncherLanguage } from '../launcherLanguages'
import { saveBackgroundMode } from '../backgroundFrames'
import { useEffect, useState } from 'react'
import { ProgressBar } from './ProgressBar'
import { SystemNotificationModal } from './SystemNotificationModal'
import gameIcon from '../assets/game-icon.png'


const MAX_LAUNCH_COMMAND_LENGTH = 500

function CloseIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4 stroke-current" fill="none" strokeWidth={2}>
      <path d="M6 6l12 12M18 6L6 18" strokeLinecap="round" />
    </svg>
  )
}

function GearIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4 fill-current">
      <path d="M19.14 12.94a7.07 7.07 0 0 0 .05-.94 7.07 7.07 0 0 0-.05-.94l2.03-1.58a.5.5 0 0 0 .12-.64l-1.92-3.32a.5.5 0 0 0-.6-.22l-2.39.96a7.2 7.2 0 0 0-1.62-.94l-.36-2.54a.5.5 0 0 0-.5-.42h-3.84a.5.5 0 0 0-.5.42l-.36 2.54c-.59.24-1.13.56-1.62.94l-2.39-.96a.5.5 0 0 0-.6.22L2.67 8.84a.5.5 0 0 0 .12.64l2.03 1.58a7.07 7.07 0 0 0-.05.94c0 .32.02.63.05.94l-2.03 1.58a.5.5 0 0 0-.12.64l1.92 3.32c.14.24.42.32.6.22l2.39-.96c.49.38 1.03.7 1.62.94l.36 2.54c.04.24.26.42.5.42h3.84c.24 0 .46-.18.5-.42l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.24.1.46 0 .6-.22l1.92-3.32a.5.5 0 0 0-.12-.64zM12 15.5a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7" />
    </svg>
  )
}

function ChevronIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4 stroke-current" fill="none" strokeWidth={2}>
      <path d="M9 6l6 6-6 6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function TrashIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4 stroke-current" fill="none" strokeWidth={2}>
      <path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2m2 0-1 13a1 1 0 0 1-1 1H8a1 1 0 0 1-1-1L6 7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}


type Settings = Awaited<ReturnType<typeof window.csore.getSettings>>

interface SettingsPanelProps {
  installDir: string | null
  userDataDir: string
  scope: 'launcher' | 'game'
  onChangeInstallDir: () => void
  onInstallationMoved: (path: string) => void
  onMoveBusyChanged: (busy: boolean) => void
  onClose: () => void

  onUninstalled: () => void

  onBackgroundChanged: (url: string | null) => void
}

type VerifyResult = Awaited<ReturnType<typeof window.csore.verifyInstall>>
type DWProtonStatus = Awaited<ReturnType<typeof window.csore.getDWProtonStatus>>
type SikarugirStatus = Awaited<ReturnType<typeof window.csore.getSikarugirStatus>>
type UpdateState = Awaited<ReturnType<typeof window.csore.getUpdateState>>
type Progress = { processed: number; total: number; phase: string }
type NavTab = 'launcher' | 'manage' | 'advanced' | 'logs' | 'about'

const NAV_ITEMS: { key: NavTab; label: string }[] = [
  { key: 'launcher', label: 'Launcher Settings' },
  { key: 'manage', label: 'Manage Games' },
  { key: 'advanced', label: 'Advanced Settings' },
  { key: 'logs', label: 'Launcher Logs' },
  { key: 'about', label: 'About' }
]

// Shared settings section layout.
function SectionCard({
  title,
  right,
  children
}: {
  title: string
  right?: React.ReactNode
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="settings-card">
      <h3 className="settings-card-heading">
        <span>{title}</span>
        {right}
      </h3>
      <div className="settings-card-body">{children}</div>
    </div>
  )
}


function Row({
  label,
  sublabel,
  onClick,
  disabled,
  trailing
}: {
  label: string
  sublabel?: string
  onClick?: () => void
  disabled?: boolean
  trailing?: React.ReactNode
}): React.JSX.Element {
  const content = (
    <>
      <span className="flex flex-col items-start gap-0.5 text-left">
        <span className={disabled ? 'text-white/30' : 'text-white'}>{label}</span>
        {sublabel && <span className="text-xs text-white/40">{sublabel}</span>}
      </span>
      {trailing ?? (onClick && !disabled && <ChevronIcon />)}
    </>
  )
  if (!onClick || disabled) {
    return <div className="settings-row settings-row-disabled">{content}</div>
  }
  return (
    <button
      type="button"
      onClick={onClick}
      className="settings-row"
    >
      {content}
    </button>
  )
}

function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      className="settings-toggle"
      role="switch"
      aria-checked={checked}
    >
      {checked ? t("ON") : t("OFF")}
    </button>
  )
}

export function SettingsPanel({
  installDir,
  userDataDir,
  scope,
  onChangeInstallDir,
  onInstallationMoved,
  onMoveBusyChanged,
  onClose,
  onUninstalled,
  onBackgroundChanged
}: SettingsPanelProps): React.JSX.Element {
  const launcherLanguage = useLauncherLanguage()
  const [languageBusy, setLanguageBusy] = useState(false)
  const [languageError, setLanguageError] = useState<string | null>(null)
  const [settings, setSettings] = useState<Settings | null>(null)
  const [backgroundError, setBackgroundError] = useState<string | null>(null)
  const [backgroundBusy, setBackgroundBusy] = useState(false)
  const navItems = NAV_ITEMS.filter(({ key }) =>
    scope === 'launcher' ? ['launcher', 'logs', 'about'].includes(key) : ['manage', 'advanced'].includes(key)
  )
  const [selectedTab, setActiveTab] = useState<NavTab>(scope === 'launcher' ? 'launcher' : 'manage')
  const activeTab = navItems.some(({ key }) => key === selectedTab) ? selectedTab : navItems[0].key
  const panelTitle = scope === 'launcher' ? t("Launcher Settings") : t("Game Settings")

  const [moving, setMoving] = useState(false)
  const [moveError, setMoveError] = useState<string | null>(null)
  const [moveMessage, setMoveMessage] = useState<string | null>(null)
  const [moveProgress, setMoveProgress] = useState<Parameters<Parameters<typeof window.csore.onMoveProgress>[0]>[0] | null>(null)

  async function handleMoveInstallation(): Promise<void> {
    if (!installDir || moving) return
    setMoving(true)
    onMoveBusyChanged(true)
    setMoveError(null)
    setMoveMessage(null)
    setMoveProgress(null)
    const unsubscribe = window.csore.onMoveProgress(setMoveProgress)
    try {
      const result = await window.csore.moveInstallation(installDir)
      if (result) {
        onInstallationMoved(result.installDir)
        setMoveMessage(result.warning ?? t("Installation moved successfully."))
      }
    } catch (error) {
      setMoveError(error instanceof Error ? error.message : t("Could not move the installation."))
    } finally {
      unsubscribe()
      setMoving(false)
      onMoveBusyChanged(false)
    }
  }


  const [speedLimitInput, setSpeedLimitInput] = useState('')

  // Verify/repair state
  const [verifying, setVerifying] = useState(false)
  const [verifyResult, setVerifyResult] = useState<VerifyResult | null>(null)
  const [verifyError, setVerifyError] = useState<string | null>(null)
  const [confirmingRepair, setConfirmingRepair] = useState(false)
  const [repairing, setRepairing] = useState(false)
  const [repairProgress, setRepairProgress] = useState<Progress | null>(null)
  const [repairError, setRepairError] = useState<string | null>(null)
  const [repairDone, setRepairDone] = useState(false)

  // Confirm uninstall before deleting files.
  const [confirmingUninstall, setConfirmingUninstall] = useState(false)
  const [confirmingLauncherUninstall, setConfirmingLauncherUninstall] = useState(false)
  const [removeLauncherData, setRemoveLauncherData] = useState(false)
  const [uninstallingLauncher, setUninstallingLauncher] = useState(false)
  const [launcherUninstallMessage, setLauncherUninstallMessage] = useState<string | null>(null)
  const [uninstalling, setUninstalling] = useState(false)
  const [uninstallError, setUninstallError] = useState<string | null>(null)

  // Platform-gated sections
  const [platform, setPlatform] = useState<NodeJS.Platform | null>(null)
  const [dwprotonStatus, setDwprotonStatus] = useState<DWProtonStatus | null>(null)
  const [redownloading, setRedownloading] = useState(false)
  const [redownloadProgress, setRedownloadProgress] = useState<Progress | null>(null)
  const [redownloadError, setRedownloadError] = useState<string | null>(null)
  const [sikarugirStatus, setSikarugirStatus] = useState<SikarugirStatus | null>(null)
  const [sikarugirError, setSikarugirError] = useState<string | null>(null)
  const [choosingSikarugir, setChoosingSikarugir] = useState(false)
  async function chooseSikarugirWrapper(): Promise<void> {
    setChoosingSikarugir(true)
    setSikarugirError(null)
    try {
      const selected = await window.csore.chooseSikarugirWrapper()
      if (selected) setSikarugirStatus(selected)
    } catch (err) {
      setSikarugirError(err instanceof Error ? err.message : t("Could not select the Sikarugir wrapper."))
    } finally { setChoosingSikarugir(false) }
  }

  // About tab update status and manual check.
  const [updateState, setUpdateState] = useState<UpdateState | null>(null)
  const [checkingUpdate, setCheckingUpdate] = useState(false)
  const [appVersion, setAppVersion] = useState<string | null>(null)

  // Game Logs / About "View" rows
  const [logPath, setLogPath] = useState<string | null>(null)

  // Manage Games "game version" display
  const [installedVersion, setInstalledVersion] = useState<string | null>(null)


  const [expandedAgreement, setExpandedAgreement] = useState<'tos' | 'privacy' | null>(null)

  useEffect(() => {

    window.csore.getSettings().then((s) => {
      setSettings(s)
      setSpeedLimitInput(s.downloadSpeedLimitKbps == null ? '' : String(s.downloadSpeedLimitKbps))
    })
  }, [])

  useEffect(() => {

    window.csore.getPlatform().then(setPlatform)
  }, [])

  useEffect(() => {
    if (platform === 'linux') {
      window.csore.getDWProtonStatus().then(setDwprotonStatus)
    } else if (platform === 'darwin') {
      window.csore.getSikarugirStatus().then(setSikarugirStatus)
    }
  }, [platform])

  useEffect(() => {
    window.csore.getUpdateState().then(setUpdateState)
    window.csore.getAppVersion().then(setAppVersion)
    window.csore.getLogFilePath().then(setLogPath)
  }, [])

  useEffect(() => {
    if (!installDir) {
      setInstalledVersion(null)
      return
    }
    window.csore.getInstallState(installDir).then((s) => setInstalledVersion(s?.version ?? null))
  }, [installDir])

  async function update(patch: Partial<Settings>): Promise<void> {
    if (!settings) return
    const next = { ...settings, ...patch }
    setSettings(next)
    await window.csore.setSettings(next)
  }

  function commitSpeedLimit(raw: string): void {
    const trimmed = raw.trim()
    if (trimmed === '') {
      update({ downloadSpeedLimitKbps: null })
      return
    }
    const parsed = Number(trimmed)

    if (!Number.isFinite(parsed) || parsed < 0) return
    update({ downloadSpeedLimitKbps: parsed === 0 ? null : parsed })
  }

  async function handleVerify(): Promise<void> {
    if (!installDir) return
    setVerifying(true)
    setVerifyError(null)
    setVerifyResult(null)
    setRepairDone(false)
    try {
      const result = await window.csore.verifyInstall(installDir)
      setVerifyResult(result)
      if (!result.ok) setConfirmingRepair(true)
    } catch (err) {
      setVerifyError(err instanceof Error ? err.message : t("Could not verify the install."))
    } finally {
      setVerifying(false)
    }
  }

  async function handleRepair(): Promise<void> {
    if (!installDir) return
    setConfirmingRepair(false)
    setRepairing(true)
    setRepairError(null)
    setRepairDone(false)
    setRepairProgress(null)

    const unsubscribe = window.csore.onProgress((update) => setRepairProgress(update))
    try {
      const result = await window.csore.repairInstall(installDir)
      if (result.status === 'paused') {
        setConfirmingRepair(true)
        return
      }
      setRepairDone(true)
      setVerifyResult(null)
    } catch (err) {
      setRepairError(err instanceof Error ? err.message : t("Repair failed."))
    } finally {
      unsubscribe()
      setRepairing(false)
      setRepairProgress(null)
    }
  }

  async function handleUninstallConfirmed(): Promise<void> {
    if (!installDir) return
    setUninstalling(true)
    setUninstallError(null)
    try {
      await window.csore.uninstall(installDir)
      onUninstalled()
      onClose()
    } catch (err) {
      setUninstallError(err instanceof Error ? err.message : t("Uninstall failed."))
      setUninstalling(false)
      setConfirmingUninstall(false)
    }
  }

  async function handleRedownloadDWProton(): Promise<void> {
    setRedownloading(true)
    setRedownloadError(null)
    setRedownloadProgress(null)
    const unsubscribe = window.csore.onProgress((update) => setRedownloadProgress(update))
    try {
      await window.csore.redownloadDWProton()
      const status = await window.csore.getDWProtonStatus()
      setDwprotonStatus(status)
    } catch (err) {
      setRedownloadError(err instanceof Error ? err.message : t("Could not re-download DWProton."))
    } finally {
      unsubscribe()
      setRedownloading(false)
      setRedownloadProgress(null)
    }
  }

  async function handleCheckForUpdate(): Promise<void> {
    setCheckingUpdate(true)
    try {
      await window.csore.checkForUpdate()
      setUpdateState(await window.csore.getUpdateState())
    } finally {
      setCheckingUpdate(false)
    }
  }

  async function handleViewLogs(): Promise<void> {
    await window.csore.showLogFileInFolder()
  }

  async function handleOpenInstallDir(): Promise<void> {
    if (!installDir) return
    await window.csore.showInstallDirInFolder(installDir)
  }

  return (
    <div className="settings-backdrop">
      <div role="dialog" aria-modal="true" aria-label={panelTitle} className="settings-dialog">
        {/* Left sidebar */}
        <div className="settings-sidebar">
          <div className="settings-sidebar-title">
            <GearIcon />
            {t("Settings")}</div>
          <nav className="settings-nav" aria-label={panelTitle}>
            {navItems.map((item) => (
              <button
                key={item.key}
                type="button"
                disabled={moving}
                onClick={() => setActiveTab(item.key)}
                aria-current={activeTab === item.key ? 'page' : undefined}
                className="settings-nav-item"
              >
                {t(item.label)}
              </button>
            ))}
          </nav>
        </div>

        {/* Right content */}
        <button
            type="button"
            disabled={moving}
            onClick={onClose}
            title={t("Close")}
            className="settings-close"
          >
            <CloseIcon />
          </button>
        <div className="settings-content">

          {!settings && <div className="text-white/60">{t("Loading…")}</div>}

          {settings && activeTab === 'launcher' && (
            <div className="settings-sections">
              <SectionCard title={t('Launcher Language')}>
                <label className="flex items-center justify-between gap-3 text-sm">
                  <span>{t('Launcher Language')}</span>
                  <select aria-label={t('Launcher Language')} value={launcherLanguage} disabled={languageBusy}
                    className="rounded bg-zinc-800 px-2 py-1 disabled:opacity-50"
                    onChange={async (event) => {
                      const value = event.target.value as LauncherLanguage
                      setLanguageBusy(true)
                      setLanguageError(null)
                      try { await changeLauncherLanguage(value) }
                      catch (error) { setLanguageError(error instanceof Error ? error.message : String(error)) }
                      finally { setLanguageBusy(false) }
                    }}>
                    {LAUNCHER_LANGUAGES.map(language => <option key={language.code} value={language.code}>{language.label}</option>)}
                  </select>
                </label>
                {languageError && <p role="alert" className="text-xs text-red-400">{languageError}</p>}
              </SectionCard>
              {/* Update Settings: deliberately status + manual trigger only, NOT a silent-auto-install toggle. */}
              <SectionCard title={t("Launcher Background")}>
                <p className="text-xs text-white/40">
                  {t("Choose an image or animated GIF (max 25 MB). Video mode always uses the built-in background.")}
                  </p>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    disabled={backgroundBusy}
                    onClick={async () => {
                      setBackgroundError(null)
                      setBackgroundBusy(true)
                      try {
                        const url = await window.csore.chooseBackground()
                        if (url) {
                          saveBackgroundMode('image')
                          onBackgroundChanged(url)
                        }
                      } catch (err) {
                        setBackgroundError(err instanceof Error ? err.message : t("Could not use that background."))
                      } finally {
                        setBackgroundBusy(false)
                      }
                    }}
                    className="rounded bg-white/10 px-3 py-1.5 text-sm hover:bg-white/20 disabled:opacity-60"
                  >
                    {t("Choose image…")}
                    </button>
                  <button
                    type="button"
                    disabled={backgroundBusy}
                    onClick={async () => {
                      setBackgroundError(null)
                      await window.csore.clearBackground()
                      saveBackgroundMode('image')
                      onBackgroundChanged(null)
                    }}
                    className="rounded bg-white/5 px-3 py-1.5 text-sm text-white/70 hover:bg-white/10 disabled:opacity-60"
                  >
                    {t("Reset to default")}
                    </button>
                </div>
                {backgroundError && <p className="text-xs text-red-400">{backgroundError}</p>}
              </SectionCard>

              <SectionCard title={t("Update Settings")}>
                <div className="flex items-center justify-between text-sm">
                  <span className="text-white/70">
                    {updateState?.downloaded
                      ? t("Update downloaded -- restart to install.")
                      : updateState?.available
                        ? t('Update available: v{version}', { version: updateState.available.version })
                        : updateState?.error
                          ? t('Check failed: {error}', { error: updateState.error })
                          : t("Launcher updates are checked manually -- they never auto-download or auto-install.")}
                  </span>
                  <button
                    type="button"
                    onClick={handleCheckForUpdate}
                    disabled={checkingUpdate}
                    className="rounded bg-white/10 px-3 py-1.5 text-sm hover:bg-white/20 disabled:opacity-60 flex-shrink-0"
                  >
                    {checkingUpdate ? t("Checking…") : t("Check for updates")}
                  </button>
                </div>
              </SectionCard>

              <SectionCard title={t("When Closing Window")}>
                <div className="space-y-2">
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="radio"
                      name="windowCloseBehavior"
                      checked={settings.windowCloseBehavior === 'minimize_to_tray'}
                      onChange={() => update({ windowCloseBehavior: 'minimize_to_tray' })}
                    />
                    {t("Minimize to tray")}
                    </label>
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="radio"
                      name="windowCloseBehavior"
                      checked={settings.windowCloseBehavior === 'exit'}
                      onChange={() => update({ windowCloseBehavior: 'exit' })}
                    />
                    {t("Exit launcher")}
                    </label>
                </div>
              </SectionCard>

              <SectionCard title={t("Troubleshooting")}>
                <label className="flex items-center justify-between text-sm">
                  <span>
                    {t("Troubleshooting Mode")}<span className="block text-xs text-white/40">
                      {t("Enable this to generate logs for customer support if you have trouble using the launcher or running the game.")}
                      </span>
                  </span>
                  <Toggle
                    checked={settings.troubleshootingMode}
                    onChange={(v) => update({ troubleshootingMode: v })}
                  />
                </label>
              </SectionCard>

              <SectionCard title={t("Download Speed Limit")}>
                <div className="space-y-2">
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="radio"
                      name="speedLimitMode"
                      checked={settings.downloadSpeedLimitKbps == null}
                      onChange={() => {
                        setSpeedLimitInput('')
                        update({ downloadSpeedLimitKbps: null })
                      }}
                    />
                    {t("No limit")}
                    </label>
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="radio"
                      name="speedLimitMode"
                      checked={settings.downloadSpeedLimitKbps != null}
                      onChange={() => {
                        const fallback = speedLimitInput.trim() === '' ? '4096' : speedLimitInput
                        setSpeedLimitInput(fallback)
                        commitSpeedLimit(fallback)
                      }}
                    />
                    <input
                      type="number"
                      min={100}
                      max={20480}
                      step="any"
                      inputMode="decimal"
                      disabled={settings.downloadSpeedLimitKbps == null}
                      value={speedLimitInput}
                      onChange={(e) => setSpeedLimitInput(e.target.value)}
                      onBlur={(e) => commitSpeedLimit(e.target.value)}
                      className="w-24 rounded bg-white/10 px-2 py-1 text-right disabled:opacity-40"
                    />
                    <span className="text-white/50">KB/S (100~20480)</span>
                  </label>
                </div>
              </SectionCard>
            </div>
          )}

          {settings && activeTab === 'manage' && (
            <div className="settings-sections">
              <SectionCard
                title="CSO: Re-Server Edition"
                right={
                  installDir && (
                    <button
                      type="button"
                      disabled={moving}
                      onClick={() => setConfirmingUninstall(true)}
                      className="flex items-center gap-1.5 text-xs font-normal text-white/50 hover:text-red-400"
                    >
                      <TrashIcon />
                      {t("Uninstall game")}
                      </button>
                  )
                }
              >
                <div className="flex items-center gap-3">
                  <img src={gameIcon} alt="" className="h-12 w-12 rounded-lg object-cover" />
                  <div>
                    <p className="text-sm text-white">CSO: Re-Server Edition</p>
                    <p className="text-xs text-white/40">
                      {installedVersion ? t('Game Version: {version}', { version: installedVersion }) : t("Not installed")}
                    </p>
                  </div>
                </div>
              </SectionCard>

              <SectionCard title={t("Game Install Path")}>
                <p className="truncate text-xs text-white/50">{installDir ?? t("Not installed yet")}</p>
                <Row label={t("Select another game folder")} onClick={onChangeInstallDir} disabled={moving} />
                <Row label={moving ? t("Moving installation…") : t("Move installation with all files…")} onClick={handleMoveInstallation} disabled={!installDir || moving || verifying || repairing} />
                <p className="text-xs text-white/40">{t("To move this game, choose an empty destination folder. All files move with it.")}</p>
                {moving && moveProgress && (
                  <p role="status" className="text-xs text-white/60">
                    {moveProgress.phase === 'copying' ? t("Copying files…") : moveProgress.phase === 'verifying'
                      ? t('Verifying copied files: {processed} / {total}', { processed: moveProgress.processed, total: moveProgress.total }) : t("Moving files…")}
                  </p>
                )}
                {moveError && <p className="text-xs text-red-400">{moveError}</p>}
                {moveMessage && <p className="text-xs text-white/70">{moveMessage}</p>}
                <Row label={t("Open file directory")} onClick={handleOpenInstallDir} disabled={!installDir} />
              </SectionCard>

              {}
              <SectionCard title={t("Game Launch Options")}>
                <label className="flex items-center justify-between text-sm">
                  {t("Language")}<select
                    value={settings.lang}
                    onChange={(e) => update({ lang: e.target.value as Settings['lang'] })}
                    className="rounded bg-white/10 px-2 py-1"
                  >
                    <option value="na_en">English</option>
                    <option value="na_id">Bahasa Indonesia</option>
                  </select>
                </label>

                <label className="flex items-center justify-between text-sm">
                  <span>
                    {t("Use classic UI inside the game")}<span className="block text-xs text-white/40">{t("Switches the in-game interface to the classic layout.")}
                    </span>
                  </span>
                  <input
                    type="checkbox"
                    checked={settings.classicUi}
                    onChange={(e) => update({ classicUi: e.target.checked })}
                  />
                </label>

                <label className="flex items-center justify-between text-sm">
                  <span>
                    <span className="flex items-center gap-2">
                      {t("Try new graphics renderer in-game")}<span className="rounded bg-yellow-400/20 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-yellow-300">
                        {t("Beta")}
                        </span>
                    </span>
                    <span className="block text-xs text-white/40">
                      {t("Experimental in-game renderer. Switch back if the game has issues launching.")}
                      </span>
                  </span>
                  <input
                    type="checkbox"
                    checked={settings.alternateRenderer}
                    onChange={(e) => update({ alternateRenderer: e.target.checked })}
                  />
                </label>
              </SectionCard>

              {installDir && (
                <SectionCard title={t("Verify / Repair Files")}>
                  <button
                    type="button"
                    onClick={handleVerify}
                    disabled={moving || verifying || repairing}
                    className="rounded bg-white/10 px-3 py-1.5 text-sm hover:bg-white/20 disabled:opacity-60"
                  >
                    {verifying ? t("Verifying…") : t("Check Game Integrity")}
                  </button>

                  {verifyError && <p className="text-xs text-red-400">{verifyError}</p>}
                  {verifyResult && (
                    <p className="text-xs text-white/70">
                      {verifyResult.ok
                        ? t("All files verified OK.")
                        : t('{corrupt} file(s) corrupt, {missing} file(s) missing.', { corrupt: verifyResult.corruptFiles.length, missing: verifyResult.missingFiles.length })}
                    </p>
                  )}
                  {repairing && repairProgress && (
                    <ProgressBar
                      processed={repairProgress.processed}
                      total={repairProgress.total}
                      label={t("Repairing…")}
                    />
                  )}
                  {repairError && <p className="text-xs text-red-400">{repairError}</p>}
                  {repairDone && <p className="text-xs text-white/70">{t("Repair complete.")}</p>}
                </SectionCard>
              )}

              {platform === 'linux' && (
                <SectionCard title="DWProton (Linux)">
                  <p className="text-xs text-white/50">
                    {dwprotonStatus === null
                      ? t("Checking…")
                      : dwprotonStatus.installed
                        ? t('DWProton {version} installed.', { version: dwprotonStatus.version ?? '' })
                        : t("Not installed yet -- installs automatically on first Play.")}
                  </p>
                  <button
                    type="button"
                    onClick={handleRedownloadDWProton}
                    disabled={redownloading}
                    className="rounded bg-white/10 px-3 py-1.5 text-sm hover:bg-white/20 disabled:opacity-60"
                  >
                    {redownloading ? t("Re-downloading…") : t("Re-download DWProton")}
                  </button>
                  {redownloading && redownloadProgress && (
                    <ProgressBar
                      processed={redownloadProgress.processed}
                      total={redownloadProgress.total}
                      label={t("Downloading…")}
                    />
                  )}
                  {redownloadError && <p className="text-xs text-red-400">{redownloadError}</p>}
                </SectionCard>
              )}

              {platform === 'darwin' && (
                <SectionCard title="Sikarugir (macOS)">
                  <p className="text-xs text-white/50">
                    {sikarugirStatus === null
                      ? t("Checking…")
                      : sikarugirStatus.found
                        ? t('Sikarugir wrapper selected: {path}.', { path: sikarugirStatus.wrapperPath ?? '' })
                        : t("Create a game wrapper in Sikarugir Creator, initialize its Wine engine, then select the wrapper .app below.")}
                  </p>
                  <button type="button" disabled={choosingSikarugir} onClick={chooseSikarugirWrapper}
                    className="rounded-lg bg-white/10 px-3 py-2 text-xs hover:bg-white/20 disabled:opacity-50">
                    {choosingSikarugir ? t("Selecting…") : t("Select Sikarugir wrapper")}
                  </button>
                  <p className="text-xs text-white/50">{t("macOS 14.6 or later. Apple Silicon requires Rosetta 2.")}</p>
                  <button type="button" className="text-xs text-white/70 underline" onClick={() => window.csore.openExternal('https://github.com/Sikarugir-App/Sikarugir')}>
                    {t("Sikarugir installation guide")}
                    </button>
                  {sikarugirError && <p className="text-xs text-red-400">{sikarugirError}</p>}
                </SectionCard>
              )}

              {uninstallError && <p className="text-xs text-red-400">{uninstallError}</p>}
            </div>
          )}

          {settings && activeTab === 'advanced' && (
            <div className="settings-sections">
              <SectionCard title={t("Launch Command")}>
                <textarea
                  value={settings.launchCommand ?? ''}
                  maxLength={MAX_LAUNCH_COMMAND_LENGTH}
                  onChange={(e) => update({ launchCommand: e.target.value === '' ? null : e.target.value })}
                  rows={3}
                  className="settings-command"
                />
                <div className="flex items-center justify-between text-xs text-white/40">
                  <span>{t("Game arguments, or a wrapper using %command%")}</span>
                  <span>
                    {(settings.launchCommand ?? '').length}/{MAX_LAUNCH_COMMAND_LENGTH}
                  </span>
                </div>
              </SectionCard>


            </div>
          )}

          {settings && activeTab === 'logs' && (
            <div className="settings-sections">
              <SectionCard title={t("Log Information")}>
                <Row label={t("View Launcher Logs")} sublabel={logPath ?? undefined} onClick={handleViewLogs} />
              </SectionCard>
            </div>
          )}

          {settings && activeTab === 'about' && (
            <div className="settings-sections">
              <SectionCard title={t("Launcher Version")} right={<span className="text-xs text-white/40">v{appVersion ?? '…'}</span>}>
                <Row
                  label={checkingUpdate ? t("Checking…") : t("Check for updates")}
                  onClick={handleCheckForUpdate}
                />
                {updateState?.available && (
                  <p className="text-xs text-white/50">{t('Update available: v{version}', { version: updateState.available.version })}</p>
                )}
                {updateState?.downloaded && (
                  <p className="text-xs text-white/50">{t("Update downloaded -- restart to install.")}</p>
                )}
                {updateState?.error && <p className="text-xs text-red-400">{updateState.error}</p>}
              </SectionCard>

              <SectionCard title={t("Uninstall Launcher")}>
                <Row label={t("Uninstall Tia Launcher")} onClick={() => { if (!uninstallingLauncher) setConfirmingLauncherUninstall(true) }} />
                <p className="text-xs text-white/40">
                  {t("Removes the launcher only. Game files stay where they are -- use \"Uninstall game\" in Manage Games first if you want those gone too.")}
                  </p>
                {launcherUninstallMessage && (
                  <p className="whitespace-pre-line text-xs text-white/60">{launcherUninstallMessage}</p>
                )}
              </SectionCard>

              <SectionCard title={t("Launcher Log")}>
                <Row label={t("View")} onClick={handleViewLogs} />
                {}
                <Row label={t("Submit Logs (Login Required)")} disabled />
              </SectionCard>

              <SectionCard title={t('Translation Credits')}>
                <dl className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 text-sm">
                  <dt>Bahasa Jawa</dt>
                  <dd className="text-white/70">@Rafael-Andromeda</dd>
                </dl>
              </SectionCard>

              <SectionCard title={t("Launcher Service Agreements")}>
                <div>
                  <Row
                    label={t("Game Launcher Terms of Service")}
                    onClick={() => setExpandedAgreement((v) => (v === 'tos' ? null : 'tos'))}
                  />
                  {expandedAgreement === 'tos' && (
                    <p className="mt-1 text-xs text-white/40">
                      {t("Not yet available -- this launcher doesn't have a published Terms of Service yet.")}
                      </p>
                  )}
                </div>
                <div>
                  <Row
                    label={t("Game Launcher Privacy Policy")}
                    onClick={() => setExpandedAgreement((v) => (v === 'privacy' ? null : 'privacy'))}
                  />
                  {expandedAgreement === 'privacy' && (
                    <p className="mt-1 text-xs text-white/40">
                      {t("Not yet available -- this launcher doesn't have a published Privacy Policy yet.")}
                      </p>
                  )}
                </div>
              </SectionCard>

              <div className="rounded-lg bg-white/[0.04] border border-white/5 p-5 space-y-2 text-xs">
                <p className="truncate text-white/40">{t("Launcher data:")} {userDataDir}</p>
              </div>
            </div>
          )}
        </div>
      </div>

      {confirmingLauncherUninstall && (
        <SystemNotificationModal
          title={t("System Notification")}
          confirmLabel={t("Uninstall")}
          onCancel={() => setConfirmingLauncherUninstall(false)}
          onConfirm={async () => {
            if (uninstallingLauncher) return
            setConfirmingLauncherUninstall(false)
            setUninstallingLauncher(true)
            setLauncherUninstallMessage(t("Starting uninstall… Approve the administrator prompt if shown."))
            try {
              const result = await window.csore.uninstallLauncher(removeLauncherData)
              setLauncherUninstallMessage(result.message)
            } catch (err) {
              setLauncherUninstallMessage(err instanceof Error ? err.message : t("Could not uninstall the launcher."))
            } finally { setUninstallingLauncher(false) }
          }}
        >
          <div className="space-y-3">
            <p>{t("Are you sure you want to uninstall Tia Launcher? The game files are not removed.")}</p>
            <label className="notice-check-row">
              <input
                type="checkbox"
                checked={removeLauncherData}
                onChange={(e) => setRemoveLauncherData(e.target.checked)}
              />
              {t("Also delete launcher settings and logs")}
              </label>
          </div>
        </SystemNotificationModal>
      )}

      {confirmingUninstall && (
        <SystemNotificationModal
          title={t("System Notification")}
          confirmLabel={t("Confirm")}
          confirmBusy={uninstalling}
          onCancel={() => setConfirmingUninstall(false)}
          onConfirm={handleUninstallConfirmed}
        >
          {t("We're sorry to see you go! Are you sure you want to uninstall the game?")}</SystemNotificationModal>
      )}

      {confirmingRepair && (
        <SystemNotificationModal
          title={t("Quick Repair Notice")}
          confirmLabel={t("Start Checking")}
          onCancel={() => setConfirmingRepair(false)}
          onConfirm={handleRepair}
        >
          {t("Your game installation will be scanned for missing and corrupted files. This repair process may take some time. Interrupting the process may cause file loss or corruption.")}</SystemNotificationModal>
      )}
    </div>
  )
}
