export interface ShortcutInput {
  key: string
  control?: boolean
  meta?: boolean
  shift?: boolean
  alt?: boolean
}

const browserKeys = new Set(['r', 'u', 'p', 's', 'o', 'l', 'f', 'g', 'h', 'j', 'd', 't', 'n', 'b', 'e', 'k', '+', '-', '=', '0', 'add', 'subtract'])
const browserFunctionKeys = new Set(['f1', 'f3', 'f5', 'f6', 'f7', 'f10', 'f11'])

export function blocksBrowserShortcut(input: ShortcutInput, production: boolean): boolean {
  const key = input.key.toLowerCase()
  const modifier = input.control || input.meta
  const inspector = key === 'f12' || !!(modifier && (input.shift || input.alt) && ['i', 'j', 'c'].includes(key))
  if (inspector) return production
  if (browserFunctionKeys.has(key)) return true
  if (input.alt && ['arrowleft', 'arrowright', 'home'].includes(key)) return true
  if (input.meta && ['[', ']'].includes(key)) return true
  if (!modifier) return false
  if (browserKeys.has(key)) return true
  if (['tab', 'pageup', 'pagedown'].includes(key) || /^[1-9]$/.test(key)) return true
  if (input.shift && ['delete', 'backspace'].includes(key)) return true
  return false
}
