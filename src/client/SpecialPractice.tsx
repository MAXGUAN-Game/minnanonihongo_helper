import { useState } from 'react';
import { Headphones, Mic } from 'lucide-react';
import { AIPractice } from './AIPractice';
import { Heading } from './ui';
import { SpecialRank } from './RankProgress';
import { useTranslation } from './preferences';
import type { Speech } from './speech';
import { topicInfo, type SpecialTopic } from '../shared/special-practice';

export function SpecialPractice({ topic, speech, notice, furigana }: { topic: SpecialTopic; speech: Speech; notice: (message: string) => void; furigana: boolean }) {
  const t = useTranslation();
  const [kind, setKind] = useState<'dictation' | 'speaking'>('dictation');
  const info = topicInfo(topic);
  return <>
    <Heading eyebrow={t('专项练习', '集中練習')} title={t(info.zh, info.ja)} description={t(`${info.description}。只练短语，不练完整句子。`, '短い表現を聞き、話す練習です。')}/>
    <SpecialRank topic={topic}/>
    <div className="content-switch" role="group" aria-label={t('专项练习模式', '集中練習の種類')}>
      <button aria-label={t('听力-AI练习', '聴解-AI練習')} title={t('听力-AI练习', '聴解-AI練習')} aria-pressed={kind === 'dictation'} className={kind === 'dictation' ? 'active' : ''} onClick={() => { speech.stop(); setKind('dictation'); }}><Headphones size={18}/> <span className="immersion-text">{t('听力-AI练习', '聴解-AI練習')}</span></button>
      <button aria-label={t('口语-AI练习', '会話-AI練習')} title={t('口语-AI练习', '会話-AI練習')} aria-pressed={kind === 'speaking'} className={kind === 'speaking' ? 'active' : ''} onClick={() => { speech.stop(); setKind('speaking'); }}><Mic size={18}/> <span className="immersion-text">{t('口语-AI练习', '会話-AI練習')}</span></button>
    </div>
    <AIPractice key={`${topic}:${kind}`} lessonId={0} topic={topic} kind={kind} speech={speech} notice={notice} furigana={furigana}/>
  </>;
}
