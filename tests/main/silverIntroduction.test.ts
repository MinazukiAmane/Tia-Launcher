import { expect, it, vi } from 'vitest'
import { readRecord, writeRecords } from '../../src/main/localDatabase'
import { getSilverIntroduction, setSilverIntroductionChoice } from '../../src/main/silverIntroduction'
import { selectGame } from '../../src/main/activeGame'

it('offers the introduction on a fresh profile and an existing CSO profile after an update', async () => {
  expect(await getSilverIntroduction()).toEqual({ eligible: true })
  writeRecords('launcher', { selectedInstallation: { installDir: '/existing/cso' }, preferences: { launcherLanguage: 'id' } })
  expect(await getSilverIntroduction()).toEqual({ eligible: true })
})
it.each(['interested', 'dismissed'] as const)('remembers %s across reloads and games, without changing installation or language', async choice => {
  writeRecords('launcher', { selectedInstallation: { installDir: '/existing/cso' }, preferences: { launcherLanguage: 'id' } })
  setSilverIntroductionChoice(choice)
  expect(await getSilverIntroduction()).toEqual({ eligible: false })
  selectGame('cedar_global')
  try {
    vi.resetModules()
    const reloaded = await import('../../src/main/silverIntroduction')
    expect(await reloaded.getSilverIntroduction()).toEqual({ eligible: false })
    expect(readRecord('launcher', 'selectedInstallation')).toEqual({ installDir: '/existing/cso' })
    expect(readRecord('launcher', 'preferences')).toEqual({ launcherLanguage: 'id' })
  } finally { selectGame('csore_global') }
})
it('rejects invalid choices without treating them as an answer', async () => {
  for (const choice of [null, true, '', {}, 'yes', 'other']) expect(() => setSilverIntroductionChoice(choice)).toThrow(/Invalid introduction/)
  expect(await getSilverIntroduction()).toEqual({ eligible: true })
})
