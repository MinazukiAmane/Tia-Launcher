import { useEffect, useState } from 'react'

export function UpdateWindow(): React.JSX.Element | null {
  const [available, setAvailable] = useState<{ version: string } | null>(null)
  const [progress, setProgress] = useState<number | null>(null)
  const [downloaded, setDownloaded] = useState(false)

  useEffect(() => {
    const unsubAvailable = window.csore.onUpdateAvailable((info) => setAvailable(info))
    const unsubProgress = window.csore.onDownloadProgress((p) => setProgress(p.percent))
    const unsubDownloaded = window.csore.onUpdateDownloaded(() => setDownloaded(true))
    return () => {
      unsubAvailable()
      unsubProgress()
      unsubDownloaded()
    }
  }, [])

  if (!available) return null

  return (
    <div className="fixed bottom-4 left-1/2 z-20 w-80 -translate-x-1/2 rounded-lg bg-zinc-900 border border-white/10 p-4 text-white shadow-xl">
      {!downloaded ? (
        <>
          <p className="text-sm">A new launcher version ({available.version}) is available.</p>
          {progress !== null ? (
            <p className="mt-2 text-xs text-white/60">Downloading… {Math.round(progress)}%</p>
          ) : (
            <button
              type="button"
              onClick={() => window.csore.startUpdateDownload()}
              className="mt-2 rounded bg-yellow-400 px-3 py-1 text-sm font-medium text-black hover:bg-yellow-300"
            >
              Update now
            </button>
          )}
        </>
      ) : (
        <>
          <p className="text-sm">Update downloaded.</p>
          <button
            type="button"
            onClick={() => window.csore.quitAndInstallUpdate()}
            className="mt-2 rounded bg-yellow-400 px-3 py-1 text-sm font-medium text-black hover:bg-yellow-300"
          >
            Restart &amp; install
          </button>
        </>
      )}
    </div>
  )
}
