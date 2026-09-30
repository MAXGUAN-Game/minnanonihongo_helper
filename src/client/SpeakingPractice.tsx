import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Check, Volume2 } from 'lucide-react';
import type { Speaking } from '../shared/types';
import type { SpeakingAssessment } from '../shared/recordings';
import { api } from './api';
import { Button, Sentence } from './ui';
import { RecordingControls } from './RecordingControls';
import { AudioControls } from './AudioControls';
import { useRecorder, type Speech } from './speech';

export type SpeakingAnswer = { answer: string; recordingId?: string; assessmentId?: string };
export function SpeakingPractice({ lessonId, task, speech, notice, busy, usedHint, furigana, onHint, onRate, recordingHint }: {
  lessonId: number; task: Speaking; speech: Speech; notice: (message: string) => void; busy: boolean; usedHint: boolean; furigana: boolean;
  onHint: () => void; onRate: (result: 'again' | 'hint' | 'good', answer: SpeakingAnswer) => Promise<void>; recordingHint?: ReactNode;
}) {
  const [draft, setDraft] = useState('');
  const [assessment, setAssessment] = useState<SpeakingAssessment | null>(null);
  const [referenceOpen, setReferenceOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const request = useRef<AbortController | null>(null);
  const assessmentRequest = useRef<{ key: string; id: string } | null>(null);
  const alive = useRef(true);
  const draftRef = useRef(draft); draftRef.current = draft;
  const beforeRecording = useRef('');
  const recorder = useRecorder(text => {
    // Do not overwrite typing that occurred while transcription was running.
    if (draftRef.current === beforeRecording.current || !draftRef.current.trim()) changeDraft(text);
    else notice('识别已完成。你编辑的文字已保留；原始识别结果可在“我的录音”查看。');
  }, notice, { lessonId, itemId: task.id, context: 'speak' });
  useEffect(() => { alive.current = true; return () => { alive.current = false; request.current?.abort(); speech.stop(); }; }, []);
  function changeDraft(text: string) { setDraft(text); draftRef.current = text; setAssessment(null); setError(''); }
  async function assess() {
    if (pending || !draft.trim() || recorder.status !== 'idle') return;
    const text = draft.trim();
    const recordingId = recorder.clip?.recordingId;
    const key = JSON.stringify([text, recordingId]);
    if (assessmentRequest.current?.key !== key) assessmentRequest.current = { key, id: crypto.randomUUID() };
    const controller = new AbortController(); request.current = controller;
    speech.stop(); setReferenceOpen(false); setPending(true); setError('');
    try {
      const value = await api<SpeakingAssessment>('/speaking/assess', { method: 'POST', signal: controller.signal, body: JSON.stringify({ lessonId, itemId: task.id, text, recordingId, clientAssessmentId: assessmentRequest.current.id }) });
      if (alive.current) { setAssessment(value); window.dispatchEvent(new Event('nihongo-recordings-changed')); }
    } catch (failure) { if (alive.current && !controller.signal.aborted) setError((failure as Error).message); }
    finally { if (alive.current) setPending(false); }
  }
  const currentAssessment = assessment?.text === draft.trim() && assessment.recordingId === recorder.clip?.recordingId ? assessment : null;
  const blocked = busy || pending || recorder.status !== 'idle';
  const demoSourceId = `speaking-demo:${task.id}`;
  return <div className="speaking-practice">
    <RecordingControls recorder={recorder} speech={speech} centered hint={recordingHint} disabled={busy || pending} onStart={() => { beforeRecording.current = draftRef.current; setAssessment(null); setError(''); void recorder.start(); }}/>
    <label className="answer-label" htmlFor="speaking-answer">确认识别文字，也可以直接输入</label>
    <textarea id="speaking-answer" value={draft} onChange={event => changeDraft(event.target.value)} maxLength={2000} rows={2} disabled={pending || busy} placeholder="把你实际说的话留在这里……"/>
    <div className="row-actions"><Button disabled={blocked || !draft.trim() || recorder.saving} onClick={() => void assess()}>{pending ? '正在评估表达……' : '确认并评分'}</Button><div className="playback-source"><Button secondary data-audio-source={demoSourceId} onClick={() => { onHint(); speech.say(task.answer.jp, 'ja-JP', 1, demoSourceId); }}><Volume2 size={18}/>听示范</Button><AudioControls speech={speech} sourceId={demoSourceId}/></div></div>
    <p className="tiny-note">表达评分，不评发音。只根据你确认的文字判断；修改文字不会改变录音。</p>
    {error && <p className="notice-inline" role="alert">{error} 回答与录音仍保留，可以重试。</p>}
    {currentAssessment && <section className="expression-result" aria-label="表达评分"><div className="expression-score"><strong>{currentAssessment.totalScore}<small> / 100</small></strong><div><h3>表达评分</h3><p>{currentAssessment.summaryZh}</p></div></div>
      <div className="score-parts"><span>意思 {currentAssessment.taskScore}/50</span><span>语法 {currentAssessment.grammarScore}/30</span><span>用词 {currentAssessment.vocabularyScore}/20</span></div>
      {currentAssessment.corrections.map((correction, i) => <div key={i} className="expression-tip"><p>{correction.explanation}</p><Sentence example={correction.corrected} speech={speech} furigana={furigana}/></div>)}
      <details open={referenceOpen} onToggle={event => { setReferenceOpen(event.currentTarget.open); if (event.currentTarget.open) onHint(); }}><summary>看看可用表达</summary>{referenceOpen && <Sentence example={currentAssessment.reference} speech={speech} furigana={furigana}/>}</details>
      <Button secondary disabled={blocked} onClick={() => { beforeRecording.current = draftRef.current; setAssessment(null); void recorder.start(); }}>再说一次</Button>
    </section>}
    <div className="self-rating"><p>你实际完成得怎样？</p><div className="row-actions">
      {([{ result: 'again', text: '还要再练' }, { result: 'hint', text: '用提示完成' }, { result: 'good', text: '独立说出来了' }] as const).map(item => <Button key={item.result} secondary={item.result !== 'good'} disabled={blocked || !draft.trim() || recorder.saving} onClick={() => void onRate(item.result === 'good' && usedHint ? 'hint' : item.result, { answer: draft.trim(), recordingId: recorder.clip?.recordingId, assessmentId: currentAssessment?.id })}>{item.result === 'good' && <Check size={18}/>} {item.text}</Button>)}
    </div></div>
  </div>;
}
