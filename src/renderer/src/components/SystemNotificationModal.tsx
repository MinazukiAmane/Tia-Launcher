import { t } from '../i18n'
import { useId } from 'react'


interface SystemNotificationModalProps {
  title: string
  layout?: 'message' | 'form'
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
  layout = 'message',
  children,
  cancelLabel = t("Cancel"),
  confirmLabel = t("Confirm"),
  onCancel,
  onConfirm,
  confirmDisabled = false,
  confirmBusy = false
}: SystemNotificationModalProps): React.JSX.Element {
  const titleId = useId()
  return (
    <div className="notice-backdrop">
      <div role="dialog" aria-modal="true" aria-labelledby={titleId} className={`notice-dialog notice-${layout}`}>
        <h2 id={titleId} className="notice-heading">{title}</h2>
        <div className="notice-body">{children}</div>
        <div className="notice-footer">
          <button
            type="button"
            onClick={onCancel}
            className="notice-cancel"
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={confirmDisabled || confirmBusy}
            className="notice-confirm"
          >
            {confirmBusy ? t("Working…") : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
