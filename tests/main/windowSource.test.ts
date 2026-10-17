import { it, expect, vi } from 'vitest'
import type { BrowserWindow } from 'electron'
import { currentWindow } from '../../src/main/windowSource'

it('routes events to the recreated window and tolerates renderer suspension', () => {
  const first = { isDestroyed: () => true } as BrowserWindow
  const second = { isDestroyed: () => false, webContents: { send: vi.fn() } } as unknown as BrowserWindow
  let current: BrowserWindow | null = first
  const source = (): BrowserWindow | null => current
  expect(currentWindow(source)).toBeNull()
  current = null
  expect(currentWindow(source)).toBeNull()
  current = second
  currentWindow(source)?.webContents.send('game:progress', {})
  expect(second.webContents.send).toHaveBeenCalledOnce()
})
