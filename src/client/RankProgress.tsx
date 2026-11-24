import { translate, localize } from './i18n';
import { useEffect, useState } from 'react';
import { Medal } from 'lucide-react';
import { practiceRank } from '../shared/practice-rank';
import { courseRank } from '../shared/course-progress';
import { api } from './api';
import { useTranslation } from './preferences';

export function RankProgress({ count, label }: { count: number; label?: string }) {
  const t = useTranslation(); const rank = practiceRank(count);
  const name = `${t(rank.zh, rank.ja)}${rank.division ?? ''}`;
  return <section className="mastery-panel rank-progress" data-tier={rank.id} aria-label={label ?? t('累计进度', '累計進捗')}>
    <div className="charge-caption"><span className="rank-medal" role="img" aria-label={name} title={name}><Medal aria-hidden="true" size={24}/>{rank.division !== null && <strong aria-hidden="true">{['','I','II','III','IV','V'][rank.division]}</strong>}</span><span className="rank-count"><span className="immersion-text">{localize(label ?? t('累计答对', '累計正解'))} </span>{localize(count)}<span className="immersion-text"> {t('题', '問')}</span></span></div>
    {rank.next !== null ? <><div role="progressbar" aria-label={t('小段位进度', 'ランク内進捗')} aria-valuemin={0} aria-valuemax={100} aria-valuenow={rank.progress} aria-valuetext={`${name} · ${count}`} className="charge-track"><span style={{ width: `${rank.progress}%` }}/></div><small>{t(`再答对 ${Math.ceil(rank.next - count)} 题晋升`, `あと${Math.ceil(rank.next - count)}問で昇格`)}</small></> : <small>{t('持续积累，题数无上限', '正解数は上限なく積み重ねられます')}</small>}
  </section>;
}
export function ModuleRankProgress({ score, count, total, stage, manual = false }: { score: number; count: number; total: number; stage: 'listen' | 'speak'; manual?: boolean }) {
  const t = useTranslation(); const rank = courseRank(score);
  const name = `${t(rank.zh, rank.ja)}${rank.division ?? ''}`;
  const label = stage === 'listen' ? t('听力进度', '聴解の進捗', 'Listening progress') : t('口语进度', '会話の進捗', 'Speaking progress');
  const explanation = (stage === 'listen'
    ? t('仅按本单元听力的完成百分比计算段位，100题为目标。', 'この課の聴解の進捗だけでランクを計算します。目標は100問です。', 'Rank uses only listening progress in this lesson, with a target of 100 questions.')
    : t('仅按本单元口语的完成百分比计算段位，100题为目标。', 'この課の会話の進捗だけでランクを計算します。目標は100問です。', 'Rank uses only speaking progress in this lesson, with a target of 100 questions.'))
    + (manual ? t('百分比包含手动调整。', '手動調整を含みます。', 'The percentage includes manual adjustments.') : '');
  return <section className="mastery-panel rank-progress" data-tier={rank.id} aria-label={label} title={explanation}>
    <div className="charge-caption"><span className="rank-medal" role="img" aria-label={name} title={name}><Medal aria-hidden="true" size={24}/>{rank.division !== null && <strong aria-hidden="true">{['','I','II','III','IV','V'][rank.division]}</strong>}</span><span className="rank-count"><span className="immersion-text">{label} </span>{count} / {total} · {score}%</span></div>
    <div role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={score} aria-valuetext={`${name} · ${count} / ${total} · ${score}%`} className="charge-track"><span style={{ width: `${score}%` }}/></div>
  </section>;
}
export function SpecialRank({ topic }: { topic: string }) {
  const t = useTranslation(); const [count, setCount] = useState<number | null>(null); const [failed, setFailed] = useState(false);
  useEffect(() => {
    let controller: AbortController | undefined;
    const refresh = () => { controller?.abort(); controller = new AbortController(); const signal = controller.signal;
      void api<{ count: number }>(`/special-practice/progress?topic=${topic}`, { signal }).then(value => { if (!signal.aborted) { setCount(value.count); setFailed(false); } }).catch(() => { if (!signal.aborted) setFailed(true); }); };
    setCount(null); refresh(); window.addEventListener('practice-assessed', refresh);
    return () => { controller?.abort(); window.removeEventListener('practice-assessed', refresh); };
  }, [topic]);
  return count === null ? <p role="status">{localize(failed ? t('进度暂时无法读取', '進捗を取得できません') : t('正在读取进度……', '進捗を読み込み中…'))}</p> : <RankProgress count={count}/>;
}
