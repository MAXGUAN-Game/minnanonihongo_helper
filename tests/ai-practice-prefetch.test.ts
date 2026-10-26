import { describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { PracticeCurrent, PracticeKind } from '../src/shared/ai-practice';
import type { VocabularyLessonProgress } from '../src/shared/vocabulary';
import { createPractice, configurePractice, generatePractice, reference } from './practice-fixtures';
import { provider } from './recordings-fixtures';

type App = ReturnType<typeof createPractice>['app'];
const prefetch = (app: App, kind: PracticeKind = 'dictation', clientRequestId: string = randomUUID(), lessonId = 1) => app.inject({ method: 'POST', url: '/api/ai-practice/prefetch', payload: { lessonId, kind, clientRequestId } });
const activate = (app: App, id: string, kind: PracticeKind = 'dictation', lessonId = 1) => app.inject({ method: 'POST', url: `/api/ai-practice/questions/${id}/activate`, payload: { lessonId, kind } });
const current = (app: App, kind: PracticeKind = 'dictation') => app.inject(`/api/ai-practice/current?lessonId=1&kind=${kind}`);
const alternative = { jp: '毎朝、駅まで歩いています。', kana: 'まいあさえきまであるいています。', zh: '我每天早上步行到车站。' };

describe('AI practice background generation and explicit activation', () => {
  it('stores five future questions without changing the active question, answers, or module progress', async () => {
    const { app, aiFetch } = createPractice(); await configurePractice(app);
    const original = await generatePractice(app, 'dictation');
    const before = (await app.inject('/api/ai-practice/mastery?lessonId=1')).json();
    const sentences = [alternative,
      { jp: '昨日、友達と映画を見ました。', kana: 'きのうともだちとえいがをみました。', zh: '昨天和朋友看了电影。' },
      { jp: 'ここに名前を書いてください。', kana: 'ここになまえをかいてください。', zh: '请在这里写名字。' },
      { jp: '来週は海で泳ぎたいです。', kana: 'らいしゅうはうみでおよぎたいです。', zh: '下周想去海里游泳。' },
      { jp: '弟は料理が上手です。', kana: 'おとうとはりょうりがじょうずです。', zh: '弟弟擅长做饭。' },
    ];
    const ids: string[] = [];
    for (const sentence of sentences) {
      aiFetch.mockResolvedValueOnce(provider({ kind: 'dictation', sentence }));
      const response = await prefetch(app);
      expect(response.statusCode, response.body).toBe(200);
      ids.push(response.json<PracticeCurrent>().question!.id);
      expect((await current(app)).json().question.id).toBe(original.id);
    }
    const backup = (await app.inject('/api/backup')).json();
    expect(backup.aiQuestions).toHaveLength(6);
    expect(backup.aiPositions).toEqual([{ lessonId: 1, kind: 'dictation', questionId: original.id }]);
    expect(backup.aiAttempts).toEqual([]); expect(backup.progress).toEqual([]);
    expect((await app.inject('/api/ai-practice/mastery?lessonId=1')).json()).toEqual(before);
    expect((await activate(app, ids[0])).json().question.id).toBe(ids[0]);
    expect((await current(app)).json().question.id).toBe(ids[0]);
    expect((await activate(app, ids[0])).json().question.id).toBe(ids[0]);
    expect(aiFetch).toHaveBeenCalledTimes(6);
  });

  it('deduplicates concurrent prefetch retries without activating an empty or existing position', async () => {
    const { app, aiFetch } = createPractice(); await configurePractice(app);
    const id = randomUUID();
    const responses = await Promise.all([prefetch(app, 'dictation', id), prefetch(app, 'dictation', id)]);
    responses.forEach(response => { expect(response.statusCode, response.body).toBe(200); expect(response.json().question.id).toBe(id); });
    expect(aiFetch).toHaveBeenCalledTimes(1);
    expect((await current(app)).json()).toEqual({ question: null, attempt: null });
    expect((await prefetch(app, 'speaking', id)).statusCode).toBe(409);
    aiFetch.mockResolvedValueOnce(provider({ kind: 'dictation', sentence: alternative }));
    const original = await generatePractice(app, 'dictation');
    expect((await prefetch(app, 'dictation', id)).json().question.id).toBe(id);
    expect((await prefetch(app, 'dictation', original.id)).json().question.id).toBe(original.id);
    expect((await current(app)).json().question.id).toBe(original.id);
    expect(aiFetch).toHaveBeenCalledTimes(2);
  });

  it('validates activation ownership, missing questions, and strict request shapes', async () => {
    const { app, aiFetch } = createPractice(); await configurePractice(app);
    const response = await prefetch(app); const id = response.json().question.id;
    expect((await activate(app, id, 'speaking')).statusCode).toBe(409);
    expect((await activate(app, id, 'dictation', 2)).statusCode).toBe(409);
    expect((await activate(app, randomUUID())).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: `/api/ai-practice/questions/${id}/activate`, payload: { lessonId: 1, kind: 'dictation', extra: true } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: `/api/ai-practice/questions/${id}/activate`, payload: { lessonId: 1 } })).statusCode).toBe(400);
    expect((await current(app)).json().question).toBeNull();
    expect(aiFetch).toHaveBeenCalledTimes(1);
  });

  it('discards vocabulary candidates mastered since prefetch, and returns completed only when all are mastered', async () => {
    const { app, aiFetch } = createPractice();
    const original = await generatePractice(app, 'vocabulary');
    const response = await prefetch(app, 'vocabulary');
    const candidate = response.json<PracticeCurrent>().question!;
    if (candidate.content.kind !== 'vocabulary') throw new Error('Expected vocabulary');
    const wordId = candidate.content.wordId;
    const mark = (id: string) => app.inject({ method: 'PATCH', url: `/api/lessons/1/vocabulary/${id}/mastery`, payload: { mastered: true } });
    expect((await mark(wordId)).statusCode).toBe(200);
    expect((await activate(app, candidate.id, 'vocabulary')).json()).toEqual({ question: null, attempt: null });
    expect((await current(app, 'vocabulary')).json().question.id).toBe(original.id);
    expect((await prefetch(app, 'vocabulary', candidate.id)).json()).toEqual({ question: null, attempt: null });
    const next = (await prefetch(app, 'vocabulary')).json<PracticeCurrent>().question!;
    expect(next.content).not.toMatchObject({ wordId });
    const words = (await app.inject('/api/lessons/1/vocabulary')).json<VocabularyLessonProgress>().words;
    for (const word of words) expect((await mark(word.id)).statusCode).toBe(200);
    expect((await activate(app, candidate.id, 'vocabulary')).json()).toEqual({ question: null, attempt: null, completed: true });
    expect((await prefetch(app, 'vocabulary')).json()).toEqual({ question: null, attempt: null, completed: true });
    expect(aiFetch).not.toHaveBeenCalled();
  });

  it('reserves queued fingerprints across kinds and retains them through backup restoration', async () => {
    const { app, aiFetch } = createPractice(); await configurePractice(app);
    const queued = await prefetch(app); const id = queued.json().question.id;
    expect((await prefetch(app)).json().code).toBe('PRACTICE_INVALID_RESPONSE');
    expect((await prefetch(app, 'speaking')).json().code).toBe('PRACTICE_INVALID_RESPONSE');
    expect((await current(app)).json().question).toBeNull();
    const backup = (await app.inject('/api/backup')).json();
    expect(backup.aiQuestions).toHaveLength(1);
    expect(backup.aiQuestions[0].fingerprints.length).toBeGreaterThan(0);
    expect((await app.inject({ method: 'POST', url: '/api/restore', payload: { backup } })).statusCode).toBe(200);
    expect((await prefetch(app)).json().code).toBe('PRACTICE_INVALID_RESPONSE');
    const calls = aiFetch.mock.calls.length;
    expect((await activate(app, id)).json().question.id).toBe(id);
    expect(aiFetch).toHaveBeenCalledTimes(calls);
  });

  it('blocks restore while a background request is running and keeps current position on failure', async () => {
    const { app, aiFetch } = createPractice(); await configurePractice(app);
    const original = await generatePractice(app, 'dictation');
    const backup = (await app.inject('/api/backup')).json();
    let release!: (response: Response) => void;
    aiFetch.mockImplementationOnce(async () => new Promise<Response>(resolve => { release = resolve; }));
    const response = prefetch(app);
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    try {
      expect((await app.inject({ method: 'POST', url: '/api/restore', payload: { backup } })).statusCode).toBe(409);
    } finally { release(provider({ kind: 'dictation', sentence: alternative })); }
    expect((await response).statusCode).toBe(200);
    aiFetch.mockRejectedValue(new Error('Unavailable'));
    expect((await prefetch(app)).statusCode).toBe(502);
    expect((await current(app)).json().question.id).toBe(original.id);
    expect((await app.inject({ method: 'POST', url: '/api/restore', payload: { backup } })).statusCode).toBe(200);
    expect((await current(app)).json().question.content.sentence).toEqual(reference);
  });
});
