import { useEffect, useState } from 'react';
import { Shuffle } from 'lucide-react';
import { AIPractice } from './AIPractice';
import { api } from './api';
import { Button, Empty, Heading } from './ui';
import { useTranslation } from './preferences';
import type { Speech } from './speech';
import { RankProgress } from './RankProgress';
import { useReviewCount } from './ReviewNav';

type ReviewStatus = { available: boolean; lessonIds: number[]; knowledgeCount: number };
export function ReviewPractice({ speech, notice, furigana }: { speech: Speech; notice: (text: string) => void; furigana: boolean }) {
  const t = useTranslation();
  const { count, failed } = useReviewCount();
  const [status, setStatus] = useState<ReviewStatus | null>(null);
  const [error, setError] = useState(false);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController(); setError(false);
    void api<ReviewStatus>('/review-practice/status', { signal: controller.signal }).then(value => {
      if (!controller.signal.aborted) setStatus(value);
    }).catch(() => { if (!controller.signal.aborted) setError(true); });
    return () => controller.abort();
  }, [revision]);
  return <>
    <Heading eyebrow={t('综合练习', '総合練習', 'Comprehensive practice')} title={t('大家的日本语', 'みんなの日本語', 'Minna no Nihongo')} description={t('把学过的知识用在日常生活中。', '学んだことを日常生活で使いましょう。', 'Use what you have learned in everyday life.')}/>
    {count !== null ? <RankProgress count={count}/> : <p role="status">{failed ? t('进度暂时无法读取', '進捗を取得できません', 'Progress is unavailable') : t('正在读取进度……', '進捗を読み込み中…', 'Loading progress…')}</p>}
    <div className="content-switch" aria-label={t('练习模式', '練習モード', 'Practice mode')}><span className="review-mode"><Shuffle size={18}/>{t('AI无限练习', 'AI無限練習', 'Unlimited AI practice')}</span></div>
    {error ? <div role="alert"><p>{t('暂时无法读取已学知识。', '学習済みの内容を取得できません。', 'Could not load your learned knowledge.')}</p><Button secondary onClick={() => setRevision(value => value + 1)}>{t('重试', '再試行', 'Retry')}</Button></div>
      : !status ? <p role="status">{t('正在读取已学知识…', '学習済みの内容を読み込み中…', 'Loading learned knowledge…')}</p>
      : status.available ? <AIPractice lessonId={0} review kind="dictation" speech={speech} notice={notice} furigana={furigana}/>
      : <Empty title={t('请先学习一些知识点', 'まず知識を学びましょう', 'Learn something first')} text={t('完成课程中的语法学习或练习后，即可在这里综合复习。', '課の文法学習や練習を終えると、ここで総合復習できます。', 'Study grammar or complete lesson exercises to unlock comprehensive practice.')}/>}
  </>;
}
