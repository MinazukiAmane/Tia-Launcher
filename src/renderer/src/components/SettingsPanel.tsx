import { useEffect, useState } from 'react'

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
}

export function SettingsPanel({
  installDir,
  userDataDir,
  onChangeInstallDir,
  onClose
}: SettingsPanelProps): React.JSX.Element {
  const [settings, setSettings] = useState<Settings | null>(null)

  useEffect(() => {

    window.csore.getSettings().then(setSettings)
  }, [])

  async function update(patch: Partial<Settings>): Promise<void> {
    if (!settings) return
    const next = { ...settings, ...patch }
    setSettings(next)
    await window.csore.setSettings(next)
  }

  if (!settings) return <div className="p-6 text-white">Loading…</div>

  return (
    <div className="fixed inset-0 z-10 flex items-center justify-center bg-black/60">
      <div className="w-96 rounded-xl bg-zinc-900 border border-white/10 p-6 text-white space-y-5">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">Settings</h2>
          <button type="button" onClick={onClose} className="text-white/60 hover:text-white">
            ✕
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
          {}
        </div>

        <div className="border-t border-white/10 pt-3">
          <p className="truncate text-xs text-white/40">Launcher data: {userDataDir}</p>
        </div>
      </div>
    </div>
  )
}
