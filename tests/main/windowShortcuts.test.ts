import { expect, it } from 'vitest'
import { blocksBrowserShortcut } from '../../src/main/windowShortcuts'

it('blocks production browser and inspector shortcuts across platforms', () => {
  for (const input of [
    ...['F1', 'F3', 'F5', 'F6', 'F7', 'F10', 'F11', 'F12'].map(key => ({ key })),
    ...['r', 'u', 'p', 's', 'o', 'l', 'f', 'g', 'h', 'j', 'd', 't', 'n', 'b', 'e', 'k', '+', '-', '=', '0', 'Tab', 'PageUp', 'PageDown', '1', '9'].flatMap(key => [{ key, control: true }, { key, meta: true }]),
    ...['I', 'J', 'C'].flatMap(key => [{ key, control: true, shift: true }, { key, meta: true, alt: true }]),
    { key: 'R', control: true, shift: true },
    { key: 'Delete', control: true, shift: true },
    ...['ArrowLeft', 'ArrowRight', 'Home'].map(key => ({ key, alt: true })),
    ...['[', ']'].map(key => ({ key, meta: true }))
  ]) expect(blocksBrowserShortcut(input, true), JSON.stringify(input)).toBe(true)
})
it('preserves editing, accessibility focus navigation and native app close shortcuts', () => {
  for (const key of ['c', 'v', 'x', 'a', 'z', 'y', 'ArrowLeft', 'ArrowRight', 'Backspace']) {
    expect(blocksBrowserShortcut({ key, control: true }, true)).toBe(false)
    expect(blocksBrowserShortcut({ key, meta: true }, true)).toBe(false)
  }
  for (const input of [{ key: 'Tab' }, { key: 'Tab', shift: true }, { key: 'Escape' }, { key: 'F4', alt: true }, { key: 'q', meta: true }, { key: 'w', meta: true }, { key: 'r' }]) expect(blocksBrowserShortcut(input, true)).toBe(false)
})
it('keeps inspector access in development while blocking browser reload', () => {
  for (const input of [{ key: 'F12' }, { key: 'I', control: true, shift: true }, { key: 'j', meta: true, alt: true }]) expect(blocksBrowserShortcut(input, false)).toBe(false)
  expect(blocksBrowserShortcut({ key: 'r', control: true }, false)).toBe(true)
})
