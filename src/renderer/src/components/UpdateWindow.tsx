import { useEffect, useState } from 'react'

export function UpdateWindow(): React.JSX.Element | null {
  const [available, setAvailable] = useState<{ version: string } | null>(null)
  const [progress, setProgress] = useState<number | null>(null)
  const [downloading, setDownloading] = useState(false)
  const [detail, setDetail] = useState<Awaited<ReturnType<typeof window.csore.getUpdateState>>['downloadProgress']>(null)
  const [now, setNow] = useState(Date.now())
  const [downloaded, setDownloaded] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)


  async function onRestartAndInstall(): Promise<void> {
    setErrorMessage(null)
    try {
      await window.csore.quitAndInstallUpdate()
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : 'Could not restart to install the update.')
    }
  }

  async function onStartDownload(): Promise<void> {
    const retry = errorMessage !== null
    setErrorMessage(null)
    setDownloading(true)
    setProgress(0)
    setDetail(null)
    try {
      await window.csore.startUpdateDownload(retry)
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Could not download the update.')
      setDownloading(false)
      setProgress(null)
      setDetail(null)
    }
  }

  useEffect(() => {
    if (!downloading) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [downloading])

  useEffect(() => {

    function applyState(state: Awaited<ReturnType<typeof window.csore.getUpdateState>>): void {
      setAvailable(state.available)
      setProgress(state.progress)
      setDownloaded(state.downloaded)
      setDownloading(state.downloading)
      setDetail(state.downloadProgress)
      setErrorMessage(state.error)
    }
    window.csore.getUpdateState().then(applyState).catch(() => {})

    const unsubAvailable = window.csore.onUpdateAvailable((info) => {
      setAvailable(info)
      window.csore.getUpdateState().then(applyState).catch(() => {})
    })
    const unsubProgress = window.csore.onDownloadProgress((p) => {
      setProgress(p.percent)
      setDetail(p)
      setDownloading(true)
      setNow(Date.now())
    })
    const unsubDownloaded = window.csore.onUpdateDownloaded(() => {
      setDownloaded(true)
      setDownloading(false)
      setErrorMessage(null)
    })
    const unsubError = window.csore.onUpdateError((message) => {
      setErrorMessage(message)
      setDownloading(false)
      setProgress(null)
      setDetail(null)
    })
    return () => {
      unsubAvailable()
      unsubProgress()
      unsubDownloaded()
      unsubError()
    }
  }, [])

  if (!available) return null

  return (
    <div className="fixed bottom-4 left-1/2 z-20 w-80 -translate-x-1/2 rounded-lg bg-zinc-900 border border-white/10 p-4 text-white shadow-xl">
      {!downloaded ? (
        <>
          <p className="text-sm">A new launcher version ({available.version}) is available.</p>
          {downloading ? (
            <div role="status" className="mt-2 text-xs text-white/60">
              <p>{progress !== null && progress >= 100 ? 'Preparing update…' : `Downloading… ${Math.round(progress ?? 0)}%`}</p>
              {detail && detail.total > 0 && <p className="mt-1">
                {(detail.transferred / 1048576).toFixed(1)} / {(detail.total / 1048576).toFixed(1)} MB
                {' · '}{now - detail.updatedAt > 5000 ? '—' : (detail.bytesPerSecond / 1048576).toFixed(1)} MB/s
              </p>}
              {detail && now - detail.updatedAt >= 30000 && <p className="mt-1">
                Waiting for the network or processing local update files…
              </p>}
            </div>
          ) : (
            <button
              type="button"
              onClick={() => { void onStartDownload() }}
              className="mt-2 rounded bg-yellow-400 px-3 py-1 text-sm font-medium text-black hover:bg-yellow-300"
            >
              {errorMessage ? 'Retry download' : 'Update now'}
            </button>
          )}
        </>
      ) : (
        <>
          <p className="text-sm">Update downloaded.</p>
          <button
            type="button"
            onClick={() => {
              onRestartAndInstall()
            }}
            className="mt-2 rounded bg-yellow-400 px-3 py-1 text-sm font-medium text-black hover:bg-yellow-300"
          >
            Restart &amp; install
          </button>
        </>
      )}
      {errorMessage && <p role="alert" className="mt-2 text-xs text-red-400">{errorMessage}</p>}
    </div>
  )
}
