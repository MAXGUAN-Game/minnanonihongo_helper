import { Mic, Play, RotateCcw } from 'lucide-react';
import { Button } from './ui';
import type { Speech, useRecorder } from './speech';

export type Recorder = ReturnType<typeof useRecorder>;
export function RecordingControls({ recorder, speech, disabled = false, onStart }: { recorder: Recorder; speech: Speech; disabled?: boolean; onStart?: () => void }) {
  const processing = recorder.status === 'transcribing';
  const recording = recorder.status === 'recording' || recorder.status === 'asking';
  function start() { if (disabled || recorder.status !== 'idle') return; if (onStart) onStart(); else void recorder.start(); }
  return <div className="recording-controls">
    <div className="record-actions"><button className={`mic-button ${recording ? 'recording' : ''}`} disabled={disabled || processing}
      onPointerDown={event => { if (event.button !== 0) return; event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId); start(); }}
      onPointerUp={recorder.stop} onPointerCancel={recorder.stop} onLostPointerCapture={recorder.stop}
      onKeyDown={event => { if (event.code === 'Space' && !event.repeat) { event.preventDefault(); start(); } }}
      onKeyUp={event => { if (event.code === 'Space') { event.preventDefault(); recorder.stop(); } }} onBlur={recorder.stop}
      aria-label="按住说话，也可按住空格键"><Mic size={27}/></button>
      <div><strong>{recorder.status === 'recording' ? '正在听，松开结束' : processing ? '正在识别日语……' : recorder.status === 'asking' ? '请允许麦克风' : '按住说话'}</strong>
        <p>日语录音 · 最长 30 秒</p><button className="text-button" disabled={disabled || processing} onClick={() => recording ? recorder.stop() : start()}>{recording ? '点击结束录音' : '或点击开始录音'}</button></div>
    </div>
    {recorder.clip && <div className="recording-preview"><div className="row-actions"><Button secondary onClick={() => speech.playUrl(recorder.clip!.url, '我的录音')}><Play size={18}/>听我的录音</Button><span className="tiny-note">{(recorder.clip.durationMs / 1000).toFixed(1)} 秒 · {recorder.saving ? '正在保存' : recorder.clip.saved ? '已保存 · 保留 90 天' : '暂存在本页'}</span></div>
      {recorder.saveError && <div role="alert"><p>{recorder.saveError}</p><Button secondary disabled={recorder.saving} onClick={() => void recorder.retrySave()}><RotateCcw size={16}/>重试保存录音</Button></div>}
      {recorder.transcribeError && <div role="alert"><p>{recorder.transcribeError}</p><Button secondary disabled={processing} onClick={() => void recorder.retryTranscribe()}><RotateCcw size={16}/>重新识别</Button></div>}
    </div>}
  </div>;
}
