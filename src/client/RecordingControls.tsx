import { translate } from './i18n';
import { useId, useRef, type ReactNode } from 'react';
import { Mic, Play, RotateCcw } from 'lucide-react';
import { Button } from './ui';
import { AudioControls } from './AudioControls';
import type { Speech, useRecorder } from './speech';

export type Recorder = ReturnType<typeof useRecorder>;
export function RecordingControls({ recorder, speech, disabled = false, onStart, centered = false, hint }: { recorder: Recorder; speech: Speech; disabled?: boolean; onStart?: () => void; centered?: boolean; hint?: ReactNode }) {
  const instructionId = useId();
  const press = useRef<{ input: number | string; startedAt: number; started: boolean } | null>(null);
  const processing = recorder.status === 'transcribing';
  const recording = recorder.status === 'recording' || recorder.status === 'asking';
  const previewSourceId = `recording-preview:${recorder.clip?.url}`;
  function start() { if (disabled || recorder.status !== 'idle') return; if (onStart) onStart(); else void recorder.start(); }
  function beginPress(input: number | string) {
    if (disabled || processing || press.current) return;
    press.current = { input, startedAt: Date.now(), started: !recording };
    if (!recording) start();
  }
  function endPress(input: number | string) {
    const gesture = press.current;
    if (!gesture || gesture.input !== input) return;
    press.current = null;
    // A quick tap keeps capture running; a hold ends on release. Starting
    // immediately also preserves the first syllable while permission resolves.
    if (!gesture.started || Date.now() - gesture.startedAt >= 300) recorder.stop();
  }
  function cancelPress(input?: number) {
    if (!press.current || (input !== undefined && press.current.input !== input)) return;
    press.current = null; recorder.stop();
  }
  return <div className={`recording-controls${centered ? ' centered' : ''}`}>
    <div className="record-actions"><button type="button" className={`mic-button ${recording ? 'recording' : ''}`} disabled={disabled || processing}
      onPointerDown={event => { if (event.button !== 0 || press.current) return; event.preventDefault(); event.currentTarget.focus({ preventScroll: true }); event.currentTarget.setPointerCapture(event.pointerId); beginPress(event.pointerId); }}
      onPointerUp={event => endPress(event.pointerId)} onPointerCancel={event => cancelPress(event.pointerId)} onLostPointerCapture={event => cancelPress(event.pointerId)}
      onKeyDown={event => { if (event.code === 'Space' || event.code === 'Enter') { event.preventDefault(); if (!event.repeat) beginPress(event.code); } }}
      onKeyUp={event => { if (event.code === 'Space' || event.code === 'Enter') { event.preventDefault(); endPress(event.code); } }} onBlur={() => cancelPress()}
      onClick={event => { if (event.detail === 0 && !press.current) { if (recording) recorder.stop(); else start(); } }}
      aria-pressed={recording} aria-describedby={instructionId} aria-label={recording ? translate('结束录音') : translate('开始录音：点击或按住说话')}><Mic size={centered ? 36 : 27}/></button>
      <div><strong role="status">{recorder.status === 'recording' ? translate('正在录音……') : processing ? translate('正在识别日语……') : recorder.status === 'asking' ? translate('请允许麦克风') : centered ? translate('现在，试着说一句。') : translate('点击或按住说话')}</strong>
        <p id={instructionId}>{translate("点击录音，再点结束 · 也可按住说话")}<br/>{translate("空格或回车键 · 最长 30 秒")}</p></div>
    </div>
    {hint && <div className="recording-hint">{hint}</div>}
    {recorder.clip && <div className="recording-preview"><AudioControls speech={speech} sourceId={previewSourceId} onPlay={() => speech.playUrl(recorder.clip!.url, translate('我的录音'), previewSourceId)}/>
      {recorder.saveError && <div role="alert"><p>{recorder.saveError}</p><Button secondary disabled={recorder.saving} onClick={() => void recorder.retrySave()}><RotateCcw size={16}/>{translate("重试保存录音")}</Button></div>}
      {recorder.transcribeError && <div role="alert"><p>{recorder.transcribeError}</p><Button secondary disabled={processing} onClick={() => void recorder.retryTranscribe()}><RotateCcw size={16}/>{translate("重新识别")}</Button></div>}
    </div>}
  </div>;
}
