import { describe, expect, it } from 'vitest';
import { moduleProgress } from '../src/server/module-progress';
import { vocabularyMastery } from '../src/server/vocabulary-mastery';
import { scoreResult } from './practice-fixtures';
import type { PracticeAttempt, PracticeQuestion } from '../src/shared/ai-practice';
import type { Attempt } from '../src/server/schemas';

describe('module charge progress', () => {
  it('requires two correct questions per word and keeps grammar completion', () => {
    const questions = ['q1', 'q2', 'q3', 'q4'].map((id, i) => ({ id, content: { kind: 'vocabulary', wordId: i === 3 ? 'other-lesson' : i === 1 ? 'w2' : 'w1' } } as PracticeQuestion));
    const answer = (id: string, questionId: string, correct: boolean, usedHint = false) => ({ id, questionId, kind: 'vocabulary', correct, usedHint, createdAt: id } as PracticeAttempt);
    const answers = [answer('1', 'q1', false), answer('2', 'q1', true, true), answer('3', 'q2', true, true), answer('4', 'q3', true), answer('5', 'q4', true)];
    const history = [{ itemId: 'g1', result: 'good' }, { itemId: 'g1', result: 'good' }, { itemId: 'g2', result: 'hint' }, { itemId: 'foreign', result: 'good' }] as Attempt[];
    const result = moduleProgress(1, ['w1', 'w2'], ['g1', 'g2'], questions, answers, history);
    expect(result.vocabulary).toEqual({ score: 50, count: 1, total: 2, provisional: false });
    expect(result.understand).toEqual({ score: 50, count: 1, total: 2, provisional: false });
    expect(result.listen).toEqual({ score: 0, count: 0, total: 100, provisional: false });
    expect(result.speak).toEqual(result.listen);
    questions.push({ id: 'q5', content: { kind: 'vocabulary', wordId: 'w1' } } as PracticeQuestion);
    answers.push(answer('6', 'q3', true, true), answer('7', 'q5', true));
    expect(moduleProgress(1, ['w1', 'w2'], [], questions, answers, []).vocabulary).toEqual({ score: 50, count: 1, total: 2, provisional: false });
    const marks = [{ wordId: 'w2', lessonId: 1, mastered: true, updatedAt: '8' }];
    expect(moduleProgress(1, ['w1', 'w2'], [], questions, answers, [], marks).vocabulary.score).toBe(100);
    expect(vocabularyMastery(['w1'], questions, answers, [{ wordId: 'w1', lessonId: 1, mastered: false, updatedAt: '7' }])).toEqual([{ wordId: 'w1', mastered: false, correctCount: 0 }]);
    answers.push(answer('9', 'q5', true));
    expect(vocabularyMastery(['w1'], questions, answers, [{ wordId: 'w1', lessonId: 1, mastered: false, updatedAt: '7' }])[0].correctCount).toBe(1);
  });
  it('counts correct listening questions once in the practiced unit, including corrected retries', () => {
    const questions = ['dictation', 'dialogue', 'dictation'].map((kind, i) => ({ id: `q${i}`, lessonId: i === 2 ? 2 : 1, grammarSourceLessonId: 2, content: { kind } } as PracticeQuestion));
    const attempts = [
      { questionId: 'q0', lessonId: 1, kind: 'dictation', correct: false },
      { questionId: 'q0', lessonId: 1, kind: 'dictation', correct: true, usedHint: true },
      { questionId: 'q0', lessonId: 1, kind: 'dictation', correct: true },
      { questionId: 'q1', lessonId: 1, kind: 'dialogue', correct: true },
      { questionId: 'q2', lessonId: 2, kind: 'dictation', correct: true },
      { questionId: 'missing', lessonId: 1, kind: 'dictation', correct: true },
    ] as PracticeAttempt[];
    expect(moduleProgress(1, [], [], questions, attempts, []).listen).toEqual({ score: 2, count: 2, total: 100, provisional: false });
    expect(moduleProgress(2, [], [], questions, attempts, []).listen.count).toBe(1);
  });
  it('uses strictly over 90 for audio and normalized text scores, excluding uncertain audio', () => {
    const values = [90, 91, 100, null, 63, 64, 70];
    const questions = values.map((_, i) => ({ id: `q${i}`, lessonId: 1, content: { kind: 'speaking' } } as PracticeQuestion));
    const attempts = values.map((score, i) => ({ id: `a${i}`, createdAt: '2026-10-25T00:00:00Z', usedHint: false, latencyMs: 0, questionId: `q${i}`, lessonId: 1, kind: 'speaking', inputMode: i < 4 ? 'audio' : 'text', totalScore: i < 4 ? score : null,
      result: { ...scoreResult(), meaningScore: 40, grammarScore: i < 4 ? 30 : score! - 40, pronunciationScore: i < 4 ? score === null ? null : score - 70 : null } } as PracticeAttempt));
    expect(moduleProgress(1, [], [], questions, [...attempts, ...attempts], []).speak).toEqual({ score: 4, count: 4, total: 100, provisional: false });
  });
  it('caps completed questions and percentages at 100', () => {
    const questions = Array.from({ length: 105 }, (_, i) => ({ id: `q${i}`, lessonId: 1, content: { kind: 'dialogue' } } as PracticeQuestion));
    const attempts = questions.map(q => ({ questionId: q.id, lessonId: 1, kind: 'dialogue', correct: true } as PracticeAttempt));
    expect(moduleProgress(1, [], [], questions, attempts, []).listen).toEqual({ score: 100, count: 100, total: 100, provisional: false });
  });
});
