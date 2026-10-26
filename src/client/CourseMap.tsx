import { useEffect, useState } from 'react';
import { ArrowRight, Check, Crown, Gem, LockKeyhole, Medal, Search } from 'lucide-react';
import type { Bootstrap, Lesson } from '../shared/types';
import { courseCardTier, type CourseCardTier, type LessonProgress } from '../shared/course-progress';
import { api } from './api';
import { Empty, Heading } from './ui';
import { useTranslation } from './preferences';

const tiers = {
  locked: { zh: '未解锁', ja: '未解放', icon: LockKeyhole },
  bronze: { zh: '铜卡', ja: 'ブロンズ', icon: Medal },
  silver: { zh: '银卡', ja: 'シルバー', icon: Medal },
  gold: { zh: '金卡', ja: 'ゴールド', icon: Crown },
  diamond: { zh: '钻石卡', ja: 'ダイヤモンド', icon: Gem },
} satisfies Record<CourseCardTier, { zh: string; ja: string; icon: typeof Gem }>;

export function CourseMap({ lessons, bootstrap, choose }: { lessons: Lesson[]; bootstrap: Bootstrap; choose: (id: number) => Promise<void> }) {
  const t = useTranslation();
  const [volume, setVolume] = useState<1 | 2>(bootstrap.settings.currentLessonId <= 25 ? 1 : 2);
  const [search, setSearch] = useState('');
  const [progress, setProgress] = useState<LessonProgress[] | null>(null);
  const [error, setError] = useState(false);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let request: AbortController | undefined;
    const refresh = () => {
      request?.abort();
      request = new AbortController();
      const signal = request.signal;
      setError(false);
      void api<LessonProgress[]>('/course-progress', { signal }).then(value => {
        if (!signal.aborted) setProgress(value);
      }).catch(() => { if (!signal.aborted) setError(true); });
    };
    refresh();
    window.addEventListener('practice-assessed', refresh);
    return () => { request?.abort(); window.removeEventListener('practice-assessed', refresh); };
  }, [revision]);
  const progressByLesson = new Map(progress?.map(item => [item.lessonId, item.score]));
  const filtered = lessons.filter(lesson => lesson.volume === volume && (!search.trim() || `${lesson.id} ${lesson.title} ${lesson.canDo} ${lesson.grammar.map(g => g.title).join(' ')}`.includes(search.trim())));
  const explanation = t('单元进度为单词、语法、听力、口语四项进度的平均值。', '単元の進捗は、単語・文法・聴解・会話の4項目の平均です。');
  return <>
    <Heading eyebrow={t('你的课程地图', 'あなたの課マップ')} title={<>{t('一步一课，', '一歩ずつ、')}<em>{t('走到能用。', '使える日本語へ。')}</em></>} description={t('从灰卡到钻石卡，看见每一步积累。所有单元都可以点击开始。', 'グレーからダイヤモンドへ、毎日の積み重ねを形に。どの課からでも始められます。')}/>
    <div className="map-toolbar">
      <div className="segmented"><button aria-pressed={volume === 1} onClick={() => setVolume(1)}>{t('初级 Ⅰ · 1–25', '初級 Ⅰ · 1–25')}</button><button aria-pressed={volume === 2} onClick={() => setVolume(2)}>{t('初级 Ⅱ · 26–50', '初級 Ⅱ · 26–50')}</button></div>
      <label className="search-box"><Search size={20}/><input aria-label={t('查找课程', '課を検索')} placeholder={t('课次 / 语法 / 场景', '課 / 文法 / 場面')} value={search} onChange={event => setSearch(event.target.value)}/></label>
    </div>
    <p className="course-progress-note">{explanation}</p>
    {error && <div className="course-progress-error" role="alert"><span>{t('暂时无法读取单元进度。', '進捗を読み込めませんでした。')}</span><button className="text-button" onClick={() => setRevision(value => value + 1)}>{t('重试', '再試行')}</button></div>}
    <div className="course-grid">{filtered.map(lesson => {
      const score = progressByLesson.get(lesson.id);
      const tier = score === undefined ? undefined : courseCardTier(score);
      const appearance = tier ? tiers[tier] : undefined;
      const Icon = appearance?.icon;
      const active = lesson.id === bootstrap.settings.currentLessonId;
      const progressText = score === undefined ? t(error ? '进度暂不可用' : '正在读取进度', error ? '進捗を取得できません' : '進捗を読み込み中') : `${score}%`;
      return <button className={`course-card ${active ? 'current' : ''}`} data-lesson-id={lesson.id} data-tier={tier ?? 'pending'} key={lesson.id} onClick={() => void choose(lesson.id)}>
        <span className="course-top"><span className="course-number">{String(lesson.id).padStart(2, '0')}</span>
          {appearance && Icon && <span className="course-tier" role="img" aria-label={t(appearance.zh, appearance.ja)} title={t(appearance.zh, appearance.ja)}><Icon size={18} aria-hidden="true"/></span>}
        </span>
        <h2>{lesson.title}</h2><p>{lesson.canDo}</p>
        <span className="course-progress" title={explanation}>
          <span className="course-progress-caption"><span>{t('单元进度', '単元の進捗')}</span><strong className={score === undefined ? 'pending' : undefined}>{progressText}</strong></span>
          <span className="course-progress-track" role="progressbar" aria-label={t(`第 ${lesson.id} 单元进度`, `第${lesson.id}課の進捗`)} aria-valuemin={0} aria-valuemax={100} aria-valuenow={score} aria-valuetext={progressText} aria-busy={score === undefined && !error}><span style={{ width: `${score ?? 0}%` }}/></span>
        </span>
        <span className="course-bottom"><span>{t(`${lesson.grammar.length} 个语法`, `文法 ${lesson.grammar.length} 項目`)}</span><span className="course-entry">{active && <span className="course-current"><Check size={13} aria-hidden="true"/>{t('当前选择', '選択中')}</span>}<ArrowRight size={18} aria-hidden="true"/></span></span>
      </button>;
    })}</div>
    {!filtered.length && <Empty title={t('换个关键词试试', '別のキーワードで検索')} text={t('可以输入课次数字，或者本课语法。', '課の番号や文法を入力してください。')}/>}
  </>;
}
