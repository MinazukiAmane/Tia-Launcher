import { useState } from 'react'
import { GAMES, type GameId } from '../gameCatalog'
import { GAME_ARTWORK } from '../gameArtwork'
import { t } from '../i18n'

export function GameLibrary({ selected, disabled, onSelect }: { selected: GameId; disabled: boolean; onSelect: (biz: GameId) => void }): React.JSX.Element {
  const [preview, setPreview] = useState<GameId>(selected)
  return <section className="game-library" aria-label={t('Game library')}>
    <div className="library-backgrounds" aria-hidden="true">
      {GAMES.map(game => <div key={game.biz} className="library-background" data-visible={preview === game.biz} style={{ backgroundImage: `url(${GAME_ARTWORK[game.biz]})` }} />)}
    </div>
    <div className="library-shade" />
    <div className="library-cards" aria-label={t('Choose a game')}>
      {GAMES.map(game => <button key={game.biz} type="button" className="library-game-card" disabled={disabled}
        aria-label={t('Open {game}', { game: game.title })} data-game={game.biz} data-preview={preview === game.biz}
        onMouseEnter={() => setPreview(game.biz)} onFocus={() => setPreview(game.biz)} onClick={() => onSelect(game.biz)}>
        <img src={GAME_ARTWORK[game.biz]} alt="" draggable={false} />
        <span>{game.title}</span>
      </button>)}
    </div>
  </section>
}
