import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Check, Volume2 } from 'lucide-react';
import type { Speaking } from '../shared/types';
import type { ExpressionAssessment } from '../shared/recordings';
import { api } from './api';
import { Button, Sentence } from './ui';
import { AudioSpeakingPractice } from './AudioSpeakingPractice';
import { AudioControls } from './AudioControls';
import type { Speech } from './speech';

export type SpeakingAnswer = { answer: string; recordingId?: string; assessmentId?: string };
export type SpeakingPracticeProps = {
  lessonId: number; task: Speaking; speech: Speech; notice: (message: string) => void; busy: boolean; usedHint: boolean; furigana: boolean;
  onHint: () => void; onRate: (result: 'again' | 'hint' | 'good', answer: SpeakingAnswer) => Promise<void>; recordingHint?: ReactNode;
};
export function SpeakingPractice(props: SpeakingPracticeProps) {
  const [mode, setMode] = useState<'audio' | 'text'>('audio');
  return <><div className="content-switch" aria-label="回答方式">
    <button aria-pressed={mode === 'audio'} className={mode === 'audio' ? 'active' : ''} onClick={() => { props.speech.stop(); setMode('audio'); }}>录音练习</button>
    <button aria-pressed={mode === 'text'} className={mode === 'text' ? 'active' : ''} onClick={() => { props.speech.stop(); setMode('text'); }}>打字练习</button>
  </div>{mode === 'audio' ? <AudioSpeakingPractice key={props.task.id} {...props}/> : <TextSpeakingPractice key={props.task.id} {...props}/>}</>;
}
function TextSpeakingPractice({ lessonId, task, speech, busy, usedHint, furigana, onHint, onRate }: SpeakingPracticeProps) {
  const [draft, setDraft] = useState('');
  const [assessment, setAssessment] = useState<ExpressionAssessment | null>(null);
  const [referenceOpen, setReferenceOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const request = useRef<AbortController | null>(null);
  const assessmentRequest = useRef<{ key: string; id: string } | null>(null);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; request.current?.abort(); speech.stop(); }; }, []);
  function changeDraft(text: string) { setDraft(text); setAssessment(null); setError(''); }
  async function assess() {
    if (pending || !draft.trim()) return;
    const text = draft.trim();
    const key = text;
    if (assessmentRequest.current?.key !== key) assessmentRequest.current = { key, id: crypto.randomUUID() };
    const controller = new AbortController(); request.current = controller;
    speech.stop(); setReferenceOpen(false); setPending(true); setError('');
    try {
      const value = await api<ExpressionAssessment>('/speaking/assess', { method: 'POST', signal: controller.signal, body: JSON.stringify({ lessonId, itemId: task.id, text, clientAssessmentId: assessmentRequest.current.id }) });
      if (alive.current) { setAssessment(value); window.dispatchEvent(new Event('nihongo-recordings-changed')); }
    } catch (failure) { if (alive.current && !controller.signal.aborted) setError((failure as Error).message); }
    finally { if (alive.current) setPending(false); }
  }
  const currentAssessment = assessment?.text === draft.trim() ? assessment : null;
  const blocked = busy || pending;
  const demoSourceId = `speaking-demo:${task.id}`;
  return <div className="speaking-practice">
    <label className="answer-label" htmlFor="speaking-answer">输入你的日语回答</label>
    <textarea id="speaking-answer" value={draft} onChange={event => changeDraft(event.target.value)} maxLength={2000} rows={2} disabled={pending || busy} placeholder="把你实际说的话留在这里……"/>
    <div className="row-actions"><Button disabled={blocked || !draft.trim()} onClick={() => void assess()}>{pending ? '正在评估表达……' : '确认并评分'}</Button><div className="playback-source"><Button secondary data-audio-source={demoSourceId} onClick={() => { onHint(); speech.say(task.answer.jp, 'ja-JP', 1, demoSourceId); }}><Volume2 size={18}/>听示范</Button><AudioControls speech={speech} sourceId={demoSourceId}/></div></div>
    <p className="tiny-note">打字练习只评价文字；想检查发音，请切换到录音练习。</p>
    {error && <p className="notice-inline" role="alert">{error} 回答与录音仍保留，可以重试。</p>}
    {currentAssessment && <section className="expression-result" aria-label="表达评分"><div className="expression-score"><strong>{currentAssessment.totalScore}<small> / 100</small></strong><div><h3>表达评分</h3><p>{currentAssessment.summaryZh}</p></div></div>
      <div className="score-parts"><span>意思 {currentAssessment.taskScore}/50</span><span>语法 {currentAssessment.grammarScore}/30</span><span>用词 {currentAssessment.vocabularyScore}/20</span></div>
      {currentAssessment.corrections.map((correction, i) => <div key={i} className="expression-tip"><p>{correction.explanation}</p><Sentence example={correction.corrected} speech={speech} furigana={furigana}/></div>)}
      <details open={referenceOpen} onToggle={event => { setReferenceOpen(event.currentTarget.open); if (event.currentTarget.open) onHint(); }}><summary>看看可用表达</summary>{referenceOpen && <Sentence example={currentAssessment.reference} speech={speech} furigana={furigana}/>}</details>
    </section>}
    <div className="self-rating"><p>你实际完成得怎样？</p><div className="row-actions">
      {([{ result: 'again', text: '还要再练' }, { result: 'hint', text: '用提示完成' }, { result: 'good', text: '独立说出来了' }] as const).map(item => <Button key={item.result} secondary={item.result !== 'good'} disabled={blocked || !draft.trim()} onClick={() => void onRate(item.result === 'good' && usedHint ? 'hint' : item.result, { answer: draft.trim(), assessmentId: currentAssessment?.id })}>{item.result === 'good' && <Check size={18}/>} {item.text}</Button>)}
    </div></div>
  </div>;
}
