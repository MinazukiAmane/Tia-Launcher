import { afterEach, expect, it, vi } from 'vitest'
import { win32, posix } from 'path'
afterEach(() => { vi.doUnmock('path'); vi.resetModules() })
const violation = (reason: string): never => { throw new Error(reason) }
it('accepts extraction into a Windows drive root and still rejects escape paths', async () => {
  vi.doMock('path', () => win32)
  const { resolveWithinRoot, isWithinRoot } = await import('../../src/main/pathSafety')
  expect(resolveWithinRoot('E:\\', 'Bin/', 'zip', violation)).toBe('E:\\Bin')
  expect(resolveWithinRoot('E:\\', 'Data/file.pak', 'zip', violation)).toBe('E:\\Data\\file.pak')
  expect(isWithinRoot('E:\\', 'E:\\Bin')).toBe(true)
  expect(isWithinRoot('E:\\Games', 'e:\\games\\Bin')).toBe(true)
  expect(isWithinRoot('E:\\Games', 'E:\\GamesElsewhere')).toBe(false)
  expect(isWithinRoot('E:\\', 'C:\\Windows')).toBe(false)
  expect(() => resolveWithinRoot('E:\\', '../outside', 'zip', violation)).toThrow()
  expect(() => resolveWithinRoot('E:\\', 'C:\\Windows', 'zip', violation)).toThrow()
})
it('handles UNC share roots without accepting a different share', async () => {
  vi.doMock('path', () => win32)
  const { resolveWithinRoot, isWithinRoot } = await import('../../src/main/pathSafety')
  const root = win32.resolve('//server/share/')
  expect(resolveWithinRoot(root, 'Bin/client.exe', 'zip', violation)).toBe(win32.join(root, 'Bin/client.exe'))
  expect(isWithinRoot(root, String.raw`\\server\other\client.exe`)).toBe(false)
})
it('handles POSIX filesystem root while preserving traversal protection', async () => {
  vi.doMock('path', () => posix)
  const { resolveWithinRoot, isWithinRoot } = await import('../../src/main/pathSafety')
  expect(resolveWithinRoot('/', 'Bin/', 'zip', violation)).toBe('/Bin')
  expect(isWithinRoot('/game', '/game/Bin')).toBe(true)
  expect(isWithinRoot('/game', '/game2/Bin')).toBe(false)
  expect(() => resolveWithinRoot('/game', '../outside', 'zip', violation)).toThrow()
})
