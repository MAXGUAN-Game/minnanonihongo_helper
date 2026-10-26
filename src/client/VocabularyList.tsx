import { VocabularyWord } from './VocabularyWord';
import type { Speech } from './speech';
import { useEffect, useRef, useState } from 'react';
import type { VocabularyLessonProgress } from '../shared/vocabulary';
import { api } from './api';
import { Button } from './ui';
import { useTranslation } from './preferences';
export function VocabularyList({ lessonId, furigana, speech }: { lessonId: number; furigana: boolean; speech: Speech }) {
  const t = useTranslation();
  const [content, setContent] = useState<VocabularyLessonProgress | null>(null);
  const [saving, setSaving] = useState<string | null>(null);
  const mutation = useRef<AbortController | null>(null);
  const [error, setError] = useState('');
  const [shown, setShown] = useState<Set<string>>(new Set());
  useEffect(() => {
    const controller = new AbortController(); setError(''); setContent(null); setShown(new Set());
    setSaving(null);
    void api<VocabularyLessonProgress>(`/lessons/${lessonId}/vocabulary`, { signal: controller.signal }).then(value => { if (!controller.signal.aborted) setContent(value); }).catch(failure => { if (!controller.signal.aborted) setError(failure.message); });
    return () => { controller.abort(); mutation.current?.abort(); mutation.current = null; };
  }, [lessonId]);
  async function toggleMastery(wordId: string, mastered: boolean) {
    if (mutation.current) return;
    const controller = new AbortController(); mutation.current = controller; setSaving(wordId); setError('');
    try {
      const value = await api<VocabularyLessonProgress>(`/lessons/${lessonId}/vocabulary/${encodeURIComponent(wordId)}/mastery`, { method: 'PATCH', signal: controller.signal, body: JSON.stringify({ mastered }) });
      if (!controller.signal.aborted) { setContent(value); window.dispatchEvent(new Event('practice-assessed')); }
    } catch (failure) { if (!controller.signal.aborted) setError((failure as Error).message); }
    finally { if (mutation.current === controller) { mutation.current = null; setSaving(null); } }
  }
  if (error && !content) return <p role="alert">{error}</p>;
  if (!content) return <p role="status">{t('正在读取单词……', '単語を読み込んでいます…')}</p>;
  const all = shown.size === content.words.length;
  return <section className="vocabulary-list">
    {error && <p role="alert">{error}</p>}
    <p className="tiny-note">{t('勾选或累计答对2道单词AI练习即为已掌握，练习会跳过已掌握的词。取消勾选将重新累计。', 'チェックするか、単語AI練習で2問正解すると習得済みになります。習得済みの単語は出題されません。チェックを外すと再集計します。')}</p>
    {!content.complete && <p className="notice-inline">{t('当前为已有精选词；教材完整词表仍在整理，尚未验收。', '現在は既存の抜粋語彙です。全語彙は編集中です。')}</p>}
    <Button secondary onClick={() => setShown(all ? new Set() : new Set(content.words.map(word => word.id)))}>{all ? t('隐藏所有翻译', '訳をすべて隠す') : t('显示所有翻译', '訳をすべて表示')}</Button>
    <table><thead><tr><th>{t('单词', '単語')}</th><th>{t('词性', '品詞')}</th><th>{t('翻译', '訳')}</th><th>{t('已掌握', '習得済み')}</th></tr></thead><tbody>{content.words.map(word => <tr key={word.id}>
      <td><VocabularyWord word={word.word} wordId={word.id} lessonId={lessonId} speech={speech}/>{furigana && <small lang="ja">{word.reading}</small>}</td><td>{word.partOfSpeech || '—'}{word.detail?.attributes.map(attribute => <small key={attribute}>{attribute}</small>)}</td>
      <td><button className="text-button translation-toggle" aria-expanded={shown.has(word.id)} onClick={() => setShown(previous => { const next = new Set(previous); if (next.has(word.id)) next.delete(word.id); else next.add(word.id); return next; })}><span className={shown.has(word.id) ? 'translation-space' : 'translation-space concealed'}>{word.meaning}</span>{!shown.has(word.id) && <span className="translation-prompt">{t('显示翻译', '訳を表示')}</span>}</button></td>
      <td><input type="checkbox" role="switch" aria-label={`${word.word} · ${t('已掌握', '習得済み')}`} checked={content.mastery?.some(item => item.wordId === word.id && item.mastered) ?? false} disabled={saving !== null} onChange={event => void toggleMastery(word.id, event.target.checked)}/></td>
    </tr>)}</tbody></table>
  </section>;
}
