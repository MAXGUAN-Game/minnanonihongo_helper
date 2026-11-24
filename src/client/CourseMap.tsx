import { translate, localize } from './i18n';
import { useEffect, useState } from 'react';
import { ArrowRight, Check, Crown, Gem, LockKeyhole, Medal, Search } from 'lucide-react';
import type { Bootstrap, Lesson } from '../shared/types';
import { courseCardTier, type CourseCardTier, type LessonProgress } from '../shared/course-progress';
import { api } from './api';
import { Empty, Heading } from './ui';
import { useTranslation } from './preferences';
import { courseRank } from '../shared/course-progress';

const tiers = {
  iron: { zh: '黑铁', ja: 'アイアン', icon: Medal },
  bronze: { zh: '青铜', ja: 'ブロンズ', icon: Medal },
  silver: { zh: '白银', ja: 'シルバー', icon: Medal },
  gold: { zh: '黄金', ja: 'ゴールド', icon: Crown },
  diamond: { zh: '钻石', ja: 'ダイヤモンド', icon: Gem },
  prismatic: { zh: '棱彩', ja: 'プリズマ', icon: Gem },
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
  const filtered = lessons.filter(lesson => lesson.volume === volume && (!search.trim() || `${lesson.id} ${lesson.title} ${translate(lesson.title)} ${lesson.canDo} ${translate(lesson.canDo)} ${lesson.grammar.map(g => translate(g.title)).join(' ')}`.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase())));
  const explanation = t('课程进度取听力、口语百分比的平均值，各以 100 题为分母，单项最高 100%。单词与语法不参与；同题只计一次，跳过按答对计。', '聴解・会話を各 100 問で 100%（上限）とし、平均値を進捗に使用。単語・文法は対象外。同じ問題は1回のみ加算し、スキップは正解扱い。', 'Course progress averages listening and speaking percentages, each capped at 100% with a target of 100 questions. Vocabulary and grammar are excluded. Each question counts once; mastered skips count as correct.');
  return <>
    <Heading eyebrow={t('你的课程地图', 'あなたの課マップ')} title={<>{t('一步一课，', '一歩ずつ、')}<em>{t('走到能用。', '使える日本語へ。')}</em></>} description={t('从黑铁到棱彩，五级小段位逐步晋升。所有单元都可以点击开始。', 'アイアンからプリズマへ、5段階ずつ昇格。どの課からでも始められます。', 'Advance from Iron to Prismatic, with five divisions in each rank below Prismatic. Start any lesson.')}/>
    <div className="map-toolbar">
      <div className="segmented"><button aria-pressed={volume === 1} onClick={() => setVolume(1)}>{t('初级 Ⅰ · 1–25', '初級 Ⅰ · 1–25')}</button><button aria-pressed={volume === 2} onClick={() => setVolume(2)}>{t('初级 Ⅱ · 26–50', '初級 Ⅱ · 26–50')}</button></div>
      <label className="search-box"><Search size={20}/><input aria-label={t('查找课程', '課を検索')} placeholder={t('课次 / 语法 / 场景', '課 / 文法 / 場面')} value={search} onChange={event => setSearch(event.target.value)}/></label>
    </div>
    <p className="course-progress-note">{localize(explanation)}</p>
    {error && <div className="course-progress-error" role="alert"><span>{t('暂时无法读取单元进度。', '進捗を読み込めませんでした。')}</span><button className="text-button" onClick={() => setRevision(value => value + 1)}>{t('重试', '再試行')}</button></div>}
    <div className="course-grid">{filtered.map(lesson => {
      const score = progressByLesson.get(lesson.id);
      const tier = score === undefined ? undefined : courseCardTier(score);
      const rank = score === undefined ? undefined : courseRank(score);
      const rankName = rank ? `${t(rank.zh, rank.ja)}${rank.division ?? ''}` : '';
      const appearance = tier ? tiers[tier] : undefined;
      const Icon = appearance?.icon;
      const active = lesson.id === bootstrap.settings.currentLessonId;
      const progressText = score === undefined ? t(error ? '进度暂不可用' : '正在读取进度', error ? '進捗を取得できません' : '進捗を読み込み中') : `${score}%`;
      return <button className={`course-card ${active ? 'current' : ''}`} data-lesson-id={lesson.id} data-tier={tier ?? 'pending'} key={lesson.id} onClick={() => void choose(lesson.id)}>
        <span className="course-top"><span className="course-number">{String(lesson.id).padStart(2, '0')}</span>
          {appearance && Icon && <span className="course-tier" role="img" aria-label={rankName} title={rankName}><Icon size={18} aria-hidden="true"/>{localize(rankName)}</span>}
        </span>
        <h2>{localize(lesson.title)}</h2><p>{localize(lesson.canDo)}</p>
        <span className="course-progress" title={explanation}>
          <span className="course-progress-caption"><span>{t('单元进度', '単元の進捗')}</span><strong className={score === undefined ? 'pending' : undefined}>{localize(progressText)}</strong></span>
          <span className="course-progress-track" role="progressbar" aria-label={t(`第 ${lesson.id} 单元进度`, `第${lesson.id}課の進捗`)} aria-valuemin={0} aria-valuemax={100} aria-valuenow={score} aria-valuetext={`${rankName} · ${progressText}`} aria-busy={score === undefined && !error}><span style={{ width: `${score ?? 0}%` }}/></span>
        </span>
        <span className="course-bottom"><span>{t(`${lesson.grammar.length} 个语法`, `文法 ${lesson.grammar.length} 項目`)}</span><span className="course-entry">{active && <span className="course-current"><Check size={13} aria-hidden="true"/>{t('当前选择', '選択中')}</span>}<ArrowRight size={18} aria-hidden="true"/></span></span>
      </button>;
    })}</div>
    {!filtered.length && <Empty title={t('换个关键词试试', '別のキーワードで検索')} text={t('可以输入课次数字，或者本课语法。', '課の番号や文法を入力してください。')}/>}
  </>;
}
