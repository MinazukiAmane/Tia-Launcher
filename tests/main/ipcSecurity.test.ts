import { expect, it } from 'vitest'
import { assertTrustedSender } from '../../src/main/ipcSecurity'

it('allows only the live main frame of the current launcher window', () => {
  const frame = {}
  const contents = { mainFrame: frame }
  const win = { isDestroyed: () => false, webContents: contents } as unknown as Electron.BrowserWindow
  expect(() => assertTrustedSender(win, { sender: contents, senderFrame: frame } as never)).not.toThrow()
  for (const event of [null, {}, { sender: contents, senderFrame: {} }, { sender: {}, senderFrame: frame }]) {
    expect(() => assertTrustedSender(win, event as never)).toThrow(/active launcher/)
  }
  expect(() => assertTrustedSender(() => null, { sender: contents, senderFrame: frame } as never)).toThrow()
  const closed = { ...win, isDestroyed: () => true } as Electron.BrowserWindow
  expect(() => assertTrustedSender(closed, { sender: contents, senderFrame: frame } as never)).toThrow()
})

it('resolves the recreated launcher instead of retaining a destroyed renderer', () => {
  const oldFrame = {}, newFrame = {}
  const old = { mainFrame: oldFrame }, current = { mainFrame: newFrame }
  const source = () => ({ isDestroyed: () => false, webContents: current }) as unknown as Electron.BrowserWindow
  expect(() => assertTrustedSender(source, { sender: old, senderFrame: oldFrame } as never)).toThrow()
  expect(() => assertTrustedSender(source, { sender: current, senderFrame: newFrame } as never)).not.toThrow()
})
