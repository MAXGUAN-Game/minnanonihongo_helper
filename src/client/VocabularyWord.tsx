import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Volume2, X } from 'lucide-react';
import type { VocabularyEntry } from '../shared/vocabulary';
import type { VocabularyGrammar } from '../shared/vocabulary-details';
import type { Speech } from './speech';
import { api } from './api';
import { useTranslation } from './preferences';

// Only one word dialog across a list or practice screen can be open.
const openEvent = 'vocabulary-detail-open';
export function VocabularyWord({ word, lessonId, wordId, speech, pronunciation = true }: {
  word: string; lessonId: number; wordId: string; speech: Speech; pronunciation?: boolean;
}) {
  const t = useTranslation(), id = useId();
  const [open, setOpen] = useState(false), [entry, setEntry] = useState<VocabularyEntry | null>(null);
  const [error, setError] = useState(''), [audioError, setAudioError] = useState('');
  const [grammar, setGrammar] = useState<VocabularyGrammar | null>(null), [analyzing, setAnalyzing] = useState(false);
  const [position, setPosition] = useState({ top: 80, left: 16, maxHeight: 600 });
  const trigger = useRef<HTMLButtonElement>(null), panel = useRef<HTMLDivElement>(null);
  const grammarRequest = useRef<AbortController | null>(null), audioRequest = useRef<AbortController | null>(null);
  const audioUrl = useRef<string | null>(null);
  const sourceId = `word:${id}`;
  function close() { setOpen(false); grammarRequest.current?.abort(); setAnalyzing(false); trigger.current?.focus({ preventScroll: true }); }
  useEffect(() => () => { grammarRequest.current?.abort(); audioRequest.current?.abort(); speech.stopSource(sourceId); if (audioUrl.current) URL.revokeObjectURL(audioUrl.current); }, [wordId]);
  useEffect(() => {
    const other = (event: Event) => { if ((event as CustomEvent).detail !== id) { setOpen(false); grammarRequest.current?.abort(); setAnalyzing(false); } };
    window.addEventListener(openEvent, other); return () => window.removeEventListener(openEvent, other);
  }, [id]);
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController(); setError('');
    void api<VocabularyEntry>(`/lessons/${lessonId}/vocabulary/${encodeURIComponent(wordId)}`, { signal: controller.signal })
      .then(value => { if (!controller.signal.aborted) setEntry(value); }).catch(e => { if (!controller.signal.aborted) setError(e.message); });
    const place = () => { const box = trigger.current?.getBoundingClientRect(); if (!box) return; const below = window.innerHeight - box.bottom - 20; const above = box.top - 20; const useBelow = below >= 240 || below >= above; const maxHeight = Math.max(100, Math.min(700, useBelow ? below : above)); setPosition({ left: Math.max(12, Math.min(box.left, window.innerWidth - 572)), top: useBelow ? Math.max(12, box.bottom + 8) : Math.max(12, box.top - maxHeight - 8), maxHeight }); };
    place();
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); } };
    const outside = (event: PointerEvent) => { if (!panel.current?.contains(event.target as Node) && !trigger.current?.contains(event.target as Node)) setOpen(false); };
    window.addEventListener('keydown', key); window.addEventListener('pointerdown', outside); window.addEventListener('resize', place); window.addEventListener('scroll', place, true);
    return () => { controller.abort(); grammarRequest.current?.abort(); window.removeEventListener('keydown', key); window.removeEventListener('pointerdown', outside); window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true); };
  }, [open, lessonId, wordId]);
  async function pronounce(rate = 1) {
    audioRequest.current?.abort(); const controller = new AbortController(); audioRequest.current = controller; setAudioError(''); speech.stop();
    const epoch = speech.getEpoch();
    try {
      if (!audioUrl.current) {
        const response = await fetch(`/api/lessons/${lessonId}/vocabulary/${encodeURIComponent(wordId)}/audio`, { signal: controller.signal });
        if (!response.ok) { const body = await response.json(); if (response.status === 401) window.dispatchEvent(new Event('auth-required')); throw new Error(body.error || t('发音暂不可用', '音声を利用できません')); }
        const blob = await response.blob(); if (controller.signal.aborted) return; audioUrl.current = URL.createObjectURL(blob);
      }
      if (controller.signal.aborted) return;
      if (speech.getEpoch() !== epoch) return;
      speech.setPlaybackRate(rate); speech.playUrl(audioUrl.current, word, sourceId);
    } catch (failure) { if (!controller.signal.aborted) setAudioError((failure as Error).message); }
  }
  async function analyze() {
    if (analyzing) return;
    const controller = new AbortController(); grammarRequest.current = controller; setAnalyzing(true); setError('');
    try { const value = await api<VocabularyGrammar>(`/lessons/${lessonId}/vocabulary/${encodeURIComponent(wordId)}/grammar`, { method: 'POST', signal: controller.signal }); if (!controller.signal.aborted) setGrammar(value); }
    catch (failure) { if (!controller.signal.aborted) setError((failure as Error).message); }
    finally { if (!controller.signal.aborted) setAnalyzing(false); }
  }
  function systemVoice() { speech.stop(); const utterance = new SpeechSynthesisUtterance(entry?.reading || word); utterance.lang = 'ja-JP'; window.speechSynthesis.speak(utterance); }
  const audioFailure = audioError && <div className="word-audio-error" role="alert">{audioError} <button type="button" className="text-button" onClick={systemVoice}>{t('使用系统发音', 'システム音声を使う')}</button></div>;
  return <span className="vocabulary-word"><button ref={trigger} type="button" lang="ja" className="word-trigger" aria-expanded={open} aria-controls={open ? id : undefined} onClick={() => { if (open) close(); else { setAnalyzing(false); window.dispatchEvent(new CustomEvent(openEvent, { detail: id })); setOpen(true); } }}>{word}</button>
    {pronunciation && <button type="button" className="word-speaker" aria-label={`${word} · ${t('发音', '発音')}`} onClick={() => void pronounce()}><Volume2 size={19}/></button>}
    {!open && audioFailure}
    {open && createPortal(<div ref={panel} role="dialog" aria-labelledby={`${id}-title`} id={id} className="word-popover" style={position}>
      <button type="button" className="word-close" aria-label={t('关闭详情', '詳細を閉じる')} onClick={close}><X size={20}/></button>
      <h2 id={`${id}-title`} lang="ja">{word}</h2>
      {!entry && !error && <p role="status">{t('正在读取详情……', '詳細を読み込んでいます…')}</p>}
      {entry && <><p lang="ja">{entry.reading} <span className="word-romaji">{entry.detail?.romaji}</span></p>
        <div className="word-pronunciation"><button type="button" onClick={() => void pronounce()}><Volume2 size={16}/> {t('发音', '発音')}</button><button type="button" onClick={() => void pronounce(.75)}><Volume2 size={16}/> {t('慢速', 'ゆっくり')}</button></div>
        <p><span className="pill">{entry.partOfSpeech}</span> {entry.detail?.attributes.map(value => <span className="pill" key={value}>{value}</span>)} {entry.meaning}</p>
        {entry.detail ? <><p>{entry.detail.explanation}</p><section className="word-example"><h3>{t('单词例句', '例文')}</h3><p className="reading" lang="ja">{entry.detail.example.kana}</p><p className="japanese" lang="ja">{entry.detail.example.jp}</p><p className="word-romaji">{entry.detail.example.romaji}</p><p>{entry.detail.example.zh}</p></section>
          <button type="button" className="text-button" disabled={analyzing} onClick={() => void analyze()}>{analyzing ? t('正在分析语法……', '文法を分析しています…') : t('语法', '文法')}</button>
          {grammar && <section aria-label={t('例句语法', '例文の文法')}><p>{grammar.structure}</p>{grammar.points.map((point, i) => <p key={i}><strong lang="ja">{point.expression}</strong>：{point.explanation}</p>)}</section>}</> : <p>{t('此词详情暂不可用。', 'この単語の詳細は準備中です。')}</p>}
      </>}{error && <p role="alert">{error}</p>}{audioFailure}
    </div>, document.body)}
  </span>;
}
