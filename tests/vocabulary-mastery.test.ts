import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createPractice, closePractice, configurePractice, generatePractice, reference } from './practice-fixtures';
import { provider } from './recordings-fixtures';
import type { VocabularyLessonProgress } from '../src/shared/vocabulary';

describe('persistent vocabulary mastery', () => {
  it('skips marked words, masters after two questions, completes, restores and reopens unchecked words', async () => {
    const { app, aiFetch, dataDir } = createPractice();
    await configurePractice(app);
    const list = () => app.inject('/api/lessons/1/vocabulary');
    const content = (await list()).json<VocabularyLessonProgress>();
    const target = content.words[0];
    const mark = (wordId: string, mastered: boolean) => app.inject({ method: 'PATCH', url: `/api/lessons/1/vocabulary/${wordId}/mastery`, payload: { mastered } });
    for (const word of content.words.slice(1)) expect((await mark(word.id, true)).statusCode).toBe(200);
    expect((await app.inject('/api/ai-practice/mastery?lessonId=1')).json().modules.vocabulary.count).toBe(content.words.length - 1);
    aiFetch.mockImplementation(async () => provider({ correct: true, feedbackZh: '正确。', reference }));
    for (let count = 1; count <= 2; count++) {
      const question = await generatePractice(app, 'vocabulary');
      expect(question.content).toMatchObject({ wordId: target.id });
      const payload = { answer: reference.jp, clientAttemptId: randomUUID() };
      const answer = () => app.inject({ method: 'POST', url: `/api/ai-practice/questions/${question.id}/answer`, payload });
      expect((await answer()).statusCode).toBe(200);
      expect((await answer()).statusCode).toBe(200);
      // Even a new submission ID on the same question counts only once.
      payload.clientAttemptId = randomUUID();
      expect((await answer()).statusCode).toBe(200);
      const progress = (await list()).json<VocabularyLessonProgress>().mastery.find(word => word.wordId === target.id);
      expect(progress).toEqual({ wordId: target.id, correctCount: count, mastered: count === 2 });
    }
    const completed = { question: null, attempt: null, completed: true };
    expect((await app.inject('/api/ai-practice/current?lessonId=1&kind=vocabulary')).json()).toEqual(completed);
    expect((await app.inject({ method: 'POST', url: '/api/ai-practice/questions', payload: { lessonId: 1, kind: 'vocabulary', clientRequestId: randomUUID() } })).json()).toEqual(completed);
    expect((await app.inject('/api/ai-practice/mastery?lessonId=1')).json().modules.vocabulary).toMatchObject({ score: 100, count: content.words.length, total: content.words.length });
    const backup = (await app.inject('/api/backup')).json();
    expect(backup.vocabularyMastery).toHaveLength(content.words.length - 1);
    expect((await mark(target.id, false)).json().mastery[0]).toEqual({ wordId: target.id, correctCount: 0, mastered: false });
    expect((await generatePractice(app, 'vocabulary')).content).toMatchObject({ wordId: target.id });
    expect((await app.inject({ method: 'POST', url: '/api/restore', payload: { backup } })).statusCode).toBe(200);
    expect((await app.inject('/api/ai-practice/current?lessonId=1&kind=vocabulary')).json()).toEqual(completed);
    await closePractice(app);
    const restarted = createPractice({ dataDir }).app;
    expect((await restarted.inject('/api/ai-practice/current?lessonId=1&kind=vocabulary')).json()).toEqual(completed);
    const oldBackup = { ...backup }; delete oldBackup.vocabularyMastery;
    expect((await restarted.inject({ method: 'POST', url: '/api/restore', payload: { backup: oldBackup } })).statusCode).toBe(200);
    expect((await restarted.inject('/api/ai-practice/mastery?lessonId=1')).json().modules.vocabulary.count).toBe(1);
  });
  it('validates word ownership and backup marks before changing data', async () => {
    const { app } = createPractice();
    const word = (await app.inject('/api/lessons/1/vocabulary')).json().words[0];
    expect((await app.inject({ method: 'PATCH', url: `/api/lessons/2/vocabulary/${word.id}/mastery`, payload: { mastered: true } })).statusCode).toBe(404);
    expect((await app.inject({ method: 'PATCH', url: `/api/lessons/1/vocabulary/${word.id}/mastery`, payload: { mastered: 'yes' } })).statusCode).toBe(400);
    const backup = (await app.inject('/api/backup')).json();
    backup.vocabularyMastery = [{ wordId: word.id, lessonId: 2, mastered: true, updatedAt: new Date().toISOString() }];
    expect((await app.inject({ method: 'POST', url: '/api/restore', payload: { backup } })).statusCode).toBe(400);
    expect((await app.inject('/api/backup')).json().vocabularyMastery).toEqual([]);
  });
});
