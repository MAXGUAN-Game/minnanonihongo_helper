import { translate } from './i18n';
import { VocabularyList } from './VocabularyList';
import { useState } from 'react';
import { ArrowLeft, ArrowRight, BookOpen, Check, Headphones, Mic } from 'lucide-react';
import type { Bootstrap, Lesson, Mastery, Progress, Stage } from '../shared/types';
import type { Speech } from './speech';
import { post } from './api';
import { Button, Sentence } from './ui';
import { TextbookAudio } from './TextbookAudio';
import { AudioControls } from './AudioControls';
import { AIPractice } from './AIPractice';
import { useTranslation } from './preferences';
import { MasteryPanel } from './MasteryPanel';


export function Study({ lesson, bootstrap, speech, notice, refresh }: { lesson: Lesson; bootstrap: Bootstrap; speech: Speech; notice: (message: string) => void; refresh: () => Promise<void> }) {
  const t = useTranslation();
  const stages: { id: Stage; label: string; icon: typeof BookOpen }[] = [{ id: 'vocabulary', label: t('单词', '単語'), icon: BookOpen }, { id: 'understand', label: t('语法', '文法'), icon: BookOpen }, { id: 'listen', label: t('听力', '聴解'), icon: Headphones }, { id: 'speak', label: t('口语', '会話'), icon: Mic }];
  const records = bootstrap.progress.filter(item => item.lessonId === lesson.id);
  const latest = [...records].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
  const [stage, setStage] = useState<Stage>(latest?.stage === 'conversation' ? 'speak' : latest?.stage || 'vocabulary');
  const [index, setIndex] = useState(latest?.cursor || 0);
  const [wordMode, setWordMode] = useState<'list' | 'ai'>('list');
  const [listenMode, setListenMode] = useState<'original' | 'textbook' | 'ai'>('textbook');
  const [aiListenKind, setAiListenKind] = useState<'dictation' | 'dialogue'>('dictation');
  const isAI = (stage === 'listen' && listenMode === 'ai') || stage === 'speak';
  const [reveal, setReveal] = useState(false);
  const [usedHint, setUsedHint] = useState(false);
  const [picked, setPicked] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const settings = bootstrap.settings;
  const items = stage === 'understand' ? lesson.grammar : stage === 'listen' ? lesson.listening : lesson.speaking;
  const cursor = Math.min(index, items.length - 1);
  async function save(nextStage: Stage, nextCursor: number, status: Mastery = 'seen', itemId?: string) {
    await post<Progress>('/progress', { lessonId: lesson.id, stage: nextStage, cursor: nextCursor, status, itemId }); await refresh();
  }
  function resetCard() { speech.stop(); setReveal(false); setPicked(null); setUsedHint(false); }
  async function changeStage(next: Stage) { if (busy) return; const prior = records.find(p => p.stage === next); setBusy(true); try { await save(next, prior?.cursor || 0); resetCard(); setStage(next); setIndex(prior?.cursor || 0); } catch (error) { notice((error as Error).message); } finally { setBusy(false); } }
  async function move(delta: number, status: Mastery = 'seen') {
    if (busy) return; setBusy(true);
    try {
      await save(stage, cursor, status, items[cursor]?.id);
      if (cursor + delta >= items.length) {
        const nextStage = stages[stages.findIndex(s => s.id === stage) + 1]?.id || 'speak';
        await save(nextStage, 0); setStage(nextStage); setIndex(0);
      } else { const nextIndex = Math.max(0, cursor + delta); await save(stage, nextIndex); setIndex(nextIndex); }
      resetCard();
    } catch (error) { notice((error as Error).message); } finally { setBusy(false); }
  }
  const grammar = lesson.grammar[cursor % lesson.grammar.length];
  const audio = lesson.listening[cursor % lesson.listening.length];
  const listeningSourceId = `study-listening:${audio.id}`;
  return <>
    <nav className="stage-tabs" aria-label={translate("每课学习步骤")}>{stages.map((item, i) => <button key={item.id} aria-label={item.label} title={item.label} aria-current={stage === item.id ? 'step' : undefined} className={stage === item.id ? 'active' : ''} onClick={() => void changeStage(item.id)} disabled={busy}><span className="stage-number">{i + 1}</span><item.icon size={20}/><span className="immersion-text">{item.label}</span></button>)}</nav>
    <MasteryPanel lessonId={lesson.id} stage={stage} revision={records.find(record => record.stage === stage)?.updatedAt}/>

    {stage === 'listen' && <AIPracticeTabs value={listenMode} onChange={value => { speech.stop(); setListenMode(value); }} modes={[{ id: 'textbook', label: t('教材原声 MP3', '教材音声 MP3') }, { id: 'original', label: t('对话练习', '会話練習') }, { id: 'ai', label: t('AI练习', 'AI練習') }]}/>}
    {stage === 'listen' && listenMode === 'ai' && <AIPracticeTabs value={aiListenKind} onChange={value => { speech.stop(); setAiListenKind(value); }} modes={[{ id: 'dictation', label: translate('\u5355\u53e5\u542c\u529b') }, { id: 'dialogue', label: translate('\u5bf9\u8bdd\u542c\u529b') }]}/>}

    {(stage === 'understand' || (stage === 'listen' && listenMode === 'original')) && <nav className="study-navigation" aria-label={t('练习翻页', '練習ページ')}>
      {stage === 'understand' && <Button secondary disabled={busy} onClick={async () => { setBusy(true); try { await save('understand', cursor, 'independent', grammar.id); window.dispatchEvent(new Event('practice-assessed')); } catch (error) { notice((error as Error).message); } finally { setBusy(false); } }}><Check size={18}/>{t('标记已学会', '学習済みにする')}</Button>}
      <Button secondary disabled={busy || cursor === 0} onClick={() => void move(-1)}><ArrowLeft size={18}/>{translate('上一张')}</Button>
      <span className="tiny-note">{bootstrap.deployment === 'web' ? translate('进度保存在你的服务器') : translate('进度保存在本机')}</span>
      <Button disabled={busy} onClick={() => void move(1)}>{cursor + 1 < items.length ? translate('下一张') : t(`去${stages[stages.findIndex(s => s.id === stage) + 1]?.label}`, `${stages[stages.findIndex(s => s.id === stage) + 1]?.label}へ`)}<ArrowRight size={18}/></Button>
    </nav>}
    <section className={isAI ? "ai-practice-container" : "study-card"} aria-label={translate("当前练习")}>
      {stage === 'vocabulary' && <><AIPracticeTabs value={wordMode} onChange={value => { speech.stop(); setWordMode(value); }} modes={[{ id: 'list', label: t('单词列表', '単語一覧') }, { id: 'ai', label: t('AI练习', 'AI練習') }]}/>{wordMode === 'list' ? <VocabularyList lessonId={lesson.id} furigana={settings.furigana} speech={speech}/> : <AIPractice lessonId={lesson.id} kind="vocabulary" speech={speech} notice={notice} furigana={settings.furigana}/>}</>}
      {isAI && <AIPractice key={`${lesson.id}:${stage}:${aiListenKind}`} lessonId={lesson.id} kind={stage === 'speak' ? 'speaking' : aiListenKind} speech={speech} notice={notice} furigana={settings.furigana}/>}
      {stage === 'understand' && <><div className="card-label"><BookOpen size={18}/>{translate("一个句型，两个小例子")}</div><h2>{grammar.title}</h2><p className="explain-short">{grammar.explanation}</p><div className="pattern" aria-label={translate("句型结构")}>{grammar.pattern.map((part, i) => <span key={i} className={`pattern-part part-${i % 3}`}>{part}</span>)}</div><div className="example-list">{grammar.examples.map((example, i) => <Sentence key={i} example={example} speech={speech} furigana={settings.furigana}/>)}</div></>}
      {stage === 'listen' && listenMode === 'textbook' && <TextbookAudio lessonId={lesson.id} speech={speech}/>}
      {stage === 'listen' && listenMode === 'original' && <><div className="card-label"><Headphones size={18}/>{translate("先听，再看")}</div><h2>{audio.title}</h2><AudioControls speech={speech} sourceId={listeningSourceId} onPlay={() => speech.say(audio.lines.map(line => line.jp), 'ja-JP', 1, listeningSourceId)}/><h3 className="question-title">{audio.question}</h3><div className="answer-choices">{audio.options.map((option, i) => <button key={i} className={picked === i ? picked === audio.answer ? 'correct' : 'try-again' : ''} onClick={async () => { setPicked(i); if (i !== audio.answer) setUsedHint(true); try { await post('/attempts', { lessonId: lesson.id, itemId: audio.id, result: i === audio.answer ? usedHint ? 'hint' : 'good' : 'again', answer: option, usedHint }); await save(stage, cursor, i === audio.answer ? usedHint ? 'assisted' : 'independent' : 'seen', audio.id); } catch (error) { notice((error as Error).message); } }}><span>{String.fromCharCode(65 + i)}</span>{option}{picked === i && i === audio.answer && <Check size={19}/>}</button>)}</div>{picked !== null && <div className={`answer-feedback ${picked === audio.answer ? 'success' : ''}`} role="status">{picked === audio.answer ? translate('听懂这个意思了。') : translate('再听一遍，或者看看原文。')} {audio.explanation}</div>}<button className="text-button transcript-toggle" aria-expanded={reveal} onClick={() => { setReveal(!reveal); setUsedHint(true); }}>{reveal ? translate('收起原文') : translate('需要帮助？看原文与中文')}</button>{reveal && <div className="listening-transcript">{audio.lines.map((line, i) => <div className="dialogue-line" key={i}><span>{i % 2 ? 'B' : 'A'}</span><Sentence example={line} speech={speech} furigana={settings.furigana}/></div>)}</div>}</>}

    </section>

  </>;
}

function AIPracticeTabs<T extends string>({ value, onChange, modes }: { value: T; onChange: (value: T) => void; modes: { id: T; label: string }[] }) {
  return <div className="content-switch">{modes.map(mode => <button key={mode.id} className={value === mode.id ? 'active' : ''} aria-pressed={value === mode.id} onClick={() => onChange(mode.id)}>{mode.label}</button>)}</div>;
}
