import { getPreferences } from './preferences';
import { translate, localize } from './i18n';
import { useEffect, useState } from 'react';
import { Play, RotateCcw, Trash2 } from 'lucide-react';
import type { Recording } from '../shared/recordings';
import type { Speech } from './speech';
import { api } from './api';
import { Button } from './ui';
import { AudioControls } from './AudioControls';
import { PracticeScoreFeedback } from './AIPractice';

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
  return <details className="recording-history" onToggle={event => { setOpen(event.currentTarget.open); if (!event.currentTarget.open && speech.sourceId?.startsWith('recording-history:')) speech.stop(); }}><summary>{translate("我的录音 · 第")}{localize(lessonId)}{translate("课")}</summary>
    {open && <><p className="tiny-note">{translate("录音保留 90 天，之后保留文字与评分。登录同一网站即可在其他设备回听。")}</p><Button secondary disabled={loading} onClick={() => setRevision(value => value + 1)}><RotateCcw size={16}/>{translate("刷新录音")}</Button>
      {loading && <p role="status">{translate("正在读取录音……")}</p>}{error && <p role="alert">{localize(error)}</p>}{!loading && !rows.length && !error && <p>{translate("录下一句后，就会出现在这里。")}</p>}
      <div className="recording-history-list">{[...rows].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(row => <article key={row.id} className="recording-history-item"><p className="tiny-note">{new Date(row.createdAt).toLocaleString(getPreferences().locale)} · {localize(row.context === 'ai-speak' ? 'AI口语练习' : row.context === 'speak' ? '自己说' : 'AI 对话')} · {(row.durationMs / 1000).toFixed(1)}{translate("秒")}</p>
        {row.aiPractice && <p>{translate("表达目标：")}{localize(row.aiPractice.goalZh)}</p>}
        {row.aiPractice?.attempt?.kind === 'speaking' && <PracticeScoreFeedback attempt={row.aiPractice.attempt}/>}
        <p lang="ja">{row.assessment?.kind === 'audio' ? row.assessment.text : row.confirmedText || row.transcript || translate('这段录音还没有文字记录。')}</p>{row.assessment?.kind === 'expression' && <p>{translate("表达评分")} {localize(row.assessment.totalScore)}/100</p>}
        {row.assessment?.kind === 'audio' && <div className="audio-history-feedback"><p><strong>{translate("AI 听音反馈")}</strong> · {localize(row.assessment.summaryZh)}</p><p>{translate("语法与表达：")}{localize(row.assessment.grammarFeedbackZh)}</p><p>{translate("发音与节奏：")}{localize(row.assessment.pronunciation.feedbackZh)}</p>{row.assessment.pronunciation.issues.map((issue, i) => <p key={i}><span lang="ja">{issue.word}（{issue.expectedKana}）</span>：{localize(issue.issueZh)} {localize(issue.practiceTipZh)}</p>)}</div>}
        {row.audioAvailable ? <><div className="row-actions"><Button secondary data-audio-source={`recording-history:${row.id}`} onClick={() => speech.playUrl(`/api/recordings/${encodeURIComponent(row.id)}/audio`, '我的历史录音', `recording-history:${row.id}`)}><Play size={17}/>{translate("播放录音")}</Button><Button secondary disabled={pending} onClick={() => setDeleting(row.id)}><Trash2 size={16}/>{translate("删除录音")}</Button></div><AudioControls media speech={speech} sourceId={`recording-history:${row.id}`}/></> : <p className="tiny-note">{localize(row.audioStatus === 'expired' ? '录音已到期' : row.audioStatus === 'deleted' ? '录音已删除' : '没有音频文件，文字与评分仍可查看')}</p>}
        {deleting === row.id && <div className="notice-inline"><p>{translate("删除这段音频？文字与评分会保留。")}</p><div className="row-actions"><Button disabled={pending} onClick={() => void remove(row.id)}>{translate("确认删除")}</Button><Button secondary disabled={pending} onClick={() => setDeleting(null)}>{translate("保留")}</Button></div></div>}
      </article>)}</div></>}
  </details>;
}
