import { BrowserWindow } from 'electron'

export async function canPlayBackgroundVideo(url: string): Promise<boolean> {
  const probe = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } })
  probe.webContents.setAudioMuted(true)
  try {
    await probe.loadURL('about:blank')
    return await probe.webContents.executeJavaScript(`new Promise(resolve => {
      const video = document.createElement('video'); video.muted = true; video.preload = 'auto';
      const finish = value => { clearTimeout(timer); video.onloadeddata = video.onerror = null; video.removeAttribute('src'); video.load(); resolve(value); };
      const timer = setTimeout(() => finish(false), 12000);
      video.onloadeddata = () => finish(video.videoWidth > 0 && video.videoHeight > 0);
      video.onerror = () => finish(false);
      video.src = ${JSON.stringify(url)};
    })`)
  } finally { if (!probe.isDestroyed()) probe.destroy() }
}
