import { useEffect, useState } from 'react';
import { Play, RotateCcw, Trash2 } from 'lucide-react';
import type { Recording } from '../shared/recordings';
import type { Speech } from './speech';
import { api } from './api';
import { Button } from './ui';

export function RecordingHistory({ lessonId, speech }: { lessonId: number; speech: Speech }) {
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<Recording[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [revision, setRevision] = useState(0);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  useEffect(() => { const changed = () => setRevision(value => value + 1); window.addEventListener('nihongo-recordings-changed', changed); return () => window.removeEventListener('nihongo-recordings-changed', changed); }, []);
  useEffect(() => {
    if (!open) return;
    const request = new AbortController(); setLoading(true); setError('');
    void api<Recording[]>(`/recordings?lessonId=${lessonId}`, { signal: request.signal }).then(value => { if (!request.signal.aborted) setRows(value); }).catch(failure => { if (!request.signal.aborted) setError(failure.message); }).finally(() => { if (!request.signal.aborted) setLoading(false); });
    return () => request.abort();
  }, [open, lessonId, revision]);
  async function remove(id: string) {
    setPending(true); speech.stop(); setError('');
    try { await api(`/recordings/${id}`, { method: 'DELETE' }); setDeleting(null); setRevision(value => value + 1); }
    catch (failure) { setError((failure as Error).message); }
    finally { setPending(false); }
  }
  return <details className="recording-history" onToggle={event => setOpen(event.currentTarget.open)}><summary>我的录音 · 第 {lessonId} 课</summary>
    {open && <><p className="tiny-note">录音保留 90 天，之后保留文字与评分。登录同一网站即可在其他设备回听。</p><Button secondary disabled={loading} onClick={() => setRevision(value => value + 1)}><RotateCcw size={16}/>刷新录音</Button>
      {loading && <p role="status">正在读取录音……</p>}{error && <p role="alert">{error}</p>}{!loading && !rows.length && !error && <p>录下一句后，就会出现在这里。</p>}
      <div className="recording-history-list">{[...rows].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(row => <article key={row.id} className="recording-history-item"><p className="tiny-note">{new Date(row.createdAt).toLocaleString('zh-CN')} · {row.context === 'speak' ? '自己说' : 'AI 对话'} · {(row.durationMs / 1000).toFixed(1)} 秒</p>
        <p lang="ja">{row.confirmedText || row.transcript || '这段录音还没有确认文字。'}</p>{row.assessment && <p>表达评分 {row.assessment.totalScore}/100</p>}
        {row.audioAvailable ? <div className="row-actions"><Button secondary onClick={() => speech.playUrl(`/api/recordings/${encodeURIComponent(row.id)}/audio`, '我的历史录音')}><Play size={17}/>播放录音</Button><Button secondary disabled={pending} onClick={() => setDeleting(row.id)}><Trash2 size={16}/>删除录音</Button></div> : <p className="tiny-note">{row.audioStatus === 'expired' ? '录音已到期' : row.audioStatus === 'deleted' ? '录音已删除' : '没有音频文件，文字与评分仍可查看'}</p>}
        {deleting === row.id && <div className="notice-inline"><p>删除这段音频？文字与评分会保留。</p><div className="row-actions"><Button disabled={pending} onClick={() => void remove(row.id)}>确认删除</Button><Button secondary disabled={pending} onClick={() => setDeleting(null)}>保留</Button></div></div>}
      </article>)}</div></>}
  </details>;
}
