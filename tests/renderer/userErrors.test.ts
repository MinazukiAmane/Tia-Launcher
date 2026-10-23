import { describe, expect, it } from 'vitest'
import { userError, type ErrorAction } from '../../src/renderer/src/userErrors'
import { translate } from '../../src/renderer/src/i18n'
import existingMessages from '../../src/renderer/src/locales/messages.json'
import mediaMessages from '../../src/shared/mediaMessages.json'
const messages = { ...existingMessages, ...mediaMessages }

describe('player-facing errors', () => {
  it('turns the reported Electron AbortError into a plain explanation without guessing why it stopped', () => {
    const raw = "Error invoking remote method 'game:startInstallOrUpdate': AbortError: The operation was aborted"
    const message = userError(raw, 'install')
    expect(message).toBe('The operation stopped before it finished. Try again.')
    expect(translate(message, 'id')).toBe('Proses berhenti sebelum selesai. Coba lagi.')
  })

  it.each([
    ['HTTP 520 (Cloudflare Ray: player-ray)', 'temporarily unavailable'],
    ["ENOSPC: no space left on device, open 'E:\\game\\secret.tmp'", 'not enough free space'],
    ["EBUSY: resource busy or locked, unlink 'C:\\Users\\Player\\status.txt'", 'used by another app'],
    ['EACCES: permission denied, open /home/player/file', 'cannot save files'],
    ['another operation (install/update/repair/uninstall) is already in progress', 'Another task is still running'],
    ['download stalled (no data for 30000ms): https://example.test/private?token=secret', 'connection took too long'],
    ['downloaded file failed MD5 verification: https://example.test/private', 'incomplete or damaged'],
    ['Timed out waiting for client flags initialization. The client was not confirmed ready.', 'Repair its files'],
    ['Per-file repair is not available on the server yet. Regenerate the version manifest first.', 'File repair is temporarily unavailable'],
    ['Launcher database was damaged. A backup was restored', 'saved launcher data'],
    ['Unsupported image type. Use PNG, JPG, WEBP or GIF.', 'up to 25 MB'],
    ['The destination must be an empty folder. Existing files will not be overwritten.', 'empty destination folder'],
    ['umu-launcher is not installed (umu-run not found on PATH)', 'additional component']
  ])('explains %s without exposing technical details', (raw, expected) => {
    const message = userError(raw, 'install')
    expect(message).toContain(expected)
    expect(message).not.toMatch(/Error invoking|Cloudflare Ray|secret|https?:|[A-Z]:\\|\/home\/player/)
    expect(Object.hasOwn(messages, message)).toBe(true)
  })

  it('reads a structured cause but never returns unexpected server or exception text', () => {
    expect(userError(new Error('download failed', { cause: Object.assign(new Error('disk full'), { code: 'ENOSPC' }) }))).toContain('not enough free space')
    const failure = { name: 'Error', message: 'INTERNAL /private/db <script>secret</script>', cause: null }
    const actions: ErrorAction[] = ['install', 'launch', 'verify', 'repair', 'move', 'folder', 'settings', 'storage', 'uninstall', 'runtime', 'update', 'cache', 'logs', 'general', 'background']
    for (const action of actions) {
      const message = userError(failure, action)
      expect(message).not.toMatch(/INTERNAL|private|script|secret/)
      expect(Object.hasOwn(messages, message)).toBe(true)
    }
  })

  it('lets displayed error keys follow the selected language without leaking the underlying exception', () => {
    const key = userError('AbortError: The operation was aborted', 'update')
    for (const locale of ['id', 'zh-CN', 'ko', 'ja', 'jv'] as const) {
      expect(translate(key, locale)).not.toBe(key)
      expect(translate(key, locale)).not.toContain('AbortError')
    }
  })
})
