
export function quoteShellArgUnix(arg: string): string {
  return `'${arg.replace(/'/g, `'\\''`)}'`
}

export function quoteShellArgWindows(arg: string): string {
  return `"${arg.replace(/"/g, '""')}"`
}

// Substitutes the real invocation into launchCommand at the %command% placeholder.
export function buildWrappedCommand(launchCommand: string | null | undefined, realCommand: string): string | null {
  const trimmed = launchCommand?.trim()
  if (!trimmed) return null
  if (trimmed.includes('%command%')) {
    return trimmed.split('%command%').join(realCommand)
  }
  return `${trimmed} ${realCommand}`
}
