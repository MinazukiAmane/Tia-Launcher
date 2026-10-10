
interface SystemNotificationModalProps {
  title: string
  children: React.ReactNode
  cancelLabel?: string
  confirmLabel?: string
  onCancel: () => void
  onConfirm: () => void
  confirmDisabled?: boolean
  confirmBusy?: boolean
}

export function SystemNotificationModal({
  title,
  children,
  cancelLabel = 'Cancel',
  confirmLabel = 'Confirm',
  onCancel,
  onConfirm,
  confirmDisabled = false,
  confirmBusy = false
}: SystemNotificationModalProps): React.JSX.Element {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-6">
      <div className="w-full max-w-md rounded-xl border border-white/10 bg-zinc-950 p-6 shadow-2xl">
        <h2 className="text-center text-base font-bold uppercase tracking-wide text-white">{title}</h2>
        <div className="mt-5 text-sm text-white/60">{children}</div>
        <div className="mt-6 flex items-center justify-center gap-3">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-full bg-white/10 px-6 py-2.5 text-sm font-semibold text-white hover:bg-white/20"
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={confirmDisabled || confirmBusy}
            className="rounded-full bg-white px-6 py-2.5 text-sm font-semibold text-black hover:bg-white/90 disabled:opacity-60"
          >
            {confirmBusy ? 'Working…' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
