import { useEffect, useRef, useState } from 'react';
import { useRecorder, type Speech } from './speech';
import { RecordingControls } from './RecordingControls';
import { Button } from './ui';
import { api } from './api';
import { useTranslation } from './preferences';
import type { PracticeAttempt } from '../shared/ai-practice';
export function AudioAnswer({ questionId, speech, notice, onResult, onBusy, suspended = false }: { questionId: string; speech: Speech; notice: (message: string) => void; onResult: (attempt: PracticeAttempt) => void; suspended?: boolean; onBusy?: (busy: boolean) => void }) {
  const t = useTranslation();
  const recorder = useRecorder(() => {}, notice, undefined, { transcribe: false, persist: false });
  const request = useRef<AbortController | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { onBusy?.(pending || recorder.status !== 'idle'); return () => onBusy?.(false); }, [pending, recorder.status, onBusy]);
  const lastClip = useRef<string | undefined>(undefined);
  const attemptId = useRef(crypto.randomUUID());
  useEffect(() => () => { request.current?.abort(); recorder.cancel(); }, [questionId]);
  useEffect(() => { if (suspended) { request.current?.abort(); request.current = null; recorder.stop(); setPending(false); } }, [suspended]);
  async function submit() {
    if (request.current || !recorder.clip || suspended) return;
    const controller = new AbortController(); request.current = controller;
    setPending(true); setError('');
    const timer = setTimeout(() => { controller.abort(); setError(t('识别等待超时，请重试。', 'タイムアウトしました。再試行してください。')); setPending(false); }, 135000);
    try {
      const body = await recorder.getWav();
      if (controller.signal.aborted) return;
      const result = await api<PracticeAttempt>(`/ai-practice/questions/${questionId}/assess-audio?clientAssessmentId=${attemptId.current}`, { method: 'POST', headers: { 'Content-Type': 'audio/wav' }, body, signal: controller.signal });
      if (!controller.signal.aborted) { onResult(result); window.dispatchEvent(new Event('practice-assessed')); }
    } catch (failure) { if (!controller.signal.aborted) setError((failure as Error).message); }
    finally { clearTimeout(timer); if (request.current === controller) { request.current = null; if (!controller.signal.aborted) setPending(false); } }
  }
  useEffect(() => {
    if (!recorder.clip || recorder.clip.url === lastClip.current || suspended) return;
    lastClip.current = recorder.clip.url; attemptId.current = crypto.randomUUID(); void submit();
  }, [recorder.clip?.url, suspended]);
  return <><RecordingControls recorder={recorder} speech={speech} disabled={pending || suspended}/>
    {pending && <p role="status">{t('正在识别并检查答案……', '音声を認識して回答を確認しています…')}</p>}
    {error && <div role="alert"><p>{error}</p><Button disabled={pending || suspended} onClick={() => void submit()}>{t('重试', '再試行')}</Button></div>}
  </>;
}
