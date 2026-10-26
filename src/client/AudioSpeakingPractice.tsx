import { useEffect, useRef, useState } from 'react';
import { Check, RotateCcw, Volume2 } from 'lucide-react';
import type { AudioAssessment, AudioAssessmentSettings } from '../shared/audio-assessment';
import type { SpeakingPracticeProps } from './SpeakingPractice';
import { api } from './api';
import { useRecorder } from './speech';
import { RecordingControls } from './RecordingControls';
import { AudioControls } from './AudioControls';
import { Button, Sentence } from './ui';

export function AudioSpeakingPractice({ lessonId, task, speech, notice, busy, usedHint, furigana, onHint, onRate, recordingHint }: SpeakingPracticeProps) {
  const [settings, setSettings] = useState<AudioAssessmentSettings | null>(null);
  const [settingsError, setSettingsError] = useState('');
  const [settingsRevision, setSettingsRevision] = useState(0);
  const [assessment, setAssessment] = useState<AudioAssessment | null>(null);
  const [pending, setPending] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState('');
  const [referenceOpen, setReferenceOpen] = useState(false);
  const alive = useRef(true);
  const revision = useRef(0);
  const request = useRef<AbortController | null>(null);
  const attempted = useRef(new Set<string>());
  const requestIds = useRef(new Map<string, string>());
  const recorder = useRecorder(() => {}, notice, { lessonId, itemId: task.id, context: 'speak' }, { transcribe: false });

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; revision.current++; request.current?.abort(); speech.stop(); };
  }, []);
  useEffect(() => {
    const controller = new AbortController(); setSettingsError('');
    const timer = setTimeout(() => { setSettingsError('读取听音设置超时，请检查网络后重试。'); controller.abort(); }, 10000);
    void api<AudioAssessmentSettings>('/speaking/audio-settings', { signal: controller.signal })
      .then(value => { if (!controller.signal.aborted) setSettings(value); })
      .catch(failure => { if (!controller.signal.aborted) setSettingsError((failure as Error).message); })
      .finally(() => clearTimeout(timer));
    return () => { clearTimeout(timer); controller.abort(); };
  }, [settingsRevision]);
  useEffect(() => {
    if (!pending) return;
    const started = Date.now(); setElapsed(0);
    const timer = setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(timer);
  }, [pending]);

  async function assess(recordingId: string) {
    if (request.current || !settings?.hasApiKey) return;
    const thisRevision = ++revision.current;
    const controller = new AbortController(); request.current = controller;
    let clientAssessmentId = requestIds.current.get(recordingId);
    if (!clientAssessmentId) { clientAssessmentId = crypto.randomUUID(); requestIds.current.set(recordingId, clientAssessmentId); }
    attempted.current.add(recordingId);
    speech.stop(); setPending(true); setError(''); setAssessment(null); setReferenceOpen(false);
    const isCurrent = () => alive.current && !controller.signal.aborted && revision.current === thisRevision;
    const timer = setTimeout(() => {
      if (!isCurrent()) return;
      controller.abort(); request.current = null; setPending(false);
      setError('等待反馈超过 30 秒。请检查网络后重试，录音仍保留。');
    }, 135000);
    try {
      const value = await api<AudioAssessment>('/speaking/assess-audio', {
        method: 'POST', signal: controller.signal,
        body: JSON.stringify({ lessonId, itemId: task.id, recordingId, clientAssessmentId }),
      });
      if (isCurrent()) { setAssessment(value); window.dispatchEvent(new Event('nihongo-recordings-changed')); }
    } catch (failure) { if (isCurrent()) setError((failure as Error).message); }
    finally { clearTimeout(timer); if (request.current === controller) request.current = null; if (isCurrent()) setPending(false); }
  }
  const recordingId = recorder.clip?.recordingId;
  useEffect(() => {
    if (recordingId && settings?.hasApiKey && !attempted.current.has(recordingId)) void assess(recordingId);
  }, [recordingId, settings?.hasApiKey]);

  function cancelAssessment() {
    revision.current++; request.current?.abort(); request.current = null; setPending(false);
  }
  function startRecording() {
    cancelAssessment(); setAssessment(null); setError(''); setReferenceOpen(false); speech.stop(); void recorder.start();
  }
  const current = assessment?.recordingId === recordingId ? assessment : null;
  const blocked = busy || pending || recorder.saving || recorder.status !== 'idle';
  const demoSourceId = `speaking-demo:${task.id}`;
  return <div className="speaking-practice">
    {!settings && !settingsError && <p role="status" className="tiny-note">正在检查音频服务……</p>}
    {settingsError && <div role="alert" className="notice-inline"><p>{settingsError}</p><Button secondary onClick={() => setSettingsRevision(value => value + 1)}>重新检查音频服务</Button></div>}
    {settings && !settings.hasApiKey && <p className="notice-inline">先到<a href="#settings">学习设置</a>配置“AI 听录音”的百炼密钥，再开始录音。也可以先打字练习。</p>}
    {settings?.hasApiKey && <p className="tiny-note">录完自动反馈语法和发音。音频将发送到阿里云百炼。</p>}
    <RecordingControls recorder={recorder} speech={speech} centered hint={recordingHint} disabled={busy || recorder.saving || !settings?.hasApiKey} onStart={startRecording}/>
    {recorder.saving && <p role="status">正在上传录音……</p>}
    {pending && <div className="audio-assessment-progress"><p role="status">AI 正在听录音…… {elapsed} 秒</p><Button secondary onClick={() => { cancelAssessment(); setError('已停止等待，录音仍保留。可以重试分析，或重新录音。'); }}>停止等待</Button></div>}
    {error && <div className="notice-inline" role="alert"><p>{error}</p><p className="tiny-note">录音仍保留，可以回听或重试。</p>{recordingId && <Button secondary disabled={blocked} onClick={() => void assess(recordingId)}><RotateCcw size={16}/>重新分析录音</Button>}</div>}
    {current && <section className="audio-assessment-result" aria-label="录音反馈">
      <div className="section-header"><h3>这次开口的反馈</h3><span className="tiny-note">分析用时 {(current.latencyMs / 1000).toFixed(1)} 秒</span></div>
      <p>{current.summaryZh}</p>
      <div className="audio-feedback-part"><h3>语法与表达</h3><p>{current.grammarFeedbackZh}</p>
        {current.corrections.map((correction, i) => <div className="expression-tip" key={i}><p>{correction.explanation}</p><Sentence example={correction.corrected} speech={speech} furigana={furigana}/></div>)}
      </div>
      <div className="audio-feedback-part"><h3>发音与节奏</h3><p>{current.pronunciation.feedbackZh}</p>
        {current.pronunciation.status === 'uncertain' && <p className="tiny-note">这段录音的读音判断不确定，可以靠近麦克风再说一次。</p>}
        {current.pronunciation.issues.map((issue, i) => <div className="expression-tip" key={i}><p lang="ja"><strong>{issue.word}</strong> · {issue.expectedKana}</p><p>{issue.issueZh}</p><p>{issue.practiceTipZh}</p></div>)}
      </div>
      <p className="tiny-note">AI 听音建议，可能有误。优先练习明确指出的读音片段。</p>
      <details><summary>AI 听到的内容</summary><p lang="ja">{current.text}</p></details>
      <details open={referenceOpen} onToggle={event => { setReferenceOpen(event.currentTarget.open); if (event.currentTarget.open) onHint(); }}><summary>看看可用表达</summary>{referenceOpen && <Sentence example={current.reference} speech={speech} furigana={furigana}/>}</details>
      <Button secondary disabled={busy || recorder.saving || recorder.status !== 'idle'} onClick={startRecording}>再说一次</Button>
    </section>}
    <div className="playback-source"><Button secondary data-audio-source={demoSourceId} onClick={() => { onHint(); speech.say(task.answer.jp, 'ja-JP', 1, demoSourceId); }}><Volume2 size={18}/>听示范</Button><AudioControls speech={speech} sourceId={demoSourceId}/></div>
    {current && <div className="self-rating"><p>你实际完成得怎样？</p><div className="row-actions">
      {([{ result: 'again', text: '还要再练' }, { result: 'hint', text: '用提示完成' }, { result: 'good', text: '独立说出来了' }] as const).map(item => <Button key={item.result} secondary={item.result !== 'good'} disabled={blocked} onClick={() => void onRate(item.result === 'good' && usedHint ? 'hint' : item.result, { answer: current.text, recordingId: current.recordingId, assessmentId: current.id })}>{item.result === 'good' && <Check size={18}/>} {item.text}</Button>)}
    </div></div>}
  </div>;
}
