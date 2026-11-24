import { useEffect, useState } from 'react';
import { Gem, Medal } from 'lucide-react';
import { specialTopics, type SpecialTopic } from '../shared/special-practice';
import { practiceRank } from '../shared/practice-rank';
import { api } from './api';
import { useTranslation } from './preferences';

export function SpecialNav({selected,choose}:{selected?:string;choose:(topic:SpecialTopic|'katakana')=>void}){
  const t=useTranslation();const [counts,setCounts]=useState<Record<string,number>>({});
  useEffect(()=>{
    let controller:AbortController|undefined;
    const refresh=()=>{controller?.abort();controller=new AbortController();const signal=controller.signal;
      void api<Record<string,number>>('/special-practice/ranks',{signal}).then(value=>{if(!signal.aborted)setCounts(value);}).catch(()=>{});
    };refresh();window.addEventListener('practice-assessed',refresh);
    return()=>{controller?.abort();window.removeEventListener('practice-assessed',refresh);};
  },[]);
  return <div id="special-subnav" className="special-subnav">{[{id:'katakana' as const,zh:'片假名',ja:'カタカナ'},...specialTopics].map(topic=>{
    const count=counts[topic.id];const rank=count===undefined?undefined:practiceRank(count);
    const label=rank?`${t(rank.zh,rank.ja)}${rank.division??''}`:'';const Icon=rank?.id==='prismatic'||rank?.id==='diamond'?Gem:Medal;
    return <button key={topic.id} aria-label={t(topic.zh,topic.ja)} data-tier={rank?.id??'pending'} aria-current={selected===topic.id?'page':undefined} className={selected===topic.id?'active':''} onClick={()=>choose(topic.id)}><span>{t(topic.zh,topic.ja)}</span>{rank&&<span className="special-rank" title={label}><Icon size={15}/>{label}</span>}</button>;
  })}</div>;
}
