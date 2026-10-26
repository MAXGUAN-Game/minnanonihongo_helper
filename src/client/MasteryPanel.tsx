import { useEffect, useState } from 'react';
import type { moduleProgress } from '../server/module-progress';
import type { Stage } from '../shared/types';
import { api } from './api';
import { useTranslation } from './preferences';

export function MasteryPanel({ lessonId, stage, revision }: { lessonId: number; stage: Stage; revision?: string }) {
  const t = useTranslation();
  const [value, setValue] = useState<ReturnType<typeof moduleProgress> | null>(null);
  useEffect(() => {
    let request: AbortController | undefined;
    const refresh = () => {
      request?.abort(); request = new AbortController(); const signal = request.signal;
      void api<{ modules: ReturnType<typeof moduleProgress> }>(`/ai-practice/mastery?lessonId=${lessonId}`, { signal }).then(data => { if (!signal.aborted) setValue(data.modules); }).catch(() => {});
    };
    refresh(); window.addEventListener('practice-assessed', refresh);
    return () => { request?.abort(); window.removeEventListener('practice-assessed', refresh); };
  }, [lessonId, revision]);
  const part = value?.[stage === 'conversation' ? 'speak' : stage];
  const label = t('学习进度', '学習の進み具合');
  const detail = !part ? t('正在读取', '読み込み中') : `${part.manual ? t('实际完成 ', '実際の完了 ') : ''}${part.count} / ${part.total}`;
  const explanation = stage === 'vocabulary' ? t('已掌握单词 / 本单元单词总数：手动勾选或累计答对2道单词AI练习', '習得済み単語 / この課の全単語：チェックまたは単語AI練習で2問正解') : stage === 'understand' ? t('已标记学会的语法点', '学習済みにした文法の割合') : t('AI练习超过90分或完全正确的题数 / 100，同一道题只计一次；口语拼写按70分满分换算', 'AI練習で90点超または完全正解した問題数 / 100。同じ問題は1回のみ。口語の入力回答は70点満点から換算');
  return <section className="mastery-panel learning-charge" aria-label={label} title={explanation}>
    <div className="charge-caption"><span>{label}{part?.manual && t('（含手动设置）', '（手動設定を含む）')}</span><span>{detail} · {part?.score === null || !part ? '—' : `${part.score}%`}</span></div>
    <div role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={part?.score ?? 0} aria-valuetext={`${part?.score ?? 0}% · ${detail} · ${explanation}`} className="charge-track"><span style={{ width: `${part?.score ?? 0}%` }}/></div>
  </section>;
}
