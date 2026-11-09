import type { UpdateState } from '../../../src/shared/launcherApiTypes'
interface Bridge {
  state(): Promise<UpdateState>
  check(): Promise<void>
  download(): Promise<void>
  install(): Promise<void>
  onChange(callback: () => void): () => void
}
const bridge = (window as unknown as { bridge: Bridge }).bridge
const status = document.getElementById('status')!
const action = document.getElementById('action') as HTMLButtonElement
const progress = document.getElementById('progress') as HTMLProgressElement
let current: UpdateState | null = null
let busy = false
async function refresh(): Promise<void> {
  current = await bridge.state()
  progress.hidden = !current.downloading
  progress.value = current.progress ?? 0
  status.textContent = current.error ? 'The update could not finish. Please try again.' : current.downloaded ? 'The update is ready. Continue to install it.' : current.downloading ? `Downloading update… ${Math.floor(current.progress ?? 0)}%` : current.available ? `Version ${current.available.version} is ready to download.` : current.versionStatus === 'checking' ? 'Checking for updates…' : 'Check again to get the new launcher.'
  action.textContent = current.downloaded ? 'Install and continue' : current.downloading ? 'Downloading…' : current.available ? 'Download update' : 'Check again'
  action.disabled = busy || current.downloading || current.versionStatus === 'checking'
}
action.addEventListener('click', async () => {
  if (busy || !current) return
  busy = true
  action.disabled = true
  try {
    if (current.downloaded) await bridge.install()
    else if (current.available) await bridge.download()
    else await bridge.check()
  } catch { status.textContent = 'The update could not finish. Please try again.' }
  finally { busy = false; await refresh() }
})
bridge.onChange(() => { void refresh() })
void refresh()
