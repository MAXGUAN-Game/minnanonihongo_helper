import { describe, expect, it } from 'vitest';
import { getLesson } from '../src/content';
import { vocabularyForLesson } from '../src/content/vocabulary';
import { moduleProgress } from '../src/server/module-progress';
import type { Attempt } from '../src/server/schemas';
import type { PracticeAttempt, PracticeQuestion } from '../src/shared/ai-practice';
import type { Progress } from '../src/shared/types';
import { createPractice } from './practice-fixtures';

const stages = ['vocabulary', 'understand', 'listen', 'speak'] as const;
const timestamp = '2026-10-25T00:00:00.000Z';
const adjustment = (lessonId: number, stage: Progress['stage'], baselineCount = 0): Progress => ({
  lessonId, stage, cursor: 0, status: 'seen', updatedAt: timestamp,
  manualProgress: { score: 70, baselineCount },
});

describe('manual module progress', () => {
  it('sets all four modules in lessons 27–29 to exactly 70 without inventing completed items', () => {
    const progress = [27, 28, 29].flatMap(id => stages.map(stage => adjustment(id, stage)));
    for (const id of [27, 28, 29]) {
      const words = vocabularyForLesson(id).words.map(word => word.id);
      const grammar = getLesson(id)!.grammar.map(item => item.id);
      const modules = moduleProgress(id, words, grammar, [], [], [], [], progress);
      for (const stage of stages) expect(modules[stage]).toMatchObject({ score: 70, count: 0, manual: true });
      expect(modules.vocabulary.total).toBe(words.length);
      expect(modules.understand.total).toBe(grammar.length);
      expect(modules.listen.total).toBe(100);
      expect(modules.speak.total).toBe(100);
    }
    const unchanged = moduleProgress(26, ['word'], ['grammar'], [], [], [], [], progress);
    for (const stage of stages) expect(unchanged[stage]).toEqual({ score: 0, count: 0, total: stage === 'vocabulary' || stage === 'understand' ? 1 : 100, provisional: false });
  });

  it('continues from the recorded baseline, tracks real changes and clamps at zero and 100', () => {
    const progress = [adjustment(27, 'vocabulary', 2), adjustment(27, 'understand', 1)];
    const words = ['w1', 'w2'];
    const marks = words.map(wordId => ({ wordId, lessonId: 27, mastered: true, updatedAt: timestamp }));
    const history = [{ itemId: 'g1', result: 'good', usedHint: false }] as Attempt[];
    const calculate = (wordMarks = marks, grammarHistory = history) => moduleProgress(27, words, ['g1', 'g2', 'g3'], [], [], grammarHistory, wordMarks, progress);
    expect(calculate().vocabulary).toMatchObject({ score: 70, count: 2 });
    expect(calculate().understand).toMatchObject({ score: 70, count: 1 });
    expect(calculate(marks.slice(0, 1)).vocabulary).toMatchObject({ score: 20, count: 1 });
    expect(calculate([]).vocabulary).toMatchObject({ score: 0, count: 0 });
    expect(calculate(marks, []).understand).toMatchObject({ score: 37, count: 0 });
    expect(calculate(marks, [...history, { itemId: 'g2', result: 'good', usedHint: false } as Attempt]).understand).toMatchObject({ score: 100, count: 2 });
  });

  it('advances adjusted listening only for a newly completed question, including corrected retries', () => {
    const questions = ['q1', 'q2'].map(id => ({ id, lessonId: 27, content: { kind: 'dictation' } } as PracticeQuestion));
    const answer = (questionId: string, correct = true) => ({ questionId, lessonId: 27, kind: 'dictation', correct } as PracticeAttempt);
    const progress = [adjustment(27, 'listen', 1)];
    const calculate = (attempts: PracticeAttempt[]) => moduleProgress(27, [], [], questions, attempts, [], [], progress).listen;
    expect(calculate([answer('q1')])).toMatchObject({ score: 70, count: 1 });
    expect(calculate([answer('q1'), answer('q1'), answer('q2', false)])).toMatchObject({ score: 70, count: 1 });
    expect(calculate([answer('q1'), answer('q2', false), answer('q2')])).toMatchObject({ score: 71, count: 2 });
  });

  it('continues after more than 100 listening successes while the visible completed count stays capped', () => {
    const questions = Array.from({ length: 102 }, (_, i) => ({ id: `q${i}`, lessonId: 27, content: { kind: 'dialogue' } } as PracticeQuestion));
    const attempts = questions.map(question => ({ questionId: question.id, lessonId: 27, kind: 'dialogue', correct: true } as PracticeAttempt));
    const progress = [adjustment(27, 'listen', 101)];
    expect(moduleProgress(27, [], [], questions, attempts.slice(0, 101), [], [], progress).listen).toMatchObject({ score: 70, count: 100, total: 100 });
    expect(moduleProgress(27, [], [], questions, attempts, [], [], progress).listen).toMatchObject({ score: 71, count: 100, total: 100 });
  });

  it('preserves adjustments through navigation and backup restore while new learning still counts', async () => {
    const { app } = createPractice();
    const outsideBefore = (await app.inject('/api/ai-practice/mastery?lessonId=26')).json();
    const backup = (await app.inject('/api/backup')).json();
    backup.progress = [27, 28, 29].flatMap(id => stages.map(stage => adjustment(id, stage)));
    const restored = await app.inject({ method: 'POST', url: '/api/restore', payload: { backup } });
    expect(restored.statusCode, restored.body).toBe(200);
    for (const id of [27, 28, 29]) {
      const modules = (await app.inject(`/api/ai-practice/mastery?lessonId=${id}`)).json().modules;
      for (const stage of stages) expect(modules[stage]).toMatchObject({ score: 70, count: 0, manual: true });
    }
    const navigation = await app.inject({ method: 'POST', url: '/api/progress', payload: { lessonId: 27, stage: 'understand', cursor: 1, status: 'seen' } });
    expect(navigation.statusCode).toBe(200);
    expect(navigation.json()).toMatchObject({ cursor: 1, manualProgress: { score: 70, baselineCount: 0 } });
    expect((await app.inject('/api/backup')).json().attempts).toEqual([]);
    const grammar = getLesson(27)!.grammar[0];
    const attempt = await app.inject({ method: 'POST', url: '/api/attempts', payload: { lessonId: 27, itemId: grammar.id, result: 'good', usedHint: false } });
    expect(attempt.statusCode).toBe(200);
    const word = vocabularyForLesson(27).words[0];
    expect((await app.inject({ method: 'PATCH', url: `/api/lessons/27/vocabulary/${word.id}/mastery`, payload: { mastered: true } })).statusCode).toBe(200);
    const changed = (await app.inject('/api/ai-practice/mastery?lessonId=27')).json();
    expect(changed.modules.understand).toMatchObject({ score: 90, count: 1, total: 5 });
    expect(changed.modules.vocabulary).toMatchObject({ score: 72, count: 1, total: 44 });
    expect((await app.inject('/api/ai-practice/mastery?lessonId=26')).json()).toEqual(outsideBefore);
    const saved = (await app.inject('/api/backup')).json();
    expect(saved.attempts).toHaveLength(1);
    expect(saved.aiAttempts).toEqual([]);
    expect(saved.vocabularyMastery).toHaveLength(1);
    const second = createPractice().app;
    const imported = await second.inject({ method: 'POST', url: '/api/restore', payload: { backup: saved } });
    expect(imported.statusCode, imported.body).toBe(200);
    expect((await second.inject('/api/backup')).json().progress).toEqual(saved.progress);
    expect((await second.inject('/api/ai-practice/mastery?lessonId=27')).json()).toEqual(changed);
  });

  it('rejects malformed adjustments atomically and keeps navigation from replacing an adjustment', async () => {
    const { app } = createPractice();
    const backup = (await app.inject('/api/backup')).json();
    backup.progress = [adjustment(27, 'understand')];
    expect((await app.inject({ method: 'POST', url: '/api/restore', payload: { backup } })).statusCode).toBe(200);
    for (const manualProgress of [
      { score: -1, baselineCount: 0 },
      { score: 101, baselineCount: 0 },
      { score: 70, baselineCount: -1 },
      { score: 70, baselineCount: 0.5 },
      { score: 70, baselineCount: 6 },
    ]) {
      const invalid = structuredClone(backup);
      invalid.settings.currentLessonId = 28;
      invalid.progress[0].manualProgress = manualProgress;
      expect((await app.inject({ method: 'POST', url: '/api/restore', payload: { backup: invalid } })).statusCode).toBe(400);
      const after = (await app.inject('/api/backup')).json();
      expect(after.progress).toEqual(backup.progress);
      expect(after.settings.currentLessonId).toBe(backup.settings.currentLessonId);
    }
    const attemptedReplacement = await app.inject({ method: 'POST', url: '/api/progress', payload: { lessonId: 27, stage: 'understand', cursor: 0, status: 'seen', manualProgress: { score: 100, baselineCount: 0 } } });
    expect(attemptedReplacement.statusCode).toBe(400);
    const invalidConversation = structuredClone(backup);
    invalidConversation.progress[0].stage = 'conversation';
    expect((await app.inject({ method: 'POST', url: '/api/restore', payload: { backup: invalidConversation } })).statusCode).toBe(400);
    expect((await app.inject('/api/backup')).json().progress).toEqual(backup.progress);
  });
});
