import { useState } from 'react';
import { ArrowLeft, ArrowRight, BookOpen, Check, Headphones, Lightbulb, MessageCircle, Mic, Plus, Repeat2, Volume2 } from 'lucide-react';
import type { Bootstrap, Correction, Example, Lesson, Mastery, Progress, Stage } from '../shared/types';
import type { Speech } from './speech';
import { post } from './api';
import { Button, Sentence } from './ui';
import { Conversation } from './Conversation';
import { SpeakingPractice, type SpeakingAnswer } from './SpeakingPractice';
import { RecordingHistory } from './RecordingHistory';
import { TextbookAudio } from './TextbookAudio';

const stages: { id: Stage; label: string; icon: typeof BookOpen }[] = [{ id: 'understand', label: '看懂', icon: BookOpen }, { id: 'listen', label: '听懂', icon: Headphones }, { id: 'speak', label: '自己说', icon: Mic }, { id: 'conversation', label: '用起来', icon: MessageCircle }];
export function Study({ lesson, bootstrap, speech, notice, refresh }: { lesson: Lesson; bootstrap: Bootstrap; speech: Speech; notice: (message: string) => void; refresh: () => Promise<void> }) {
  const records = bootstrap.progress.filter(item => item.lessonId === lesson.id);
  const latest = [...records].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
  const [stage, setStage] = useState<Stage>(latest?.stage || 'understand');
  const [index, setIndex] = useState(latest?.cursor || 0);
  const [wordIndex, setWordIndex] = useState(0);
  const [vocabulary, setVocabulary] = useState(false);
  const [textbook, setTextbook] = useState(false);
  const [reveal, setReveal] = useState(false);
  const [speakingLevel, setSpeakingLevel] = useState(2);
  const [usedHint, setUsedHint] = useState(false);
  const [picked, setPicked] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [reviewed, setReviewed] = useState<string[]>([]);
  const settings = bootstrap.settings;
  const items = stage === 'understand' ? lesson.grammar : stage === 'listen' ? lesson.listening : lesson.speaking;
  const cursor = Math.min(index, items.length - 1);
  async function save(nextStage: Stage, nextCursor: number, status: Mastery = 'seen', itemId?: string) {
    await post<Progress>('/progress', { lessonId: lesson.id, stage: nextStage, cursor: nextCursor, status, itemId }); await refresh();
  }
  function resetCard() { speech.stop(); setReveal(false); setPicked(null); setUsedHint(false); setSpeakingLevel(2); }
  async function changeStage(next: Stage) { if (busy) return; const prior = records.find(p => p.stage === next); setBusy(true); try { await save(next, prior?.cursor || 0); resetCard(); setVocabulary(false); setStage(next); setIndex(prior?.cursor || 0); } catch (error) { notice((error as Error).message); } finally { setBusy(false); } }
  async function move(delta: number, status: Mastery = 'seen') {
    if (busy) return; setBusy(true);
    try {
      await save(stage, cursor, status, items[cursor]?.id);
      if (cursor + delta >= items.length) {
        const nextStage = stages[stages.findIndex(s => s.id === stage) + 1]?.id || 'conversation';
        await save(nextStage, 0); setStage(nextStage); setIndex(0);
      } else { const nextIndex = Math.max(0, cursor + delta); await save(stage, nextIndex); setIndex(nextIndex); }
      resetCard();
    } catch (error) { notice((error as Error).message); } finally { setBusy(false); }
  }
  async function addReview(goal: string, answer: Example, sourceId: string, grammarId?: string) {
    try { await post('/reviews', { lessonId: lesson.id, goal, answer, sourceId, grammarId }); setReviewed(prev => [...prev, sourceId]); notice('已加入复习。明天先回想，再看答案。'); await refresh(); } catch (error) { notice((error as Error).message); }
  }
  async function recordSpeaking(result: 'again' | 'hint' | 'good', answer: SpeakingAnswer) {
    setBusy(true);
    try { const task = lesson.speaking[cursor]; const actual = result === 'good' && usedHint ? 'hint' : result; await post('/attempts', { lessonId: lesson.id, itemId: task.id, result: actual, ...answer, usedHint }); window.dispatchEvent(new Event('nihongo-recordings-changed')); await save(stage, cursor, actual === 'good' ? 'independent' : actual === 'hint' ? 'assisted' : 'seen', task.id); notice(actual === 'good' ? '已记录：这次独立说出来了。' : actual === 'hint' ? '已记录：借助提示完成。下次试着少看一点。' : '已记录：这句还需要再练。'); } catch (error) { notice((error as Error).message); } finally { setBusy(false); }
  }
  const grammar = lesson.grammar[cursor % lesson.grammar.length];
  const audio = lesson.listening[cursor % lesson.listening.length];
  const task = lesson.speaking[cursor % lesson.speaking.length];
  const word = lesson.vocabulary[wordIndex];
  const currentNarration = stage === 'understand' ? vocabulary ? `这个词是${word.meaning}。听读音，再用它说一句。` : `${grammar.title}。${grammar.explanation}` : stage === 'listen' ? `先听这段对话。你要找的信息是：${audio.question}。听完选一个答案。需要时，可以展开原文。` : stage === 'speak' ? `现在请你表达：${task.goal}。先看范句，再看关键词，最后自己试着说。说完以后，记录是否用了提示。` : '可以选场景练习，也可以进入语法自由聊。自由聊可以用中文问用法，或用日语练一句。按住说日语，松开后确认文字再发送。';
  return <>
    <nav className="stage-tabs" aria-label="每课学习步骤">{stages.map((item, i) => <button key={item.id} aria-current={stage === item.id ? 'step' : undefined} className={stage === item.id ? 'active' : ''} onClick={() => void changeStage(item.id)} disabled={busy}><span className="stage-number">{i + 1}</span><item.icon size={20}/>{item.label}</button>)}</nav>
    <div className="study-top"><span className="muted">{stage === 'conversation' ? '场景练习，或围绕本课语法自由聊' : `${vocabulary && stage === 'understand' ? wordIndex + 1 : cursor + 1} / ${vocabulary && stage === 'understand' ? lesson.vocabulary.length : items.length} · 一次只练一点`}</span><button className="text-button" onClick={() => speech.say(currentNarration, 'zh-CN')}><Volume2 size={18}/>听讲解</button></div>
    {stage === 'understand' && <div className="content-switch"><button className={!vocabulary ? 'active' : ''} onClick={() => { setVocabulary(false); speech.stop(); }}>语法图解</button><button className={vocabulary ? 'active' : ''} onClick={() => { setVocabulary(true); speech.stop(); }}>重点词卡 · {lesson.vocabulary.length}</button></div>}
    {stage === 'listen' && <div className="content-switch"><button className={!textbook ? 'active' : ''} onClick={() => { setTextbook(false); speech.stop(); }}>原创练习</button><button className={textbook ? 'active' : ''} onClick={() => { setTextbook(true); speech.stop(); }}>教材原声 MP3</button></div>}
    <section className="study-card" aria-label="当前练习">
      {stage === 'understand' && !vocabulary && <><div className="card-label"><BookOpen size={18}/>一个句型，两个小例子</div><h2>{grammar.title}</h2><p className="explain-short">{grammar.explanation}</p><div className="pattern" aria-label="句型结构">{grammar.pattern.map((part, i) => <span key={i} className={`pattern-part part-${i % 3}`}>{part}</span>)}</div><div className="example-list">{grammar.examples.map((example, i) => <Sentence key={i} example={example} speech={speech} furigana={settings.furigana}/>)}</div><div className="card-bottom"><span className="tiny-note">先看懂。到“自己说”时，再试着合上提示。</span><button className="text-button" disabled={reviewed.includes(grammar.id)} onClick={() => void addReview(grammar.title, grammar.examples[0], grammar.id, grammar.id)}><Plus size={17}/>{reviewed.includes(grammar.id) ? '已加入复习' : '这句想再练'}</button></div></>}
      {stage === 'understand' && vocabulary && <><div className="word-focus"><span className="tile-icon lavender"><BookOpen/></span><p lang="ja" className="word-reading">{word.reading}</p><h2 lang="ja">{word.word}</h2><p>{word.meaning}</p><Button secondary onClick={() => speech.say(word.word)}><Volume2 size={19}/>听读音</Button></div><Sentence example={word.example} speech={speech} furigana={settings.furigana}/><div className="card-bottom"><span className="tiny-note">试着用这个词说一句。</span><button className="text-button" disabled={reviewed.includes(`l${lesson.id}-word-${wordIndex}`)} onClick={() => void addReview(`用“${word.meaning}”说一句`, word.example, `l${lesson.id}-word-${wordIndex}`)}><Plus size={17}/>加入复习</button></div></>}
      {stage === 'listen' && textbook && <TextbookAudio lessonId={lesson.id} speech={speech}/>}
      {stage === 'listen' && !textbook && <><div className="card-label"><Headphones size={18}/>先听，再看</div><h2>{audio.title}</h2><div className="listen-visual"><span className="listen-orb"><Headphones size={48}/></span><div className="sound-bars" aria-hidden="true">{[18,32,47,28,58,36,49,22,36].map((height, i) => <i key={i} style={{ height }}/>)}</div><p>先找一个关键信息</p><div className="row-actions"><Button onClick={() => speech.say(audio.lines.map(line => line.jp))}><Volume2 size={19}/>听这段</Button><Button secondary onClick={() => speech.say(audio.lines.map(line => line.jp), 'ja-JP', .65)}>慢速听</Button></div></div><h3 className="question-title">{audio.question}</h3><div className="answer-choices">{audio.options.map((option, i) => <button key={i} className={picked === i ? picked === audio.answer ? 'correct' : 'try-again' : ''} onClick={async () => { setPicked(i); if (i !== audio.answer) setUsedHint(true); try { await post('/attempts', { lessonId: lesson.id, itemId: audio.id, result: i === audio.answer ? usedHint ? 'hint' : 'good' : 'again', answer: option, usedHint }); await save(stage, cursor, i === audio.answer ? usedHint ? 'assisted' : 'independent' : 'seen', audio.id); } catch (error) { notice((error as Error).message); } }}><span>{String.fromCharCode(65 + i)}</span>{option}{picked === i && i === audio.answer && <Check size={19}/>}</button>)}</div>{picked !== null && <div className={`answer-feedback ${picked === audio.answer ? 'success' : ''}`} role="status">{picked === audio.answer ? '听懂这个意思了。' : '再听一遍，或者看看原文。'} {audio.explanation}</div>}<button className="text-button transcript-toggle" aria-expanded={reveal} onClick={() => { setReveal(!reveal); setUsedHint(true); }}>{reveal ? '收起原文' : '需要帮助？看原文与中文'}</button>{reveal && <div className="listening-transcript">{audio.lines.map((line, i) => <div className="dialogue-line" key={i}><span>{i % 2 ? 'B' : 'A'}</span><Sentence example={line} speech={speech} furigana={settings.furigana}/></div>)}</div>}<div className="card-bottom"><span className="tiny-note">借助原文也可以完成，之后再减少提示。</span><button className="text-button" disabled={reviewed.includes(audio.id)} onClick={() => void addReview(audio.question, audio.lines[1], audio.id, audio.grammarIds[0])}><Plus size={17}/>加入复习</button></div></>}
      {stage === 'speak' && <><div className="card-label"><Mic size={18}/>把学过的提取出来</div><h2>{task.goal}</h2><p className="explain-short">先自己开口。说慢一点也没关系。</p><div className="support-levels" aria-label="提示程度">{['看范句', '看关键词', '自己回答'].map((level, i) => <button key={i} aria-pressed={speakingLevel === i} onClick={() => { setSpeakingLevel(i); setReveal(false); speech.stop(); if (i < 2) setUsedHint(true); }}><span>{i + 1}</span>{level}</button>)}</div><div className="speaking-space">{speakingLevel === 0 || reveal ? <Sentence example={task.answer} speech={speech} furigana={settings.furigana}/> : speakingLevel === 1 ? <div className="keyword-hint"><Lightbulb/><p>{task.hint}</p></div> : <div className="no-hint"><Mic size={40}/><p>现在，试着说一句。</p><button className="text-button" onClick={() => { setReveal(true); setUsedHint(true); }}>卡住了，给我提示</button></div>}</div><SpeakingPractice key={task.id} lessonId={lesson.id} task={task} speech={speech} notice={notice} busy={busy} usedHint={usedHint} furigana={settings.furigana} onHint={() => setUsedHint(true)} onRate={recordSpeaking}/><div className="card-bottom"><span className="tiny-note">自己确认完成情况；这里不做发音评分。</span><button className="text-button" disabled={reviewed.includes(task.id)} onClick={() => void addReview(task.goal, task.answer, task.id, task.grammarId)}><Plus size={17}/>加入复习</button></div></>}
      {stage === 'conversation' && <Conversation key={lesson.id} lesson={lesson} deployment={bootstrap.deployment} resume={bootstrap.activeSession} settings={settings} speech={speech} notice={notice} refresh={refresh} addCorrection={async (correction: Correction, sourceId) => { await post('/reviews', { lessonId: lesson.id, goal: correction.goal, answer: correction.corrected, grammarId: correction.grammarId, sourceId }); await refresh(); }}/>}
    </section>
    <RecordingHistory key={lesson.id} lessonId={lesson.id} speech={speech}/>
    {stage !== 'conversation' && !(stage === 'listen' && textbook) && <div className="study-navigation"><Button secondary disabled={busy || (vocabulary ? wordIndex === 0 : cursor === 0)} onClick={() => { if (vocabulary) { setWordIndex(Math.max(0, wordIndex - 1)); speech.stop(); } else void move(-1); }}><ArrowLeft size={18}/>上一张</Button><span className="tiny-note">{bootstrap.deployment === 'web' ? '进度保存在你的服务器' : '进度保存在本机'}</span><Button disabled={busy} onClick={() => { if (vocabulary) { if (wordIndex + 1 < lesson.vocabulary.length) { setWordIndex(wordIndex + 1); speech.stop(); } else setVocabulary(false); } else void move(1); }}>{vocabulary ? wordIndex + 1 < lesson.vocabulary.length ? '下一个词' : '回到语法' : cursor + 1 < items.length ? '下一张' : `去${stages[stages.findIndex(s => s.id === stage) + 1]?.label}`}<ArrowRight size={18}/></Button></div>}
  </>;
}
