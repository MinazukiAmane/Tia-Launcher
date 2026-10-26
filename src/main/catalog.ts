import catalog from '../shared/games.json'
import type { GameDefinition } from '../shared/gameDefinition'
export type { GameDefinition, GameId } from '../shared/gameDefinition'
export const GAMES = catalog.games as readonly GameDefinition[]
export const LAUNCHER_API_BASE_URL = catalog.apiBaseUrl
