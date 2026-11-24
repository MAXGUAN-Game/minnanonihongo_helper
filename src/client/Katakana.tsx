import { translate, localize } from './i18n';
import { useKatakanaCredit } from './katakana-credit';
import { useEffect, useRef, useState } from 'react';
import { shuffledKana } from '../shared/kana';
import { getPreferences, setPreferences, usePreferences, useTranslation } from './preferences';
import { KatakanaWords } from './KatakanaWords';
import { ArrowRight } from 'lucide-react';
import { Button } from './ui';
import { SpecialRank } from './RankProgress';

export function Katakana() {
  const t = useTranslation();
  const [mode, setMode] = useState<'kana' | 'ai'>('kana');
  return <><SpecialRank topic="katakana"/><div className="content-switch"><button aria-pressed={mode === 'kana'} className={mode === 'kana' ? 'active' : ''} onClick={() => setMode('kana')}>{t('假名练习', '文字の練習')}</button><button aria-pressed={mode === 'ai'} className={mode === 'ai' ? 'active' : ''} onClick={() => setMode('ai')}>{t('AI练习', 'AI練習')}</button></div>{mode === 'kana' ? <KanaCharacters/> : <KatakanaWords/>}</>;
}

function KanaCharacters() {
  const t = useTranslation();
  const preferences = usePreferences();
  const [queue, setQueue] = useState(() => shuffledKana());
  const [answer, setAnswer] = useState('');
  const [feedback, setFeedback] = useState<'correct' | 'wrong' | null>(null);
  const [count, setCount] = useState(0);
  const composing = useRef(false);
  const input = useRef<HTMLInputElement>(null);
  const advanceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const passed = useRef(false);
  const credit = useKatakanaCredit();
  const questionId = useRef(crypto.randomUUID());
  const item = queue[0];
  useEffect(() => () => { if (advanceTimer.current) clearTimeout(advanceTimer.current); }, []);
  useEffect(() => { input.current?.focus({ preventScroll: true }); }, [item.hiragana]);
  useEffect(() => {
    if (!preferences.autoAdvanceOnEnter && advanceTimer.current) { clearTimeout(advanceTimer.current); advanceTimer.current = null; }
  }, [preferences.autoAdvanceOnEnter]);
  function next() {
    if (credit.pending) return;
    if (advanceTimer.current) { clearTimeout(advanceTimer.current); advanceTimer.current = null; }
    setQueue(old => old.length > 1 ? old.slice(1) : shuffledKana(old[0].hiragana));
    passed.current = false; questionId.current = crypto.randomUUID(); setAnswer(''); setFeedback(null);
  }
  async function submit() {
    if (credit.pending) return;
    if (composing.current || !answer.trim() || advanceTimer.current) return;
    const correct = answer.trim() === item.hiragana || answer.trim() === item.katakana;
    if (!correct) setFeedback('wrong');
    if (!correct) return;
    if (!passed.current) { if (!await credit.record(questionId.current, 'kana', item.katakana, answer.trim())) return; passed.current = true; setCount(n => n + 1); }
    setFeedback('correct');
    if (getPreferences().autoAdvanceOnEnter) advanceTimer.current = setTimeout(() => {
      advanceTimer.current = null;
      if (getPreferences().autoAdvanceOnEnter) next();
    }, 700);
  }
  return <section className="study-card kana-practice katakana-word-practice">
    <header className="katakana-heading practice-instruction"><h1>{t('片假名', 'カタカナ')}</h1>
      <p>{t('输入对应平假名或片假名，按回车提交，答对后再按回车下一题。', '対応するひらがな、またはカタカナを入力してEnterで回答。正解後、もう一度Enterで次の問題へ進みます。')}</p></header>
    <div className="katakana-toolbar"><span className="tiny-note practice-instruction">{t('已完成', '完了')} {localize(count)} · 104 {t('项', '項目')}</span><Button disabled={credit.pending} onClick={next}>{t('下一题', '次の問題')}<ArrowRight size={18}/></Button></div>
    <div className="kana-prompt kana-character" lang="ja">{item.katakana}</div>
    <form className="katakana-answer-form" onSubmit={event => { event.preventDefault(); }}>
      <label htmlFor="kana-answer" className="dictation-label answer-label">{t('平假名或片假名', 'ひらがな・カタカナ')}</label>
      <input ref={input} id="kana-answer" lang="ja" autoComplete="off" spellCheck={false} value={answer} readOnly={feedback === 'correct' || credit.pending}
        onCompositionStart={() => { composing.current = true; }}
        onCompositionEnd={() => { composing.current = false; }}
        onKeyDown={event => {
          if (event.key !== 'Enter' || event.repeat || event.nativeEvent.isComposing || composing.current) return;
            if (feedback === 'correct') { event.preventDefault(); next(); return; }
            if (event.keyCode === 229) return;
          event.preventDefault();
          submit();
        }}
        onChange={event => { setAnswer(event.target.value); setFeedback(null); }}/>
      <div className="katakana-options"><label className="toggle-row auto-advance-toggle"><input type="checkbox" role="switch" checked={preferences.autoAdvanceOnEnter} onChange={event => setPreferences({ autoAdvanceOnEnter: event.target.checked })}/><span>{t('回车答对自动下一题', 'Enterで正解したら次の問題へ')}</span></label></div>
    </form>
    <>{credit.error && <p role="alert">{localize(credit.error)}</p>}{credit.pending && <p role="status">{t("正在保存进度……", "保存中…")}</p>}</><p className="katakana-feedback" role="status">{localize(feedback === 'correct' ? t('正确', '正解') : feedback === 'wrong' ? t('请再试一次', 'もう一度試してください') : '\u00a0')}</p>
  </section>;
}
