import { readRecord, writeRecords } from './localDatabase'

export async function getSilverIntroduction(): Promise<{ eligible: boolean }> {
  const choice = readRecord<string>('launcher', 'silverPalaceIntroduction')
  return { eligible: choice !== 'interested' && choice !== 'dismissed' }
}
export function setSilverIntroductionChoice(choice: unknown): void {
  if (choice !== 'interested' && choice !== 'dismissed') throw new Error('Invalid introduction choice.')
  writeRecords('launcher', { silverPalaceIntroduction: choice })
}
