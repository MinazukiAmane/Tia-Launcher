import { GAMES, type GameDefinition } from './catalog'
let active: GameDefinition = GAMES[0]
export function activeGame(): GameDefinition { return active }
export function selectGame(biz: unknown): GameDefinition {
  const game = GAMES.find(candidate => candidate.biz === biz)
  if (!game) throw new Error('Unknown game selection.')
  active = game
  return game
}
export function gamePreferenceScope(): string { return active.biz === 'csore_global' ? 'launcher' : 'title:' + active.biz }
