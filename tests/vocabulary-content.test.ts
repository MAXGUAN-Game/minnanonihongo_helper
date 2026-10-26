import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { vocabularyForLesson, hasHistoricalVocabularyWord } from '../src/content/vocabulary';
import { getLesson } from '../src/content';

describe('edited offline vocabulary', () => {
  it('validates authored vocabulary, readings and sources without bundled examples', () => {
    const directory = new URL('../src/content/vocabulary/', import.meta.url);
    for (const file of readdirSync(directory).filter(name => name.endsWith('.json'))) {
      const data = JSON.parse(readFileSync(new URL(file, directory), 'utf8'));
      const loaded = vocabularyForLesson(data.lessonId);
      expect(data.sources.length).toBeGreaterThanOrEqual(2);
      expect(data.reviewNotes.length).toBeGreaterThan(0);
      for (const word of data.words) {
        expect(word).not.toHaveProperty('examples');
        expect(word.reading.trim()).not.toBe('');
        expect(word.reading, `${data.lessonId}: ${word.word}`).not.toMatch(/[一-龯A-Za-z]/);
        expect(word.meaning.trim()).not.toBe('');
        const item = loaded.words.find(item => item.word === word.word && item.reading === word.reading)!;
        expect(item).not.toHaveProperty('examples'); expect(item.partOfSpeech).not.toBe('');
        const prior = getLesson(data.lessonId)!.vocabulary.findIndex(entry => entry.word === word.word || (data.words.filter((other: { reading: string }) => other.reading === word.reading).length === 1 && entry.reading === word.reading));
        if (prior >= 0) expect(item.id).toBe(`l${data.lessonId}-v${prior + 1}`);
      }
      expect(new Set(loaded.words.map(item => item.id)).size).toBe(loaded.words.length);
      if (data.complete) {
        const audit = JSON.parse(readFileSync(new URL(`../src/content/vocabulary-audit/${file}`, import.meta.url), 'utf8'));
        expect(audit.edition).toBe(2);
        expect(audit.sources).toEqual(data.sources);
        expect(audit.entries.length + audit.excluded.length).toBe(audit.primaryCount);
        expect(audit.finalCount).toBe(data.words.length);
        const covered = new Set([...audit.entries.map((entry: { key: string }) => entry.key), ...audit.secondaryAdditions]);
        expect(covered).toEqual(new Set(data.words.map((word: { key: string }) => word.key)));
        expect(loaded.words).toHaveLength(data.words.length);
        expect(loaded.words.every(word => word.partOfSpeech)).toBe(true);
      }
    }
  });
  it('ships reviewed vocabulary for all 50 lessons, not the former ten-word selections', () => {
    for (let lesson = 1; lesson <= 50; lesson++) {
      const vocabulary = vocabularyForLesson(lesson);
      expect(vocabulary.complete, `lesson ${lesson}`).toBe(true);
      expect(vocabulary.words.length, `lesson ${lesson}`).toBeGreaterThan(10);
      expect(vocabulary.words.every(word => !('examples' in word))).toBe(true);
    }
  });
  it('keeps former selection IDs valid for history without accepting arbitrary identities', () => {
    const lesson = getLesson(5)!;
    lesson.vocabulary.forEach((_, index) => expect(hasHistoricalVocabularyWord(5, `l5-v${index + 1}`)).toBe(true));
    expect(hasHistoricalVocabularyWord(5, 'l5-v999')).toBe(false);
    expect(hasHistoricalVocabularyWord(5, 'l4-v1')).toBe(false);
    expect(vocabularyForLesson(5).complete).toBe(true);
  });
  it('keeps homophones distinct and includes the illustrated lesson 27 reading vocabulary', () => {
    const words = vocabularyForLesson(8).words;
    const hot = words.filter(word => ['暑い', '熱い'].includes(word.word));
    expect(hot).toHaveLength(2); expect(new Set(hot.map(word => word.id)).size).toBe(2);
    expect(vocabularyForLesson(27).words.map(word => word.word)).toEqual(expect.arrayContaining(['飼います', '建てます', '家具', 'キッチン', 'ドラえもん', '不思議な', '将来']));
  });
});
