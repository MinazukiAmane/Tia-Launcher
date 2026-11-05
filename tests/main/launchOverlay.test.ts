import { afterEach, expect, it, vi } from 'vitest'
const state = vi.hoisted(() => ({ windows: [] as any[] }))
vi.mock('electron', () => ({
  screen: {
    getDisplayMatching: vi.fn(() => ({ workArea: { x: -1920, y: 0, width: 1920, height: 1040 } })),
    getPrimaryDisplay: vi.fn(() => ({ workArea: { x: 0, y: 0, width: 1920, height: 1040 } }))
  },
  BrowserWindow: class {
    destroyed = false
    callbacks: Record<string, () => void> = {}
    webContents = { setWindowOpenHandler: vi.fn() }
    setIgnoreMouseEvents = vi.fn()
    setMenu = vi.fn()
    showInactive = vi.fn()
    loadURL = vi.fn().mockResolvedValue(undefined)
    constructor(readonly options: any) { state.windows.push(this) }
    once(event: string, callback: () => void) { this.callbacks[event] = callback }
    isDestroyed() { return this.destroyed }
    destroy() { this.destroyed = true }
  }
}))
import { LaunchOverlay } from '../../src/main/launchOverlay'
afterEach(() => { vi.useRealTimers(); state.windows.length = 0 })
it('uses the launch monitor work area without taking focus or intercepting clicks', () => {
  vi.useFakeTimers()
  const overlay = new LaunchOverlay()
  overlay.show({ x: -1000, y: 30, width: 1100, height: 650 })
  const win = state.windows[0]
  expect(win.options).toMatchObject({ x: -260, y: 916, focusable: false, skipTaskbar: true, transparent: true })
  expect(win.setIgnoreMouseEvents).toHaveBeenCalledWith(true)
  win.callbacks['ready-to-show']()
  expect(win.showInactive).toHaveBeenCalledOnce()
  overlay.gameDetected()
  vi.advanceTimersByTime(2999)
  expect(win.destroyed).toBe(false)
  vi.advanceTimersByTime(1)
  expect(win.destroyed).toBe(true)
})
it('times out if the game is never detected and ignores stale ready callbacks', () => {
  vi.useFakeTimers()
  const overlay = new LaunchOverlay()
  overlay.show()
  const old = state.windows[0]
  overlay.show()
  old.callbacks['ready-to-show']()
  expect(old.showInactive).not.toHaveBeenCalled()
  vi.advanceTimersByTime(30_000)
  expect(state.windows[1].destroyed).toBe(true)
})
it('releases the overlay immediately on restore or quit', () => {
  vi.useFakeTimers()
  const overlay = new LaunchOverlay()
  overlay.show()
  overlay.close()
  expect(state.windows[0].destroyed).toBe(true)
  expect(vi.getTimerCount()).toBe(0)
})
