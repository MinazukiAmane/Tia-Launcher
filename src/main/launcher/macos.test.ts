
import { describe, it, expect } from 'vitest'
import { launchMacOS, WhiskyNotFoundError } from './macos'

describe('launchMacOS', () => {
  it('wraps a wine invocation failure in a clear, actionable error message', async () => {

    await expect(launchMacOS('/nonexistent/prefix', '/nonexistent/game.exe', [])).rejects.toThrow(
      /Whisky/i
    )
  })
})

describe('WhiskyNotFoundError', () => {
  it('has a message pointing the player at manual installation', () => {
    const err = new WhiskyNotFoundError()
    expect(err.message).toMatch(/install whisky manually/i)
  })
})
