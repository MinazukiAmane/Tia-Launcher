interface ProgressBarProps {
  processed: number
  total: number
  label: string
}

export function ProgressBar({ processed, total, label }: ProgressBarProps): React.JSX.Element {
  const pct = total > 0 ? Math.round((processed / total) * 100) : 0
  return (
    <div className="flex items-center gap-3 w-full max-w-sm">
      <div className="h-2 flex-1 overflow-hidden rounded-full bg-white/10">
        <div className="h-full rounded-full bg-yellow-400 transition-all" style={{ width: `${pct}%` }} />
      </div>
      <span className="text-sm text-white/80 whitespace-nowrap">
        {label} {pct}%
      </span>
    </div>
  )
}
