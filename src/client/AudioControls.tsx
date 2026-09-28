import { Pause, Play, RotateCcw, Square } from 'lucide-react';
import type { Speech } from './speech';

export function AudioControls({ speech }: { speech: Speech }) {
  if (!speech.label) return null;
  const resume = speech.status === 'paused' || speech.status === 'blocked';
  return <section className="audio-controls" aria-label="音频控制">
    <p role="status">{speech.label} · {speech.status === 'loading' ? '正在准备' : speech.status === 'paused' ? '已暂停' : speech.status === 'blocked' ? '点一下播放' : speech.status === 'playing' ? '正在播放' : '播放结束'}</p>
    <div className="button-row">
      {resume ? <button type="button" onClick={speech.resume}><Play aria-hidden="true"/>{speech.status === 'blocked' ? '点一下播放' : '继续播放'}</button>
        : speech.status !== 'idle' ? <button type="button" onClick={speech.pause}><Pause aria-hidden="true"/>暂停</button> : null}
      <button type="button" onClick={speech.replay}><RotateCcw aria-hidden="true"/>从头播放</button>
      <button type="button" onClick={speech.stop}><Square aria-hidden="true"/>停止</button>
    </div>
  </section>;
}
