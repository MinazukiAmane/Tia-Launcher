import { useEffect, useState } from 'react'
import { ProgressBar } from './ProgressBar'

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


interface Settings {
  lang: 'na_id' | 'na_en'
  classicUi: boolean
  alternateRenderer: boolean
  downloadSpeedLimitKbps: number | null
  launchCommand: string | null
  troubleshootingMode: boolean
  windowCloseBehavior: 'minimize_to_tray' | 'exit'
}

interface SettingsPanelProps {
  installDir: string | null
  userDataDir: string
  onChangeInstallDir: () => void
  onClose: () => void

  onUninstalled: () => void
}

type VerifyResult = Awaited<ReturnType<typeof window.csore.verifyInstall>>
type DWProtonStatus = Awaited<ReturnType<typeof window.csore.getDWProtonStatus>>
type WhiskyStatus = Awaited<ReturnType<typeof window.csore.getWhiskyStatus>>
type UpdateState = Awaited<ReturnType<typeof window.csore.getUpdateState>>
type Progress = { processed: number; total: number; phase: string }
type NavTab = 'launcher' | 'about'

// Shared settings section layout.
function SectionCard({
  title,
  children
}: {
  title: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="rounded-lg bg-white/[0.04] border border-white/5">
      <h3 className="px-5 py-3 text-sm font-bold text-white border-b border-white/10">{title}</h3>
      <div className="p-5 space-y-3">{children}</div>
    </div>
  )
}

export function SettingsPanel({
  installDir,
  userDataDir,
  onChangeInstallDir,
  onClose,
  onUninstalled
}: SettingsPanelProps): React.JSX.Element {
  const [settings, setSettings] = useState<Settings | null>(null)
  const [activeTab, setActiveTab] = useState<NavTab>('launcher')


  const [speedLimitInput, setSpeedLimitInput] = useState('')

  // Verify/repair state
  const [verifying, setVerifying] = useState(false)
  const [verifyResult, setVerifyResult] = useState<VerifyResult | null>(null)
  const [verifyError, setVerifyError] = useState<string | null>(null)
  const [repairing, setRepairing] = useState(false)
  const [repairProgress, setRepairProgress] = useState<Progress | null>(null)
  const [repairError, setRepairError] = useState<string | null>(null)
  const [repairDone, setRepairDone] = useState(false)

  // Uninstall state
  const [confirmingUninstall, setConfirmingUninstall] = useState(false)
  const [uninstalling, setUninstalling] = useState(false)
  const [uninstallError, setUninstallError] = useState<string | null>(null)

  // Platform-gated sections
  const [platform, setPlatform] = useState<NodeJS.Platform | null>(null)
  const [dwprotonStatus, setDwprotonStatus] = useState<DWProtonStatus | null>(null)
  const [redownloading, setRedownloading] = useState(false)
  const [redownloadProgress, setRedownloadProgress] = useState<Progress | null>(null)
  const [redownloadError, setRedownloadError] = useState<string | null>(null)
  const [whiskyStatus, setWhiskyStatus] = useState<WhiskyStatus | null>(null)

  // Update status (About/Update Settings section) -- read-only status + a manual check trigger.
  const [updateState, setUpdateState] = useState<UpdateState | null>(null)
  const [checkingUpdate, setCheckingUpdate] = useState(false)
  const [appVersion, setAppVersion] = useState<string | null>(null)

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
      window.csore.getWhiskyStatus().then(setWhiskyStatus)
    }
  }, [platform])

  useEffect(() => {
    window.csore.getUpdateState().then(setUpdateState)
    window.csore.getAppVersion().then(setAppVersion)
  }, [])

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
    } catch (err) {
      setVerifyError(err instanceof Error ? err.message : 'Could not verify the install.')
    } finally {
      setVerifying(false)
    }
  }

  async function handleRepair(): Promise<void> {
    if (!installDir) return
    setRepairing(true)
    setRepairError(null)
    setRepairDone(false)
    setRepairProgress(null)

    const unsubscribe = window.csore.onProgress((update) => setRepairProgress(update))
    try {
      await window.csore.repairInstall(installDir)
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

  return (
    <div className="fixed inset-0 z-10 flex items-center justify-center bg-black/60 p-6">
      <div className="flex h-[85vh] w-full max-w-3xl overflow-hidden rounded-xl border border-white/10 bg-zinc-950 text-white shadow-2xl">
        {/* Left sidebar */}
        <div className="flex w-48 flex-shrink-0 flex-col gap-1 bg-black/40 p-3">
          <div className="flex items-center gap-2 px-2 py-2 text-base font-semibold">
            <GearIcon />
            Settings
          </div>
          <nav className="mt-2 flex flex-col gap-1">
            <button
              type="button"
              onClick={() => setActiveTab('launcher')}
              className={`rounded-md px-3 py-2 text-left text-sm transition ${
                activeTab === 'launcher' ? 'bg-white/15 text-white' : 'text-white/60 hover:bg-white/5 hover:text-white'
              }`}
            >
              Launcher Settings
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('about')}
              className={`rounded-md px-3 py-2 text-left text-sm transition ${
                activeTab === 'about' ? 'bg-white/15 text-white' : 'text-white/60 hover:bg-white/5 hover:text-white'
              }`}
            >
              About
            </button>
          </nav>
        </div>

        {/* Right content */}
        <div className="relative flex-1 overflow-y-auto p-6">
          <button
            type="button"
            onClick={onClose}
            title="Close"
            className="absolute right-4 top-4 text-white/50 hover:text-white"
          >
            <CloseIcon />
          </button>

          {activeTab === 'about' && (
            <div className="space-y-4 pr-8">
              <h2 className="text-lg font-semibold">About</h2>
              <div className="rounded-lg bg-white/[0.04] border border-white/5 p-5 space-y-2 text-sm">
                <p className="text-white/80">CSORE Launcher</p>
                <p className="text-white/50">Version {appVersion ?? '…'}</p>
                <p className="truncate text-xs text-white/40">Launcher data: {userDataDir}</p>
              </div>
            </div>
          )}

          {activeTab === 'launcher' && !settings && <div className="text-white/60">Loading…</div>}

          {activeTab === 'launcher' && settings && (
            <div className="space-y-4 pr-8">
              <SectionCard title="Language Settings">
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
              </SectionCard>

              <SectionCard title="Launch Settings">
                <label className="flex items-center justify-between text-sm">
                  Classic UI
                  <input
                    type="checkbox"
                    checked={settings.classicUi}
                    onChange={(e) => update({ classicUi: e.target.checked })}
                  />
                </label>
                <label className="flex items-center justify-between text-sm">
                  Alternate renderer
                  <input
                    type="checkbox"
                    checked={settings.alternateRenderer}
                    onChange={(e) => update({ alternateRenderer: e.target.checked })}
                  />
                </label>
              </SectionCard>

              <SectionCard title="Download Settings">
                <label className="flex items-center justify-between text-sm gap-3">
                  <span>
                    Download speed limit
                    {}
                    <span className="block text-xs text-white/40">0 or empty = unlimited, else 100~20480 KB/S</span>
                  </span>
                  <span className="flex items-center gap-1.5 flex-shrink-0">
                    <input
                      type="number"
                      min={0}
                      step="any"
                      inputMode="decimal"
                      placeholder="Unlimited"
                      value={speedLimitInput}
                      onChange={(e) => setSpeedLimitInput(e.target.value)}
                      onBlur={(e) => commitSpeedLimit(e.target.value)}
                      className="w-24 rounded bg-white/10 px-2 py-1 text-right"
                    />
                    <span className="text-white/50">KB/S</span>
                  </span>
                </label>
              </SectionCard>

              <SectionCard title="Install">
                <div className="space-y-2">
                  <p className="truncate text-xs text-white/50">{installDir ?? 'Not installed yet'}</p>
                  <button
                    type="button"
                    onClick={onChangeInstallDir}
                    className="rounded bg-white/10 px-3 py-1.5 text-sm hover:bg-white/20"
                  >
                    Change install location
                  </button>
                </div>

                {installDir && (
                  <div className="space-y-2 border-t border-white/10 pt-3">
                    <h4 className="text-xs font-medium uppercase tracking-wide text-white/40">Verify / repair files</h4>
                    <button
                      type="button"
                      onClick={handleVerify}
                      disabled={verifying || repairing}
                      className="rounded bg-white/10 px-3 py-1.5 text-sm hover:bg-white/20 disabled:opacity-60"
                    >
                      {verifying ? 'Verifying…' : 'Verify files'}
                    </button>

                    {verifyError && <p className="text-xs text-red-400">{verifyError}</p>}

                    {verifyResult && (
                      <p className="text-xs text-white/70">
                        {verifyResult.ok
                          ? 'All files verified OK.'
                          : `${verifyResult.corruptFiles.length} file(s) corrupt, ${verifyResult.missingFiles.length} file(s) missing.`}
                      </p>
                    )}

                    {verifyResult && !verifyResult.ok && !repairDone && (
                      <div className="space-y-2">
                        <p className="text-xs text-white/50">
                          Repair re-downloads the full game client from scratch (not just the affected
                          files) -- expect a multi-GB download.
                        </p>
                        <button
                          type="button"
                          onClick={handleRepair}
                          disabled={repairing}
                          className="rounded bg-white/10 px-3 py-1.5 text-sm hover:bg-white/20 disabled:opacity-60"
                        >
                          {repairing ? 'Repairing…' : 'Repair (full re-download)'}
                        </button>
                      </div>
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
                  </div>
                )}

                <div className="space-y-2 border-t border-white/10 pt-3">
                  <h4 className="text-xs font-medium uppercase tracking-wide text-white/40">Uninstall</h4>
                  {!confirmingUninstall ? (
                    <button
                      type="button"
                      onClick={() => setConfirmingUninstall(true)}
                      disabled={!installDir || uninstalling}
                      className="rounded bg-white/10 px-3 py-1.5 text-sm hover:bg-white/20 disabled:opacity-60"
                    >
                      Uninstall
                    </button>
                  ) : (
                    <div className="space-y-2">
                      <p className="text-xs text-red-300">
                        Are you sure? This deletes all installed game files. Click again to confirm.
                      </p>
                      <div className="flex gap-2">
                        <button
                          type="button"
                          onClick={handleUninstallConfirmed}
                          disabled={uninstalling}
                          className="rounded bg-red-500/80 px-3 py-1.5 text-sm hover:bg-red-500 disabled:opacity-60"
                        >
                          {uninstalling ? 'Uninstalling…' : 'Confirm uninstall'}
                        </button>
                        <button
                          type="button"
                          onClick={() => setConfirmingUninstall(false)}
                          disabled={uninstalling}
                          className="rounded bg-white/10 px-3 py-1.5 text-sm hover:bg-white/20 disabled:opacity-60"
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  )}
                  {uninstallError && <p className="text-xs text-red-400">{uninstallError}</p>}
                </div>
              </SectionCard>

              {/* Update Settings: deliberately status + manual trigger only, NOT a silent-auto-install toggle. */}
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
                <SectionCard title="Whisky (macOS)">
                  <p className="text-xs text-white/50">
                    {whiskyStatus === null
                      ? 'Checking…'
                      : whiskyStatus.found
                        ? `Whisky bottle found at ${whiskyStatus.bottlePath}.`
                        : // Whisky's own site isn't on the renderer's external-link

                          'No Whisky bottle found -- install Whisky manually and create a bottle named "csore-launcher" before playing.'}
                  </p>
                </SectionCard>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
