import heroBackground from './assets/hero-background.png'
import silverBackground from './assets/silver-palace.jpg'
import type { GameId } from './gameCatalog'
export const GAME_ARTWORK: Record<GameId, string> = {
  csore_global: heroBackground,
  cedar_global: silverBackground
}
