import { vocabularyDetailSchema } from '../shared/vocabulary-details';
import { getLesson } from './index';
import type { VocabularyLesson } from '../shared/vocabulary';
import { existsSync, readFileSync } from 'node:fs';
import { z } from 'zod';

const editedLessonSchema = z.object({
  lessonId: z.number().int().min(1).max(50), complete: z.boolean(),
  sources: z.array(z.url()).min(2), reviewNotes: z.array(z.string().min(1)),
  words: z.array(z.object({ key: z.string().regex(/^[a-z0-9-]+$/), word: z.string().min(1),
    reading: z.string().min(1), partOfSpeech: z.string().min(1), meaning: z.string().min(1),
  }).strict()).min(1),
}).strict();
const cache = new Map<number, VocabularyLesson>();

// Old selections can contain words that belong to another textbook lesson.
// Retain their identities for importing historical results, not for new draws.
export function hasHistoricalVocabularyWord(lessonId: number, wordId: string) {
  if (vocabularyForLesson(lessonId).words.some(word => word.id === wordId)) return true;
  return (getLesson(lessonId)?.vocabulary ?? []).some((_, index) => wordId === `l${lessonId}-v${index + 1}`);
}

// Editorial replacement is intentionally explicit: the existing selection is not
// the complete textbook list. Release content must set complete only after review.
export function vocabularyForLesson(lessonId: number): VocabularyLesson {
  const cached = cache.get(lessonId); if (cached) return cached;
  const lesson = getLesson(lessonId);
  const result: VocabularyLesson = { lessonId, complete: false, words: (lesson?.vocabulary ?? []).map((entry, index) => ({
    id: `l${lessonId}-v${index + 1}`, lessonId, word: entry.word, reading: entry.reading,
    meaning: entry.meaning, partOfSpeech: '',
  })) };
  if (!lesson) return result;
  const file = new URL(`./vocabulary/${String(lessonId).padStart(2, '0')}.json`, import.meta.url);
  if (existsSync(file)) {
    const edited = editedLessonSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
    if (edited.lessonId !== lessonId || new Set(edited.words.map(word => word.key)).size !== edited.words.length) throw new Error('Invalid vocabulary identity');
    const reusedIds = new Set<string>();
    const revised = edited.words.map(word => {
      // Homophones such as 暑い／熱い must not inherit the same historical ID.
      const old = result.words.find(item => !reusedIds.has(item.id) && item.word === word.word)
        ?? (edited.words.filter(item => item.reading === word.reading).length === 1
          ? result.words.find(item => !reusedIds.has(item.id) && item.reading === word.reading) : undefined);
      if (old) reusedIds.add(old.id);
      return { id: old?.id ?? `l${lessonId}-${word.key}`, lessonId, word: word.word, reading: word.reading,
        meaning: word.meaning, partOfSpeech: word.partOfSpeech };
    });
    result.words = [...revised, ...(edited.complete ? [] : result.words.filter(word => !revised.some(item => item.id === word.id)))];
    result.complete = edited.complete;
  }
  const detailFile = new URL(`./vocabulary-details/${String(lessonId).padStart(2, '0')}.json`, import.meta.url);
  if (existsSync(detailFile)) {
    const details = JSON.parse(readFileSync(detailFile, 'utf8'));
    result.words = result.words.map(word => ({ ...word, ...(details[word.id] ? { detail: vocabularyDetailSchema.parse(details[word.id]) } : {}) }));
  }
  cache.set(lessonId, result); return result;
}
