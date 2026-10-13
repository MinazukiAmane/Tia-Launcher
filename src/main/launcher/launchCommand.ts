
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

// Bare launch options belong to the client argv, not the shell/runtime wrapper.
export function resolveLaunchOptions(args: string[], command?: string | null): { args: string[]; command: string | null | undefined } {
  const text = command?.trim()
  if (!text || text.includes('%command%') || !text.startsWith('-')) return { args, command }
  const extra: string[] = []
  let token = ''
  let quote = ''
  let started = false
  for (const character of text) {
    if (quote) {
      if (character === quote) quote = ''
      else token += character
    } else if (character === '"' || character === "'") {
      quote = character
      started = true
    } else if (/\s/.test(character)) {
      if (started) { extra.push(token); token = ''; started = false }
    } else {
      token += character
      started = true
    }
  }
  if (quote) throw new Error('Launch options contain an unclosed quote.')
  if (started) extra.push(token)
  return { args: [...args, ...extra], command: null }
}
