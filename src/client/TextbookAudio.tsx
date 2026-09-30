import { useEffect, useId, useState } from 'react';
import { ExternalLink, Headphones, Play } from 'lucide-react';
import { getTextbookAudioLesson } from '../content/textbook-audio';
import type { Speech } from './speech';
import { Button } from './ui';
import { AudioControls } from './AudioControls';

export function TextbookAudio({ lessonId, speech }: { lessonId: number; speech: Speech }) {
  const selectId = useId();
  const lesson = getTextbookAudioLesson(lessonId);
  const [selection, setSelection] = useState<{ lessonId: number; trackId: string } | null>(null);
  useEffect(() => () => speech.stop(), [lessonId, speech.stop]);
  if (!lesson) return <p className="notice-inline" role="status">这课的教材音轨暂未提供。</p>;
  const track = (selection?.lessonId === lessonId ? lesson.tracks.find(item => item.id === selection.trackId) : undefined) ?? lesson.tracks[0];
  const label = `第 ${lessonId} 课 · 官方音轨 ${track.order}`;
  const sourceId = `textbook:${lessonId}:${track.id}`;

  return <section className="textbook-audio" aria-label={`第 ${lessonId} 课教材原声`}>
    <div className="card-label"><Headphones size={18}/>教材原声 · 第 {lessonId} 课</div>
    <h2>听课本里的日语</h2>
    <p className="tiny-note">第二版 · 会话与问题听力。按出版社顺序播放。</p>
    <div className="textbook-audio-picker">
      <label htmlFor={selectId}>选择音轨</label>
      <select id={selectId} value={track.id} onChange={event => {
        speech.stop();
        setSelection({ lessonId, trackId: event.target.value });
      }}>
        {lesson.tracks.map(item => <option key={item.id} value={item.id}>官方音轨 {item.order} / {lesson.tracks.length}</option>)}
      </select>
      <Button data-audio-source={sourceId} onClick={() => speech.playUrl(track.url, label, sourceId)}><Play size={19}/>播放音轨 {track.order}</Button>
      <AudioControls speech={speech} sourceId={sourceId}/>
    </div>
    <details className="source-details">
      <summary>音轨文件与来源</summary>
      <p className="tiny-note">{track.filename}</p>
      <p className="tiny-note">官方只标注文件名，未标注每条音轨的题型。</p>
    </details>
    <a className="text-button" href={lesson.sourcePage} target="_blank" rel="noreferrer"><ExternalLink size={16}/>打不开？查看出版社原声</a>
  </section>;
}
