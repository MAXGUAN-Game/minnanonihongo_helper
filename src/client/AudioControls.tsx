import { Pause, Play, RotateCcw, RotateCw, Square } from 'lucide-react';
import { useEffect, useId } from 'react';
import type { Speech } from './speech';

const audioTime = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;

export function AudioControls({ speech, sourceId }: { speech: Speech; sourceId: string }) {
  const seekReasonId = useId();
  const stopSource = speech.stopSource;
  useEffect(() => () => { stopSource?.(sourceId); }, [stopSource, sourceId]);
  if (!speech.label || speech.sourceId !== sourceId) return null;
  const resume = speech.status === 'paused' || speech.status === 'blocked';
  const restart = speech.status === 'idle' || speech.status === 'error';
  const canSeek = speech.canSeek === true && typeof speech.seekBy === 'function';
  const seekReason = canSeek ? undefined : speech.seekUnavailableReason || '当前音频暂不支持快退或快进。';
  const statusText = speech.status === 'loading' ? '正在准备' : speech.status === 'buffering' ? '正在缓冲' : speech.status === 'paused' ? '已暂停' : speech.status === 'blocked' ? '点一下播放' : speech.status === 'playing' ? '正在播放' : speech.status === 'error' ? '播放失败，请重试' : '播放结束';
  return <section className="audio-controls" aria-label="音频控制">
    <div className="audio-playback-status"><p role="status">{speech.label} · {statusText}</p>{typeof speech.duration === 'number' && Number.isFinite(speech.duration) && speech.duration > 0 && <span className="audio-time" role="timer" aria-label="播放进度">{audioTime(speech.position || 0)} / {audioTime(speech.duration)}</span>}</div>
    <div className="button-row">
      <button className="audio-toggle" type="button" onClick={resume ? speech.resume : restart ? speech.replay : speech.pause}>{resume || restart ? <Play aria-hidden="true"/> : <Pause aria-hidden="true"/>}{speech.status === 'error' ? '重试播放' : restart ? '播放' : speech.status === 'blocked' ? '点一下播放' : resume ? '继续播放' : '暂停'}</button>
      <button type="button" disabled={!canSeek} aria-describedby={seekReason ? seekReasonId : undefined} onClick={() => speech.seekBy?.(-2)}><RotateCcw aria-hidden="true"/>快退 2 秒</button>
      <button type="button" disabled={!canSeek} aria-describedby={seekReason ? seekReasonId : undefined} onClick={() => speech.seekBy?.(2)}><RotateCw aria-hidden="true"/>快进 2 秒</button>
      {speech.status !== 'error' && <button type="button" onClick={speech.replay}><RotateCcw aria-hidden="true"/>从头播放</button>}
      <button type="button" onClick={speech.stop}><Square aria-hidden="true"/>停止</button>
    </div>
    {seekReason && <p className="audio-seek-note" id={seekReasonId}>{seekReason}</p>}
    <p className="audio-shortcut-hint">空格键暂停或播放；输入文字时不触发。</p>
  </section>;
}
