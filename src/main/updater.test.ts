import { describe, it, expect } from 'vitest'
import { initialUpdateState } from './updater'

describe('initialUpdateState', () => {
  it('starts with no available update, no progress, not downloaded, no error', () => {
    expect(initialUpdateState()).toEqual({
      available: null,
      progress: null,
      downloaded: false,
      error: null
    })
  })
})
