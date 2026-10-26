import { Pause, Play, RotateCcw, RotateCw, Square, Minus, Plus, SkipBack } from 'lucide-react';
import { useEffect, useId } from 'react';
import type { Speech } from './speech';
import { useTranslation } from './preferences';
const time = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
export function AudioControls({ speech, sourceId, onPlay, disabled = false }: { speech: Speech; sourceId: string; onPlay?: () => void; disabled?: boolean }) {
  const t = useTranslation();
  const seekHelpId = useId();
  const active = speech.sourceId === sourceId;
  const playing = active && ['playing', 'loading', 'buffering'].includes(speech.status);
  const rate = speech.playbackRate ?? 1;
  useEffect(() => () => speech.stopSource?.(sourceId), [speech.stopSource, sourceId]);
  if (!onPlay && !active) return null;
  function toggle() {
    if (!active || speech.status === 'idle' || speech.status === 'error') { if (onPlay) onPlay(); else speech.replay(); }
    else if (playing) speech.pause(); else speech.resume();
  }
  const controls = [
    { label: playing ? t('暂停', '一時停止') : t('播放', '再生'), icon: playing ? Pause : Play, action: toggle, disabled },
    { label: t('后退2秒', '2秒戻る'), icon: RotateCcw, action: () => speech.seekBy?.(-2), disabled: disabled || !active || !speech.canSeek },
    { label: t('前进2秒', '2秒進む'), icon: RotateCw, action: () => speech.seekBy?.(2), disabled: disabled || !active || !speech.canSeek },
    { label: t('从头播放', '最初から再生'), icon: SkipBack, action: () => onPlay ? onPlay() : speech.replay(), disabled },
    { label: t('停止', '停止'), icon: Square, action: () => speech.stopSource(sourceId), disabled: !active },
    { label: t('慢放', '速度を下げる'), icon: Minus, action: () => speech.setPlaybackRate(rate === 1.25 ? 1 : .75), disabled: rate === .75 },
    { label: t('快放', '速度を上げる'), icon: Plus, action: () => speech.setPlaybackRate(rate === .75 ? 1 : 1.25), disabled: rate === 1.25 },
  ];
  return <section role="group" className="audio-controls" aria-label={t('音频控制', '音声コントロール')} data-audio-source={sourceId}>
    <span className="sr-only" role="status">{active ? speech.status === 'loading' ? t('正在准备', '準備中') : speech.status === 'buffering' ? t('正在缓冲', 'バッファリング中') : speech.status === 'paused' ? t('已暂停', '一時停止中') : speech.status === 'error' ? t('播放失败，请重试', '再生できません。再試行してください') : speech.status === 'playing' ? t('正在播放', '再生中') : t('播放结束', '再生終了') : t('等待播放', '再生待ち')}</span>
    <span id={seekHelpId} className="sr-only audio-seek-note">{t(speech.seekUnavailableReason || '当前音频暂不支持快退或快进。', '音声の準備ができると秒単位で移動できます。システム音声では利用できません。')}</span>
    <div className="button-row">{controls.map((control, index) => <button type="button" key={index} className={index === 0 ? "audio-toggle" : undefined} title={control.label} aria-label={control.label} aria-describedby={(index === 1 || index === 2) && (!active || !speech.canSeek) ? seekHelpId : undefined} onClick={control.action} disabled={control.disabled}><control.icon size={19}/>{index === 1 ? <span>−2s</span> : index === 2 ? <span>+2s</span> : index === 3 ? <span>{t('重放', '最初から')}</span> : null}</button>)}<span>{rate}×</span><span role="timer" aria-label={t('播放进度', '再生位置')}>{time(active ? speech.position || 0 : 0)}{active && speech.duration ? ` / ${time(speech.duration)}` : ''}</span></div>
  </section>;
}
