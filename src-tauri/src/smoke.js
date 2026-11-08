(async () => {
  for (let attempt = 0; attempt < 100 && !window.csore; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  const api = window.csore
  const catalog = await api.getGameCatalog()
  await api.selectGame('csore_global')
  await api.setSilverIntroductionChoice('dismissed')
  const introduction = await api.getSilverIntroduction()
  const original = await api.getSettings()
  await api.setSettings({ ...original, lang: 'na_id', fpsLimit: 144 })
  await api.setPreferences({ backgroundMode: 'image', launcherLanguage: 'en' })
  await api.migrateLegacyPreferences({ backgroundMode: null, confirmedInstallDir: null, launcherLanguage: 'id', installDir: null })
  await api.selectGame('cedar_global')
  const cedar = await api.getSettings()
  await api.setSettings({ ...cedar, lang: 'na_en', fpsLimit: 165 })
  const cedarSaved = await api.getSettings()
  await api.selectGame('csore_global')
  const csoreSaved = await api.getSettings()
  const preferences = await api.getPreferences()
  const updateState = await api.getUpdateState()
  const overlay = await window.__TAURI_INTERNALS__.invoke('launcher_request', {channel:'preview:overlayCheck',args:[]})
  const reloadBlocked = !window.dispatchEvent(new KeyboardEvent('keydown', {key:'r',ctrlKey:true,cancelable:true}))
  const copyAllowed = window.dispatchEvent(new KeyboardEvent('keydown', {key:'c',ctrlKey:true,cancelable:true}))
  const result = {
    ui: document.body.innerText.length > 30,
    gameCount: catalog.games.length,
    separateGameSettings: csoreSaved.lang === 'na_id' && csoreSaved.fpsLimit === 144 && cedarSaved.lang === 'na_en' && cedarSaved.fpsLimit === 165,
    preferences: preferences.backgroundMode === 'image' && preferences.launcherLanguage === 'en',
    introduction: introduction.eligible === false,
    unconfiguredUpdater: updateState.versionStatus === 'failed' && updateState.available === null,
    shortcuts: reloadBlocked && copyAllowed,
    overlay: overlay.visible && overlay.x < overlay.right && overlay.y < overlay.bottom,
    platform: await api.getPlatform()
  }
  result.ok = result.ui && result.gameCount === 2 && result.separateGameSettings && result.preferences && result.introduction && result.unconfiguredUpdater && result.shortcuts && result.overlay
  await window.__TAURI_INTERNALS__.invoke('launcher_request', { channel: 'preview:smokeReport', args: [result] })
})().catch(async () => {
  await window.__TAURI_INTERNALS__.invoke('launcher_request', { channel: 'preview:smokeReport', args: [{ ok: false, error: 'Preview integration check failed' }] })
})
