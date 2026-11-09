(async () => {
  for (let attempt = 0; attempt < 100 && !window.csore; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  const api = window.csore
  let backgroundVideo = true
  let backgroundVideoDetails = null
  if (await api.getPlatform() === 'linux') {
    let video
    for (let attempt = 0; attempt < 80; attempt++) {
      video = document.querySelector('video.background-media')
      if (video?.currentSrc?.startsWith('http://127.0.0.1:')) break
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    backgroundVideo = false
    if (video?.currentSrc) {
      const source = video.currentSrc
      video = document.createElement('video')
      video.muted = true
      video.src = source
      video.style.display = 'none'
      document.body.append(video)
      try {
        await Promise.race([video.play(), new Promise((_, reject) => setTimeout(() => reject(new Error('Video timeout')), 4000))])
        await new Promise(resolve => setTimeout(resolve, 300))
        // Hidden windows can freeze the playback clock.
        backgroundVideo = video.videoWidth > 0 && video.readyState >= 2 && !video.error
        video.pause()
      } catch (error) { backgroundVideoDetails = { error: String(error) } }
      backgroundVideoDetails = { ...backgroundVideoDetails, src: video.currentSrc, ready: video.readyState, width: video.videoWidth, time: video.currentTime, mediaError: video.error?.code, userAgent: navigator.userAgent }
      video.removeAttribute('src'); video.load(); video.remove()
    }
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
    overlay: overlay.visible && overlay.x < overlay.right && overlay.y < overlay.bottom,
    platform: await api.getPlatform()
  }
  result.ok = result.ui && result.backgroundVideo && result.gameCount === 2 && result.separateGameSettings && result.preferences && result.introduction && result.unconfiguredUpdater && result.shortcuts && result.overlay
  await window.__TAURI_INTERNALS__.invoke('launcher_request', { channel: 'preview:smokeReport', args: [result] })
})().catch(async () => {
  await window.__TAURI_INTERNALS__.invoke('launcher_request', { channel: 'preview:smokeReport', args: [{ ok: false, error: 'Preview integration check failed' }] })
})
