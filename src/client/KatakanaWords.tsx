import { useEffect, useRef, useState } from 'react';
import { ArrowRight, RotateCcw } from 'lucide-react';
import { api } from './api';
import { Button } from './ui';
import { getPreferences, setPreferences, usePreferences, useTranslation } from './preferences';
import { katakanaToHiragana, type KatakanaBatch, type KatakanaWord } from '../shared/katakana-words';

const bufferLimit = 5;
type BatchRequest = { requestId: string; recent: string[]; count: number };

export function KatakanaWords() {
  const t = useTranslation();
  const preferences = usePreferences();
  const [word, setWord] = useState<KatakanaWord | null>(null);
  const [answer, setAnswer] = useState('');
  const [feedback, setFeedback] = useState<'correct' | 'wrong' | null>(null);
  const [fetching, setFetching] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const [error, setError] = useState('');
  const [count, setCount] = useState(0);
  const current = useRef<KatakanaWord | null>(null);
  const queue = useRef<KatakanaWord[]>([]);
  const recent = useRef<string[]>([]);
  const request = useRef<AbortController | null>(null);
  const retry = useRef<BatchRequest | null>(null);
  const awaitingNext = useRef(false);
  const passed = useRef(false);
  const alive = useRef(true);
  const composing = useRef(false);
  const input = useRef<HTMLInputElement>(null);
  const advanceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; request.current?.abort(); if (advanceTimer.current) clearTimeout(advanceTimer.current); };
  }, []);
  useEffect(() => { if (word && !waiting) input.current?.focus(); }, [word, waiting]);
  useEffect(() => {
    if (!preferences.autoAdvanceOnEnter && advanceTimer.current) { clearTimeout(advanceTimer.current); advanceTimer.current = null; }
  }, [preferences.autoAdvanceOnEnter]);

  function consume() {
    const next = queue.current.shift();
    if (!next) return false;
    current.current = next; passed.current = false; awaitingNext.current = false;
    setWord(next); setAnswer(''); setFeedback(null); setWaiting(false);
    return true;
  }

  async function refill() {
    if (!alive.current || request.current) return;
    const missing = current.current ? bufferLimit - queue.current.length : 1;
    if (missing <= 0) return;
    const controller = new AbortController(); request.current = controller;
    // Keep the exact batch and ID for retries; consuming a buffered word can only
    // increase the free space while this request is in flight.
    retry.current ??= { requestId: crypto.randomUUID(), recent: [...recent.current], count: missing };
    const batch = retry.current;
    setFetching(true); setError('');
    let successful = false;
    const timeout = setTimeout(() => {
      controller.abort();
      if (alive.current && request.current === controller) {
        request.current = null; awaitingNext.current = false;
        setFetching(false); setWaiting(false);
        setError(t('出题超时，请重试。', '時間がかかりすぎました。再試行してください。'));
      }
    }, 40000);
    try {
      const result = await api<KatakanaBatch>('/katakana/words', { method: 'POST', signal: controller.signal, body: JSON.stringify(batch) });
      if (!alive.current || controller.signal.aborted) return;
      queue.current.push(...result.words);
      recent.current = [...recent.current, ...result.words.map(item => item.word)].slice(-100);
      retry.current = null; successful = true;
      if (awaitingNext.current) consume();
    } catch (failure) {
      if (alive.current && request.current === controller) {
        setError(controller.signal.aborted ? t('出题超时，请重试。', '時間がかかりすぎました。再試行してください。') : (failure as Error).message);
        awaitingNext.current = false; setWaiting(false);
      }
    } finally {
      clearTimeout(timeout);
      if (request.current === controller) {
        request.current = null;
        if (alive.current) {
          setFetching(false);
          // Fill to five future words, including any space freed during the request.
          if (successful && current.current && queue.current.length < bufferLimit) void refill();
        }
      }
    }
  }

  function next() {
    if (!alive.current || awaitingNext.current) return;
    if (advanceTimer.current) { clearTimeout(advanceTimer.current); advanceTimer.current = null; }
    if (!consume()) { awaitingNext.current = true; setWaiting(true); }
    void refill();
  }

  function submit() {
    if (composing.current || waiting || !word || !answer.trim() || advanceTimer.current) return;
    const correct = answer.trim() === katakanaToHiragana(word.word) || answer.trim() === word.word;
    setFeedback(correct ? 'correct' : 'wrong');
    if (!correct) return;
    if (!passed.current) { passed.current = true; setCount(value => value + 1); }
    if (getPreferences().autoAdvanceOnEnter) {
      advanceTimer.current = setTimeout(() => {
        advanceTimer.current = null;
        if (alive.current && getPreferences().autoAdvanceOnEnter) next();
      }, 700);
    }
  }

  return <section className="study-card kana-practice katakana-word-practice">
    <header className="katakana-heading practice-instruction">
      <h1>{t('片假名单词 · AI练习', 'カタカナ単語 · AI練習')}</h1>
      <p>{t('不限教材、领域或难度，随机练习真实片假名单词。', '教材・分野・難易度を問わず、実際に使われるカタカナ単語をランダムに練習します。')}</p>
    </header>
    <div className="katakana-toolbar"><span className="tiny-note practice-instruction">{t('已完成', '完了')} {count}</span><Button disabled={waiting} onClick={next}>{word ? t('下一题', '次の問題') : t('开始练习', '練習を始める')}<ArrowRight size={18}/></Button></div>
    {error && <div role="alert"><p>{error}</p><Button secondary disabled={fetching} onClick={() => { if (!word) next(); else void refill(); }}><RotateCcw size={18}/>{t('重试出题', '再試行')}</Button></div>}
    {fetching && <p className="tiny-note" role="status">{waiting ? t('正在出题……', '問題を作成中…') : t('正在准备下一题……', '次の問題を準備中…')}</p>}
    {word && <><div className="kana-prompt kana-word" lang="ja">{word.word}</div>
      <form className="katakana-answer-form" onSubmit={event => { event.preventDefault(); }}>
        <label htmlFor="katakana-word-answer" className="dictation-label answer-label">{t('平假名或片假名', 'ひらがな・カタカナ')}</label>
        <input ref={input} id="katakana-word-answer" aria-label={t('平假名或片假名', 'ひらがな・カタカナ')} lang="ja" autoComplete="off" spellCheck={false} value={answer} readOnly={feedback === 'correct'} disabled={waiting}
          onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }}
          onKeyDown={event => {
            if (event.key !== 'Enter' || event.nativeEvent.isComposing || composing.current || event.keyCode === 229) return;
            event.preventDefault();
            if (!event.repeat) { if (feedback === 'correct') next(); else submit(); }
          }} onChange={event => { setAnswer(event.target.value); setFeedback(null); }}/>
        <p className="tiny-note practice-instruction katakana-input-hint">{t('按回车提交，答对后再按回车下一题。长音保留「ー」。', 'Enterで回答。正解後、もう一度Enterで次の問題へ。長音「ー」はそのまま入力してください。')}</p>
        <div className="katakana-options"><label className="toggle-row auto-advance-toggle"><input type="checkbox" role="switch" checked={preferences.autoAdvanceOnEnter} onChange={event => setPreferences({ autoAdvanceOnEnter: event.target.checked })}/><span>{t('回车答对自动下一题', 'Enterで正解したら次の問題へ')}</span></label></div>
      </form></>}
    <p className="katakana-feedback" role="status">{feedback === 'correct' ? t('正确', '正解') : feedback === 'wrong' ? t('请再试一次', 'もう一度試してください') : '\u00a0'}</p>
    {word && feedback === 'correct' && <p className="katakana-meaning">{t('中文释义', '中国語の意味')}：{word.meaningZh}</p>}
  </section>;
}
