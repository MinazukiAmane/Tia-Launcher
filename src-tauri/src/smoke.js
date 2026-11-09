(async () => {
  for (let attempt = 0; attempt < 100 && !window.csore; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  const api = window.csore
  if (window.__TIA_SMOKE_OVERLAY_ONLY__) {
    await new Promise(resolve => setTimeout(resolve, 500))
    const overlay = await window.__TAURI_INTERNALS__.invoke('launcher_request', {channel:'preview:overlayCheck',args:[]})
    await window.__TAURI_INTERNALS__.invoke('launcher_request', {channel:'preview:smokeReport',args:[{ok:overlay.visible && overlay.x+overlay.width+overlay.margin===overlay.right && overlay.y+overlay.height+overlay.margin===overlay.bottom,overlay}]})
    return
  }
  const play = async video => Promise.race([video.play(), new Promise((_, reject) => setTimeout(() => reject(new Error('Playback start timed out')), 5000))])
  const progress = async step => window.__TAURI_INTERNALS__.invoke('launcher_request', { channel: 'preview:smokeReport', args: [{ step }] })
  let backgroundVideo = true
  let backgroundVideoDetails = []
  if (await api.getPlatform() === 'linux') {
    const wait = async (check, label, timeout = 5000) => {
      const start = performance.now()
      while (!check()) {
        if (performance.now() - start > timeout) throw new Error(label)
        await new Promise(resolve => setTimeout(resolve, 30))
      }
    }
    const buttons = [...document.querySelectorAll('button.sidebar-game')]
    const activeVideo = () => [...document.querySelectorAll('video.background-media')].find(video => getComputedStyle(video).visibility === 'visible')
    const switchGame = async index => {
      await wait(() => !buttons[index].disabled, 'Game switch locked')
      buttons[index].click()
      await wait(() => buttons[index].getAttribute('aria-pressed') === 'true', 'Game switch failed')
      await wait(() => activeVideo()?.readyState >= 2, 'Video not ready')
      return activeVideo()
    }
    const originals = []
    for (const index of [0, 1]) {
      await progress(`switch ${index}`)
      const video = await switchGame(index)
      await progress(`ready ${index}`)
      originals[index] = video
      await play(video)
      await wait(() => Number.isFinite(video.duration), 'No duration')
      video.playbackRate = 8
      await wait(() => video.currentTime > video.duration - 3, `Video cut short: ${index}`, 35000)
      await wait(() => video.currentTime < 3 && !video.paused, 'Video did not loop', 5000)
      video.playbackRate = 1
      backgroundVideoDetails.push({ duration: video.duration, width: video.videoWidth, looped: true })
    }
    for (const index of [0, 1, 0, 1, 0]) {
      const video = await switchGame(index)
      if (video !== originals[index]) throw new Error('Video player recreated')
      await play(video)
      if (document.querySelectorAll('video.background-media').length !== 2) throw new Error('Unbounded video players')
    }
    backgroundVideo = originals.every(video => !video.error)
  }
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
    backgroundVideo,
    backgroundVideoDetails,
    gameCount: catalog.games.length,
    separateGameSettings: csoreSaved.lang === 'na_id' && csoreSaved.fpsLimit === 144 && cedarSaved.lang === 'na_en' && cedarSaved.fpsLimit === 165,
    preferences: preferences.backgroundMode === 'image' && preferences.launcherLanguage === 'en',
    introduction: introduction.eligible === false,
    unconfiguredUpdater: updateState.versionStatus === 'failed' && updateState.available === null,
    shortcuts: reloadBlocked && copyAllowed,
    overlay: overlay.visible && overlay.x + overlay.width + overlay.margin === overlay.right && overlay.y + overlay.height + overlay.margin === overlay.bottom,
    platform: await api.getPlatform()
  }
  result.ok = result.ui && result.backgroundVideo && result.gameCount === 2 && result.separateGameSettings && result.preferences && result.introduction && result.unconfiguredUpdater && result.shortcuts && result.overlay
  await window.__TAURI_INTERNALS__.invoke('launcher_request', { channel: 'preview:smokeReport', args: [result] })
})().catch(async error => {
  await window.__TAURI_INTERNALS__.invoke('launcher_request', { channel: 'preview:smokeReport', args: [{ ok: false, error: String(error) }] })
})
