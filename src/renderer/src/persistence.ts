let migration: Promise<void> | undefined

export function migrateLegacyPreferences(): Promise<void> {
  if (migration) return migration
  migration = (async () => {
    const readLegacy = (key: string): string | null => { try { return localStorage.getItem(key) } catch { return null } }
    const backgroundMode = readLegacy('tia-background-mode')
    const confirmedInstallDir = readLegacy('tia-install-path-confirmed')
    const installDir = readLegacy('tia-install-dir')
    await window.csore.migrateLegacyPreferences({
      backgroundMode: backgroundMode === 'image' || backgroundMode === 'video' ? backgroundMode : null,
      confirmedInstallDir, installDir
    })
    for (const key of ['tia-background-mode', 'tia-install-path-confirmed', 'tia-install-dir']) {
      try { localStorage.removeItem(key) } catch { /* SQLite is already committed. */ }
    }
  })().catch(error => { migration = undefined; throw error })
  return migration
}
