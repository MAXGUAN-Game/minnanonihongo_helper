import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createPractice, generatePractice, reference, scoreResult, submitAudio } from './practice-fixtures';
import { fixtureKey, provider } from './recordings-fixtures';
import { practiceAttemptSchema } from '../src/shared/ai-practice';

function textResult() {
  const { text: _text, pronunciation: _pronunciation, pronunciationScore: _pronunciationScore, ...result } = scoreResult();
  return result;
}
describe('speaking practice with a typed answer', () => {
  it('grades with DeepSeek only, deduplicates submissions, restores text and counts no pronunciation sample', async () => {
    const { app, aiFetch, audioFetch } = createPractice();
    await app.inject({ method: 'PATCH', url: '/api/settings', payload: { apiKey: fixtureKey } });
    const question = await generatePractice(app);
    aiFetch.mockImplementation(async () => provider(textResult()));
    const id = randomUUID();
    const submit = (answer = reference.jp) => app.inject({ method: 'POST', url: `/api/ai-practice/questions/${question.id}/answer`, payload: { answer, clientAttemptId: id } });
    const replies = await Promise.all([submit(), submit(), submit()]);
    replies.forEach(reply => {
      expect(reply.statusCode, reply.body).toBe(200);
      expect(() => practiceAttemptSchema.parse(reply.json())).not.toThrow();
      expect(reply.json()).toMatchObject({ kind: 'speaking', inputMode: 'text', answer: reference.jp, usedHint: false, totalScore: null, result: { meaningScore: 40, grammarScore: 30, pronunciationScore: null } });
      expect(reply.json()).not.toHaveProperty('audioHash');
    });
    expect(aiFetch).toHaveBeenCalledTimes(2); expect(audioFetch).not.toHaveBeenCalled();
    const request = JSON.parse(aiFetch.mock.calls[1][1]!.body as string);
    expect(JSON.parse(request.messages[1].content)).toMatchObject({ goalZh: reference.zh, targetGrammar: { id: question.grammarId }, answer: reference.jp });
    expect((await submit('別の文です。')).statusCode).toBe(409);
    expect((await submitAudio(app, question.id, id)).statusCode).toBe(409);
    const mastery = (await app.inject('/api/ai-practice/mastery?lessonId=1')).json();
    expect(mastery.speaking).toMatchObject({ count: 1, accuracy: 1 });
    expect(mastery.pronunciation).toEqual({ count: 0, score: null });
    const backup = (await app.inject('/api/backup')).json();
    expect((await app.inject({ method: 'POST', url: '/api/restore', payload: { backup } })).statusCode).toBe(200);
    expect((await app.inject('/api/ai-practice/current?lessonId=1&kind=speaking')).json().attempt).toEqual(replies[0].json());
    expect((await app.inject('/api/ai-practice/mastery?lessonId=1')).json()).toEqual(mastery);
    await app.inject({ method: 'PATCH', url: '/api/speaking/audio-settings', payload: { apiKey: 'sk-text-audio-test-key' } });
    const audio = await submitAudio(app, question.id);
    expect(audio.statusCode, audio.body).toBe(200); expect(audio.json()).toMatchObject({ inputMode: 'audio', usedHint: true });
    expect((await app.inject('/api/ai-practice/mastery?lessonId=1')).json()).toEqual(mastery);
  });
  it('rejects invalid scores without saving an answer and permits the same submission to retry', async () => {
    const { app, aiFetch } = createPractice();
    await app.inject({ method: 'PATCH', url: '/api/settings', payload: { apiKey: fixtureKey } });
    const question = await generatePractice(app); const id = randomUUID();
    const submit = () => app.inject({ method: 'POST', url: `/api/ai-practice/questions/${question.id}/answer`, payload: { answer: reference.jp, clientAttemptId: id } });
    for (const result of [{ ...textResult(), grammarScore: 31 }, { ...textResult(), targetGrammarUsed: false }, { ...textResult(), pronunciationScore: 30 }]) {
      aiFetch.mockResolvedValueOnce(provider(result));
      expect((await submit()).statusCode).toBe(502);
      expect((await app.inject('/api/ai-practice/current?lessonId=1&kind=speaking')).json().attempt).toBeNull();
    }
    aiFetch.mockResolvedValueOnce(provider({ ...textResult(), targetGrammarUsed: false, grammarScore: 15 }));
    const reply = await submit(); expect(reply.statusCode, reply.body).toBe(200); expect(reply.json().usedHint).toBe(false);
    expect((await app.inject('/api/ai-practice/mastery?lessonId=1')).json().speaking).toMatchObject({ count: 1, accuracy: 0 });
  });
});
