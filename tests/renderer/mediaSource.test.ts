import { beforeEach, expect, it, vi } from 'vitest'
import { invoke, convertFileSrc } from '@tauri-apps/api/core'
import { resolveVideoSource } from '../../src/renderer/src/mediaSource'

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
  convertFileSrc: vi.fn((path: string) => `asset://${path}`)
}))
beforeEach(() => vi.clearAllMocks())

it('uses the Rust streaming URL without wrapping it as a file', async () => {
  vi.mocked(invoke).mockResolvedValue('http://127.0.0.1:1234/token')
  expect(await resolveVideoSource('/assets/video.mp4')).toBe('http://127.0.0.1:1234/token')
  expect(convertFileSrc).not.toHaveBeenCalled()
})

it('keeps approved bundled URLs on platforms with native asset playback', async () => {
  vi.mocked(invoke).mockResolvedValue('/assets/video.mp4')
  expect(await resolveVideoSource('/assets/video.mp4')).toBe('/assets/video.mp4')
  expect(convertFileSrc).not.toHaveBeenCalled()
})

it('converts a custom file only after Rust authorizes it', async () => {
  vi.mocked(invoke).mockResolvedValue('C:\\backgrounds\\custom.mp4')
  expect(await resolveVideoSource('C:\\backgrounds\\custom.mp4')).toBe('asset://C:\\backgrounds\\custom.mp4')
  expect(invoke).toHaveBeenCalledWith('launcher_request', { channel: 'launcher:videoSource', args: ['C:\\backgrounds\\custom.mp4'] })
})

it('does not expose an asset URL when Rust rejects the source', async () => {
  vi.mocked(invoke).mockRejectedValue(new Error('Choose a background video first'))
  await expect(resolveVideoSource('/unselected.mp4')).rejects.toThrow('Choose a background video first')
  expect(convertFileSrc).not.toHaveBeenCalled()
})
