import { describe, expect, it } from 'vitest';
import { lessonMastery } from '../src/server/mastery';
import type { PracticeAttempt, PracticeQuestion } from '../src/shared/ai-practice';

const question = (id: string, source = 27) => ({ id, grammarSourceLessonId: source } as PracticeQuestion);
const answer = (id: string, questionId: string, correct: boolean, usedHint = false, kind: 'dictation' | 'dialogue' = 'dictation') =>
  ({ id, questionId, correct, usedHint, kind, createdAt: `2026-10-23T00:00:${id.padStart(2, '0')}Z` } as PracticeAttempt);

describe('lesson mastery', () => {
  it('does not invent a score without evidence', () => {
    const result = lessonMastery(27, [], []);
    expect(result.dictation.score).toBeNull();
    expect(result.overall).toBeNull();
  });
  it('keeps the first incorrect answer when a retry succeeds', () => {
    const result = lessonMastery(27, [question('q')], [answer('01', 'q', false), answer('02', 'q', true)]);
    expect(result.dictation).toEqual({ count: 1, score: 33, provisional: true, accuracy: 0 });
  });
  it('excludes assisted questions and attributes review questions to their source', () => {
    const questions = [question('old', 26), question('hint')];
    const answers = [answer('01', 'old', true), answer('02', 'hint', true, true), answer('03', 'hint', true)];
    expect(lessonMastery(27, questions, answers).dictation.count).toBe(0);
    expect(lessonMastery(26, questions, answers).dictation.count).toBe(1);
  });
  it('requires ten samples in each listening mode', () => {
    const questions = Array.from({ length: 20 }, (_, i) => question(String(i)));
    const answers = questions.map((q, i) => answer(String(i), q.id, true, false, i < 10 ? 'dictation' : 'dialogue'));
    expect(lessonMastery(27, questions, answers.slice(0, 19)).listening).toBeNull();
    expect(lessonMastery(27, questions, answers).listening).toBe(92);
  });
  it('uses the independent commit when concurrent retries share a timestamp', () => {
    const first = answer('99', 'q', false), retry = answer('00', 'q', true, true);
    first.createdAt = retry.createdAt = '2026-10-23T00:00:00Z';
    expect(lessonMastery(27, [question('q')], [retry, first]).dictation).toMatchObject({ count: 1, score: 33, accuracy: 0 });
  });
  it('keeps only the most recent 100 independently answered questions in each mode', () => {
    const questions = Array.from({ length: 110 }, (_, i) => question(String(i)));
    const answers = questions.map((q, i) => ({ ...answer(String(i), q.id, i >= 10), createdAt: new Date(Date.UTC(2026, 9, 23, 0, i)).toISOString() }));
    expect(lessonMastery(27, questions, answers).dictation).toEqual({ count: 100, score: 99, provisional: false, accuracy: 1 });
  });
  it('separates uncertain pronunciation from meaning and grammar, and requires target grammar for passing', () => {
    const questions = [question('a'), question('b')];
    const attempt = (id: string, pronunciationScore: number | null, targetGrammarUsed: boolean) => ({ id, questionId: id, kind: 'speaking', createdAt: '2026-10-23T00:00:00Z', usedHint: false,
      result: { meaningScore: 40, grammarScore: 30, pronunciationScore, targetGrammarUsed } } as PracticeAttempt);
    const result = lessonMastery(27, questions, [attempt('a', null, true), attempt('b', 24, false)]);
    expect(result.speaking).toMatchObject({ count: 2, score: 75, accuracy: .5 });
    expect(result.pronunciation).toEqual({ count: 1, score: 80 }); expect(result.overall).toBeNull();
  });
});
