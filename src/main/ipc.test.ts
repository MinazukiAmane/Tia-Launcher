import { describe, it, expect } from 'vitest'
import { handlePing } from './ipc'

describe('handlePing', () => {
  it('returns pong', async () => {
    expect(await handlePing()).toBe('pong')
  })
})
