import { useEffect, useState } from 'react';
import { Gem, Medal } from 'lucide-react';
import { api } from './api';
import { practiceRank } from '../shared/practice-rank';
import { useTranslation } from './preferences';

export function useReviewCount() {
  const [count, setCount] = useState<number | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let controller: AbortController | undefined;
    const refresh = () => {
      controller?.abort(); controller = new AbortController(); const signal = controller.signal;
      void api<{ count: number }>('/review-practice/progress', { signal }).then(value => {
        if (!signal.aborted) { setCount(value.count); setFailed(false); }
      }).catch(() => { if (!signal.aborted) setFailed(true); });
    };
    refresh(); window.addEventListener('practice-assessed', refresh);
    return () => { controller?.abort(); window.removeEventListener('practice-assessed', refresh); };
  }, []);
  return { count, failed };
}

export function ReviewNav({ selected, choose }: { selected: boolean; choose: () => void }) {
  const t = useTranslation(); const { count } = useReviewCount();
  const rank = count === null ? null : practiceRank(count);
  const label = rank ? `${t(rank.zh, rank.ja)}${rank.division ?? ''}` : '';
  const Icon = rank?.id === 'diamond' || rank?.id === 'prismatic' ? Gem : Medal;
  const title = t('大家的日本语', 'みんなの日本語', 'Minna no Nihongo');
  return <div id="review-subnav" className="special-subnav">
    <button aria-label={title} data-tier={rank?.id ?? 'pending'} aria-current={selected ? 'page' : undefined} className={selected ? 'active' : ''} onClick={choose}>
      <span>{title}</span>{rank && <span className="special-rank" title={label}><Icon size={15}/>{label}</span>}
    </button>
  </div>;
}
