import { useEffect, useState } from 'react'
import { ProgressBar } from './ProgressBar'

function CloseIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4 stroke-current" fill="none" strokeWidth={2}>
      <path d="M6 6l12 12M18 6L6 18" strokeLinecap="round" />
    </svg>
  )
}

interface Settings {
  lang: 'na_id' | 'na_en'
  classicUi: boolean
  alternateRenderer: boolean
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
type Progress = { processed: number; total: number; phase: string }

export function SettingsPanel({
  installDir,
  userDataDir,
  onChangeInstallDir,
  onClose,
  onUninstalled
}: SettingsPanelProps): React.JSX.Element {
  const [settings, setSettings] = useState<Settings | null>(null)

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

  useEffect(() => {

    window.csore.getSettings().then(setSettings)
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

  async function update(patch: Partial<Settings>): Promise<void> {
    if (!settings) return
    const next = { ...settings, ...patch }
    setSettings(next)
    await window.csore.setSettings(next)
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

  if (!settings) return <div className="p-6 text-white">Loading…</div>

  return (
    <div className="fixed inset-0 z-10 flex items-center justify-center bg-black/60">
      <div className="w-96 max-h-[90vh] overflow-y-auto rounded-xl bg-zinc-900 border border-white/10 p-6 text-white space-y-5">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">Settings</h2>
          <button type="button" onClick={onClose} className="text-white/60 hover:text-white">
            <CloseIcon />
          </button>
        </div>

        <div className="space-y-3">
          <h3 className="text-sm font-medium text-white/70">Game launch options</h3>

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
        </div>

        <div className="space-y-2 border-t border-white/10 pt-4">
          <h3 className="text-sm font-medium text-white/70">Install</h3>
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
          <div className="space-y-2 border-t border-white/10 pt-4">
            <h3 className="text-sm font-medium text-white/70">Verify / repair files</h3>

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

        {platform === 'linux' && (
          <div className="space-y-2 border-t border-white/10 pt-4">
            <h3 className="text-sm font-medium text-white/70">DWProton (Linux)</h3>
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
          </div>
        )}

        {platform === 'darwin' && (
          <div className="space-y-2 border-t border-white/10 pt-4">
            <h3 className="text-sm font-medium text-white/70">Whisky (macOS)</h3>
            <p className="text-xs text-white/50">
              {whiskyStatus === null
                ? 'Checking…'
                : whiskyStatus.found
                  ? `Whisky bottle found at ${whiskyStatus.bottlePath}.`
                  : // Whisky's own site isn't on the renderer's external-link

                    'No Whisky bottle found -- install Whisky manually and create a bottle named "csore-launcher" before playing.'}
            </p>
          </div>
        )}

        <div className="space-y-2 border-t border-white/10 pt-4">
          <h3 className="text-sm font-medium text-white/70">Uninstall</h3>
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

        <div className="border-t border-white/10 pt-3">
          <p className="truncate text-xs text-white/40">Launcher data: {userDataDir}</p>
        </div>
      </div>
    </div>
  )
}
