import { useEffect, useRef, useState } from 'react'
import illustration from '../assets/silver-palace-introduction.png'
import { t, useLauncherLanguage } from '../i18n'

export function SilverPalaceIntroduction({ enabled, onDone, onOpenGame }: { enabled: boolean; onDone: () => void; onOpenGame: () => void }): React.JSX.Element {
  useLauncherLanguage()
  const [stage, setStage] = useState<'question' | 'about'>('question')
  const [busy, setBusy] = useState(false)
  const [saveFailed, setSaveFailed] = useState(false)
  const [updateBlocking, setUpdateBlocking] = useState(true)
  const dialog = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    let mounted = true
    const apply = (state: Awaited<ReturnType<typeof window.csore.getUpdateState>>): void => {
      if (mounted) setUpdateBlocking(state.versionStatus === 'checking' || state.versionStatus === 'required' || !!state.available)
    }
    void window.csore.getUpdateState().then(apply).catch(() => { if (mounted) setUpdateBlocking(false) })
    const unsubscribe = window.csore.onUpdateState(apply)
    return () => { mounted = false; unsubscribe() }
  }, [])
  useEffect(() => {
    if (enabled && !updateBlocking && !dialog.current?.open) dialog.current?.showModal()
    else if ((!enabled || updateBlocking) && dialog.current?.open) dialog.current.close()
  }, [enabled, updateBlocking])
  function close(): void { dialog.current?.close(); onDone() }
  async function choose(choice: 'interested' | 'dismissed'): Promise<void> {
    if (busy) return
    setBusy(true)
    try { await window.csore.setSilverIntroductionChoice(choice) }
    catch { setSaveFailed(true) }
    finally { setBusy(false) }
    if (choice === 'interested') setStage('about')
    else close()
  }
  return <dialog ref={dialog} className={`silver-introduction ${stage === 'about' ? 'silver-introduction-about' : ''}`} aria-labelledby="silver-introduction-title" onCancel={event => { event.preventDefault(); if (!busy) { if (stage === 'question') void choose('dismissed'); else close() } }}>
    {stage === 'about' && <img className="silver-introduction-image" src={illustration} alt="Silvernia" />}
    <button type="button" className="silver-introduction-close" aria-label={t('Close')} disabled={busy} onClick={() => { if (stage === 'question') void choose('dismissed'); else close() }}>×</button>
    <div className="silver-introduction-copy">
      <p className="silver-introduction-label">{t('New in Tia')}</p>
      <h2 id="silver-introduction-title">{t(stage === 'question' ? 'Curious about Silver Palace?' : 'Discover Silver Palace')}</h2>
      {stage === 'question' ? <p>{t('Tia now includes Silver Palace alongside CSO: Re-Server Edition. Curious about the new game? Take a quick look before deciding what to play.')}</p> : <>
        <p>{t('Silver Palace is an open-world fantasy action RPG built with Unreal Engine 5. Its anime-style cast and Victorian-inspired setting bring detective work, exploration and action combat into the same adventure.')}</p>
        <section className="silver-introduction-section"><h3>{t('A city changed by Silverium')}</h3><p>{t('Welcome to Silvernia, a prosperous metropolis transformed by the discovery of Silverium. This extraordinary resource has reshaped industry, technology and everyday life, drawing people into a city built around its power. Behind that progress, control of Silverium has become the focus of competition between powerful interests.')}</p></section>
        <section className="silver-introduction-section"><h3>{t('Step into the role of a detective')}</h3><p>{t('You step into this world as a detective. Investigating crimes and uncovering hidden truths means following clues through the city and looking beyond its polished exterior. Corporate monopolies, underground syndicates, royal affiliates and cults all have their own interests in Silverium, placing your investigations among competing sides.')}</p></section>
        <section className="silver-introduction-section"><h3>{t('Companions and real-time combat')}</h3><p>{t('You do not face these mysteries alone. A varied group of partners joins the adventure, with combat that lets you switch characters in real time, use their skills and link QTE combinations. Investigating a scene, searching for clues and confronting enemies form different parts of the journey through Silvernia.')}</p></section>
        <section className="silver-introduction-section"><h3>{t('A life beyond the next case')}</h3><p>{t('Silvernia is also presented as a place to spend time in, rather than only a backdrop for cases. The official game overview highlights meeting an eclectic cast, forming connections and discovering what lies beyond detective work. Whether you picture making your name through property or becoming a familiar face at a small café, the city offers an identity outside your next investigation. Exploring, talking, investigating and fighting all sit within its broader adventure.')}</p></section>
        <p className="silver-introduction-note">{t('You can keep playing CSO or visit the Silver Palace page whenever you like. Opening its page does not start a download.')}</p>
      </>}
      {saveFailed && <p role="status">{t('Your choice could not be saved. This introduction may appear again next time.')}</p>}
    </div>
    <div className="silver-introduction-actions">
        <button type="button" disabled={busy} onClick={() => { if (stage === 'question') void choose('dismissed'); else close() }}>{t(stage === 'question' ? 'No, thanks' : 'Close')}</button>
        <button type="button" className="silver-introduction-primary" disabled={busy} onClick={() => { if (stage === 'question') void choose('interested'); else { close(); onOpenGame() } }}>{t(stage === 'question' ? 'Yes, show me' : 'View Silver Palace')}</button>
    </div>
  </dialog>
}
