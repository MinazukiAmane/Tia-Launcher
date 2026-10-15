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
    <div className="rounded-lg bg-white/[0.04] border border-white/5">
      <h3 className="flex items-center justify-between px-5 py-3 text-sm font-bold text-white border-b border-white/10">
        <span>{title}</span>
        {right}
      </h3>
      <div className="p-5 space-y-3">{children}</div>
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
    return <div className="flex items-center justify-between py-1 text-sm text-white/30">{content}</div>
  }
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center justify-between py-1 text-sm text-white/80 hover:text-white"
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
      className={`flex h-6 w-14 items-center justify-center rounded-full text-xs font-semibold transition ${
        checked ? 'bg-yellow-400 text-black' : 'bg-white/10 text-white/50'
      }`}
    >
      {checked ? 'ON' : 'OFF'}
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
  const [settings, setSettings] = useState<Settings | null>(null)
  const [backgroundError, setBackgroundError] = useState<string | null>(null)
  const [backgroundBusy, setBackgroundBusy] = useState(false)
  const navItems = NAV_ITEMS.filter(({ key }) =>
    scope === 'launcher' ? ['launcher', 'logs', 'about'].includes(key) : ['manage', 'advanced'].includes(key)
  )
  const [selectedTab, setActiveTab] = useState<NavTab>(scope === 'launcher' ? 'launcher' : 'manage')
  const activeTab = navItems.some(({ key }) => key === selectedTab) ? selectedTab : navItems[0].key
  const panelTitle = scope === 'launcher' ? 'Launcher Settings' : 'Game Settings'

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
        setMoveMessage(result.warning ?? 'Installation moved successfully.')
      }
    } catch (error) {
      setMoveError(error instanceof Error ? error.message : 'Could not move the installation.')
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
      setSikarugirError(err instanceof Error ? err.message : 'Could not select the Sikarugir wrapper.')
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
      setVerifyError(err instanceof Error ? err.message : 'Could not verify the install.')
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
      setRepairError(err instanceof Error ? err.message : 'Repair failed.')
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
      setUninstallError(err instanceof Error ? err.message : 'Uninstall failed.')
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
      setRedownloadError(err instanceof Error ? err.message : 'Could not re-download DWProton.')
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
    <div className="fixed inset-0 z-10 flex items-center justify-center bg-black/60 p-6">
      <div role="dialog" aria-modal="true" aria-label={panelTitle} className="flex h-[85vh] w-full max-w-3xl overflow-hidden rounded-xl border border-white/10 bg-zinc-950 text-white shadow-2xl">
        {/* Left sidebar */}
        <div className="flex w-48 flex-shrink-0 flex-col gap-1 bg-black/40 p-3">
          <div className="flex items-center gap-2 px-2 py-2 text-base font-semibold">
            <GearIcon />
            {panelTitle}
          </div>
          <nav className="mt-2 flex flex-col gap-1">
            {navItems.map((item) => (
              <button
                key={item.key}
                type="button"
                disabled={moving}
                onClick={() => setActiveTab(item.key)}
                className={`rounded-md px-3 py-2 text-left text-sm transition ${
                  activeTab === item.key
                    ? 'bg-white/15 text-white'
                    : 'text-white/60 hover:bg-white/5 hover:text-white'
                }`}
              >
                {item.label}
              </button>
            ))}
          </nav>
        </div>

        {/* Right content */}
        <div className="relative flex-1 overflow-y-auto p-6">
          <button
            type="button"
            disabled={moving}
            onClick={onClose}
            title="Close"
            className="absolute right-4 top-4 text-white/50 hover:text-white"
          >
            <CloseIcon />
          </button>

          {!settings && <div className="text-white/60">Loading…</div>}

          {settings && activeTab === 'launcher' && (
            <div className="space-y-4 pr-8">
              {/* Update Settings: deliberately status + manual trigger only, NOT a silent-auto-install toggle. */}
              <SectionCard title="Launcher Background">
                <p className="text-xs text-white/40">
                  Use your own image as the launcher background. PNG, JPG, WEBP and animated GIF (max 25 MB).
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
                        if (url) onBackgroundChanged(url)
                      } catch (err) {
                        setBackgroundError(err instanceof Error ? err.message : 'Could not use that image.')
                      } finally {
                        setBackgroundBusy(false)
                      }
                    }}
                    className="rounded bg-white/10 px-3 py-1.5 text-sm hover:bg-white/20 disabled:opacity-60"
                  >
                    Choose image…
                  </button>
                  <button
                    type="button"
                    disabled={backgroundBusy}
                    onClick={async () => {
                      setBackgroundError(null)
                      await window.csore.clearBackground()
                      onBackgroundChanged(null)
                    }}
                    className="rounded bg-white/5 px-3 py-1.5 text-sm text-white/70 hover:bg-white/10 disabled:opacity-60"
                  >
                    Reset to default
                  </button>
                </div>
                {backgroundError && <p className="text-xs text-red-400">{backgroundError}</p>}
              </SectionCard>

              <SectionCard title="Update Settings">
                <div className="flex items-center justify-between text-sm">
                  <span className="text-white/70">
                    {updateState?.downloaded
                      ? 'Update downloaded -- restart to install.'
                      : updateState?.available
                        ? `Update available: v${updateState.available.version}`
                        : updateState?.error
                          ? `Check failed: ${updateState.error}`
                          : 'Launcher updates are checked manually -- they never auto-download or auto-install.'}
                  </span>
                  <button
                    type="button"
                    onClick={handleCheckForUpdate}
                    disabled={checkingUpdate}
                    className="rounded bg-white/10 px-3 py-1.5 text-sm hover:bg-white/20 disabled:opacity-60 flex-shrink-0"
                  >
                    {checkingUpdate ? 'Checking…' : 'Check for updates'}
                  </button>
                </div>
              </SectionCard>

              <SectionCard title="When Closing Window">
                <div className="space-y-2">
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="radio"
                      name="windowCloseBehavior"
                      checked={settings.windowCloseBehavior === 'minimize_to_tray'}
                      onChange={() => update({ windowCloseBehavior: 'minimize_to_tray' })}
                    />
                    Minimize to tray
                  </label>
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="radio"
                      name="windowCloseBehavior"
                      checked={settings.windowCloseBehavior === 'exit'}
                      onChange={() => update({ windowCloseBehavior: 'exit' })}
                    />
                    Exit launcher
                  </label>
                </div>
              </SectionCard>

              <SectionCard title="Troubleshooting">
                <label className="flex items-center justify-between text-sm">
                  <span>
                    Troubleshooting Mode
                    <span className="block text-xs text-white/40">
                      Enable this to generate logs for customer support if you have trouble using the launcher or running the game.
                    </span>
                  </span>
                  <Toggle
                    checked={settings.troubleshootingMode}
                    onChange={(v) => update({ troubleshootingMode: v })}
                  />
                </label>
              </SectionCard>

              <SectionCard title="Download Speed Limit">
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
                    No limit
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
            <div className="space-y-4 pr-8">
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
                      Uninstall game
                    </button>
                  )
                }
              >
                <div className="flex items-center gap-3">
                  <img src={gameIcon} alt="" className="h-12 w-12 rounded-lg object-cover" />
                  <div>
                    <p className="text-sm text-white">CSO: Re-Server Edition</p>
                    <p className="text-xs text-white/40">
                      {installedVersion ? `Game Version: ${installedVersion}` : 'Not installed'}
                    </p>
                  </div>
                </div>
              </SectionCard>

              <SectionCard title="Game Install Path">
                <p className="truncate text-xs text-white/50">{installDir ?? 'Not installed yet'}</p>
                <Row label="Select another game folder" onClick={onChangeInstallDir} disabled={moving} />
                <Row label={moving ? 'Moving installation…' : 'Move installation with all files…'} onClick={handleMoveInstallation} disabled={!installDir || moving || verifying || repairing} />
                <p className="text-xs text-white/40">To move this game, choose an empty destination folder. All files move with it.</p>
                {moving && moveProgress && (
                  <p role="status" className="text-xs text-white/60">
                    {moveProgress.phase === 'copying' ? 'Copying files…' : moveProgress.phase === 'verifying'
                      ? `Verifying copied files: ${moveProgress.processed} / ${moveProgress.total}` : 'Moving files…'}
                  </p>
                )}
                {moveError && <p className="text-xs text-red-400">{moveError}</p>}
                {moveMessage && <p className="text-xs text-white/70">{moveMessage}</p>}
                <Row label="Open file directory" onClick={handleOpenInstallDir} disabled={!installDir} />
              </SectionCard>

              {}
              <SectionCard title="Game Launch Options">
                <label className="flex items-center justify-between text-sm">
                  Language
                  <select
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
                    Use classic UI inside the game
                    <span className="block text-xs text-white/40">Switches the in-game interface to the classic layout.</span>
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
                      Try new graphics renderer in-game
                      <span className="rounded bg-yellow-400/20 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-yellow-300">
                        Beta
                      </span>
                    </span>
                    <span className="block text-xs text-white/40">
                      Experimental in-game renderer. Switch back if the game has issues launching.
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
                <SectionCard title="Verify / Repair Files">
                  <button
                    type="button"
                    onClick={handleVerify}
                    disabled={moving || verifying || repairing}
                    className="rounded bg-white/10 px-3 py-1.5 text-sm hover:bg-white/20 disabled:opacity-60"
                  >
                    {verifying ? 'Verifying…' : 'Check Game Integrity'}
                  </button>

                  {verifyError && <p className="text-xs text-red-400">{verifyError}</p>}
                  {verifyResult && (
                    <p className="text-xs text-white/70">
                      {verifyResult.ok
                        ? 'All files verified OK.'
                        : `${verifyResult.corruptFiles.length} file(s) corrupt, ${verifyResult.missingFiles.length} file(s) missing.`}
                    </p>
                  )}
                  {repairing && repairProgress && (
                    <ProgressBar
                      processed={repairProgress.processed}
                      total={repairProgress.total}
                      label="Repairing…"
                    />
                  )}
                  {repairError && <p className="text-xs text-red-400">{repairError}</p>}
                  {repairDone && <p className="text-xs text-white/70">Repair complete.</p>}
                </SectionCard>
              )}

              {platform === 'linux' && (
                <SectionCard title="DWProton (Linux)">
                  <p className="text-xs text-white/50">
                    {dwprotonStatus === null
                      ? 'Checking…'
                      : dwprotonStatus.installed
                        ? `DWProton ${dwprotonStatus.version} installed.`
                        : 'Not installed yet -- installs automatically on first Play.'}
                  </p>
                  <button
                    type="button"
                    onClick={handleRedownloadDWProton}
                    disabled={redownloading}
                    className="rounded bg-white/10 px-3 py-1.5 text-sm hover:bg-white/20 disabled:opacity-60"
                  >
                    {redownloading ? 'Re-downloading…' : 'Re-download DWProton'}
                  </button>
                  {redownloading && redownloadProgress && (
                    <ProgressBar
                      processed={redownloadProgress.processed}
                      total={redownloadProgress.total}
                      label="Downloading…"
                    />
                  )}
                  {redownloadError && <p className="text-xs text-red-400">{redownloadError}</p>}
                </SectionCard>
              )}

              {platform === 'darwin' && (
                <SectionCard title="Sikarugir (macOS)">
                  <p className="text-xs text-white/50">
                    {sikarugirStatus === null
                      ? 'Checking…'
                      : sikarugirStatus.found
                        ? `Sikarugir wrapper selected: ${sikarugirStatus.wrapperPath}.`
                        : 'Create a game wrapper in Sikarugir Creator, initialize its Wine engine, then select the wrapper .app below.'}
                  </p>
                  <button type="button" disabled={choosingSikarugir} onClick={chooseSikarugirWrapper}
                    className="rounded-lg bg-white/10 px-3 py-2 text-xs hover:bg-white/20 disabled:opacity-50">
                    {choosingSikarugir ? 'Selecting…' : 'Select Sikarugir wrapper'}
                  </button>
                  <p className="text-xs text-white/50">macOS 14.6 or later. Apple Silicon requires Rosetta 2.</p>
                  <button type="button" className="text-xs text-white/70 underline" onClick={() => window.csore.openExternal('https://github.com/Sikarugir-App/Sikarugir')}>
                    Sikarugir installation guide
                  </button>
                  {sikarugirError && <p className="text-xs text-red-400">{sikarugirError}</p>}
                </SectionCard>
              )}

              {uninstallError && <p className="text-xs text-red-400">{uninstallError}</p>}
            </div>
          )}

          {settings && activeTab === 'advanced' && (
            <div className="space-y-4 pr-8">
              <SectionCard title="Launch Command">
                <textarea
                  value={settings.launchCommand ?? ''}
                  maxLength={MAX_LAUNCH_COMMAND_LENGTH}
                  onChange={(e) => update({ launchCommand: e.target.value === '' ? null : e.target.value })}
                  rows={3}
                  className="w-full resize-none rounded bg-black/40 px-3 py-2 text-sm text-white placeholder:text-white/30"
                />
                <div className="flex items-center justify-between text-xs text-white/40">
                  <span>Game arguments, or a wrapper using %command%</span>
                  <span>
                    {(settings.launchCommand ?? '').length}/{MAX_LAUNCH_COMMAND_LENGTH}
                  </span>
                </div>
              </SectionCard>


            </div>
          )}

          {settings && activeTab === 'logs' && (
            <div className="space-y-4 pr-8">
              <SectionCard title="Log Information">
                <Row label="View Launcher Logs" sublabel={logPath ?? undefined} onClick={handleViewLogs} />
              </SectionCard>
            </div>
          )}

          {settings && activeTab === 'about' && (
            <div className="space-y-4 pr-8">
              <SectionCard title="Launcher Version" right={<span className="text-xs text-white/40">v{appVersion ?? '…'}</span>}>
                <Row
                  label={checkingUpdate ? 'Checking…' : 'Check for updates'}
                  onClick={handleCheckForUpdate}
                />
                {updateState?.available && (
                  <p className="text-xs text-white/50">Update available: v{updateState.available.version}</p>
                )}
                {updateState?.downloaded && (
                  <p className="text-xs text-white/50">Update downloaded -- restart to install.</p>
                )}
                {updateState?.error && <p className="text-xs text-red-400">{updateState.error}</p>}
              </SectionCard>

              <SectionCard title="Uninstall Launcher">
                <Row label="Uninstall Tia Launcher" onClick={() => { if (!uninstallingLauncher) setConfirmingLauncherUninstall(true) }} />
                <p className="text-xs text-white/40">
                  Removes the launcher only. Game files stay where they are -- use &quot;Uninstall game&quot; in
                  Manage Games first if you want those gone too.
                </p>
                {launcherUninstallMessage && (
                  <p className="whitespace-pre-line text-xs text-white/60">{launcherUninstallMessage}</p>
                )}
              </SectionCard>

              <SectionCard title="Launcher Log">
                <Row label="View" onClick={handleViewLogs} />
                {}
                <Row label="Submit Logs (Login Required)" disabled />
              </SectionCard>

              <SectionCard title="Launcher Service Agreements">
                <div>
                  <Row
                    label="Game Launcher Terms of Service"
                    onClick={() => setExpandedAgreement((v) => (v === 'tos' ? null : 'tos'))}
                  />
                  {expandedAgreement === 'tos' && (
                    <p className="mt-1 text-xs text-white/40">
                      Not yet available -- this launcher doesn't have a published Terms of Service yet.
                    </p>
                  )}
                </div>
                <div>
                  <Row
                    label="Game Launcher Privacy Policy"
                    onClick={() => setExpandedAgreement((v) => (v === 'privacy' ? null : 'privacy'))}
                  />
                  {expandedAgreement === 'privacy' && (
                    <p className="mt-1 text-xs text-white/40">
                      Not yet available -- this launcher doesn't have a published Privacy Policy yet.
                    </p>
                  )}
                </div>
              </SectionCard>

              <div className="rounded-lg bg-white/[0.04] border border-white/5 p-5 space-y-2 text-xs">
                <p className="truncate text-white/40">Launcher data: {userDataDir}</p>
              </div>
            </div>
          )}
        </div>
      </div>

      {confirmingLauncherUninstall && (
        <SystemNotificationModal
          title="System Notification"
          confirmLabel="Uninstall"
          onCancel={() => setConfirmingLauncherUninstall(false)}
          onConfirm={async () => {
            if (uninstallingLauncher) return
            setConfirmingLauncherUninstall(false)
            setUninstallingLauncher(true)
            setLauncherUninstallMessage('Starting uninstall… Approve the administrator prompt if shown.')
            try {
              const result = await window.csore.uninstallLauncher(removeLauncherData)
              setLauncherUninstallMessage(result.message)
            } catch (err) {
              setLauncherUninstallMessage(err instanceof Error ? err.message : 'Could not uninstall the launcher.')
            } finally { setUninstallingLauncher(false) }
          }}
        >
          <div className="space-y-3">
            <p>Are you sure you want to uninstall Tia Launcher? The game files are not removed.</p>
            <label className="flex items-center gap-2 text-white/70">
              <input
                type="checkbox"
                checked={removeLauncherData}
                onChange={(e) => setRemoveLauncherData(e.target.checked)}
              />
              Also delete launcher settings and logs
            </label>
          </div>
        </SystemNotificationModal>
      )}

      {confirmingUninstall && (
        <SystemNotificationModal
          title="System Notification"
          confirmLabel="Confirm"
          confirmBusy={uninstalling}
          onCancel={() => setConfirmingUninstall(false)}
          onConfirm={handleUninstallConfirmed}
        >
          We&apos;re sorry to see you go! Are you sure you want to uninstall the game?
        </SystemNotificationModal>
      )}

      {confirmingRepair && (
        <SystemNotificationModal
          title="Quick Repair Notice"
          confirmLabel="Start Checking"
          onCancel={() => setConfirmingRepair(false)}
          onConfirm={handleRepair}
        >
          Your game installation will be scanned for missing and corrupted files. This repair process may take
          some time. Interrupting the process may cause file loss or corruption.
        </SystemNotificationModal>
      )}
    </div>
  )
}
