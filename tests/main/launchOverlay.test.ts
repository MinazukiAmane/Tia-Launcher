import { afterEach, beforeEach, expect, it, vi } from 'vitest'
const state = vi.hoisted(() => ({
  windows: [] as any[],
  displays: [{ id: 1, workArea: { x: 0, y: 0, width: 1920, height: 1040 } }, { id: 2, workArea: { x: -1920, y: 0, width: 1920, height: 1040 } }],
  listeners: new Map<string, Set<() => void>>()
}))
vi.mock('electron', () => ({
  screen: {
    getDisplayMatching: vi.fn(() => state.displays[1]),
    getPrimaryDisplay: vi.fn(() => state.displays[0]),
    getAllDisplays: vi.fn(() => state.displays),
    on: vi.fn((event: string, fn: () => void) => { if (!state.listeners.has(event)) state.listeners.set(event, new Set()); state.listeners.get(event)!.add(fn) }),
    removeListener: vi.fn((event: string, fn: () => void) => state.listeners.get(event)?.delete(fn))
  },
  BrowserWindow: class {
    destroyed = false
    bounds: any
    callbacks: Record<string, () => void> = {}
    webContents = { setWindowOpenHandler: vi.fn() }
    setIgnoreMouseEvents = vi.fn()
    setMenu = vi.fn()
    showInactive = vi.fn()
    loadURL = vi.fn().mockResolvedValue(undefined)
    constructor(readonly options: any) { this.bounds = { ...options }; state.windows.push(this) }
    getBounds() { return this.bounds }
    setBounds = vi.fn((bounds: any) => { this.bounds = bounds })
    once(event: string, callback: () => void) { this.callbacks[event] = callback }
    isDestroyed() { return this.destroyed }
    destroy() { this.destroyed = true }
  }
}))
import { LaunchOverlay } from '../../src/main/launchOverlay'
beforeEach(() => {
  state.displays = [{ id: 1, workArea: { x: 0, y: 0, width: 1920, height: 1040 } }, { id: 2, workArea: { x: -1920, y: 0, width: 1920, height: 1040 } }]
})
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); state.windows.length = 0; state.listeners.clear() })
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

it('corrects initial placement and stays anchored after resolution, DPI, or window-manager changes', () => {
  vi.useFakeTimers()
  const overlay = new LaunchOverlay()
  overlay.show()
  const win = state.windows[0]
  win.bounds = { x: 300, y: 200, width: 236, height: 100 }
  win.callbacks['ready-to-show']()
  expect(win.bounds).toEqual({ x: 1660, y: 916, width: 236, height: 100 })
  state.displays[0].workArea = { x: 0, y: 0, width: 1280, height: 680 }
  for (const listener of state.listeners.get('display-metrics-changed')!) listener()
  expect(win.bounds).toEqual({ x: 1020, y: 556, width: 236, height: 100 })
  win.bounds.x = 40
  vi.advanceTimersByTime(500)
  expect(win.bounds.x).toBe(1020)
  overlay.close()
  expect(vi.getTimerCount()).toBe(0)
  expect([...state.listeners.values()].every(set => set.size === 0)).toBe(true)
})
it('falls back to the primary monitor if the original display disconnects', () => {
  vi.useFakeTimers()
  const overlay = new LaunchOverlay()
  overlay.show({ x: -1000, y: 30, width: 1100, height: 650 })
  state.displays.pop()
  for (const listener of state.listeners.get('display-removed')!) listener()
  expect(state.windows[0].bounds).toEqual({ x: 1660, y: 916, width: 236, height: 100 })
  overlay.close()
})
