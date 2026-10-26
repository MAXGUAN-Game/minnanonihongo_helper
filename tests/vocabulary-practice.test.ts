import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve, basename } from 'node:path';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../src/server/app';
import { provider, fixtureKey, wav } from './recordings-fixtures';
import { getLesson } from '../src/content';
describe('vocabulary practice', () => {
  it('cycles through the lesson without generation calls, grades text and audio, and backs up', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nihongo-vocab-test-'));
    let calls = 0;
    const app = buildApp({ dataDir: dir, aiFetch: async () => { calls++; return provider({ correct: true, feedbackZh: '正确。', reference: { jp: '私は学生です。', kana: 'わたしはがくせいです。', zh: '我是学生。' } }); }, audioFetch: async () => provider({ readable: true, text: '私は学生です。' }) });
    try {
      await app.inject({ method: 'PATCH', url: '/api/settings', payload: { apiKey: fixtureKey } });
      await app.inject({ method: 'PATCH', url: '/api/speaking/audio-settings', payload: { apiKey: fixtureKey } });
      const words = (await app.inject('/api/lessons/1/vocabulary')).json().words;
      const ids = [];
      let question;
      for (let i = 0; i < words.length; i++) {
        const response = await app.inject({ method: 'POST', url: '/api/ai-practice/questions', payload: { lessonId: 1, kind: 'vocabulary', clientRequestId: randomUUID() } });
        expect(response.statusCode, response.body).toBe(200); question = response.json().question; ids.push(question.content.wordId);
      }
      expect(new Set(ids).size).toBe(words.length); expect(calls).toBe(0);
      const text = await app.inject({ method: 'POST', url: `/api/ai-practice/questions/${question.id}/answer`, payload: { answer: '私は学生です。', clientAttemptId: randomUUID() } });
      expect(text.statusCode, text.body).toBe(200); expect(text.json().correct).toBe(true);
      const audio = await app.inject({ method: 'POST', url: `/api/ai-practice/questions/${question.id}/assess-audio?clientAssessmentId=${randomUUID()}`, payload: wav(), headers: { 'content-type': 'audio/wav' } });
      expect(audio.statusCode, audio.body).toBe(200); expect(audio.json().usedHint).toBe(true); expect(audio.json().inputMode).toBe('audio');
      const backup = (await app.inject('/api/backup')).json();
      const oldIndex = getLesson(1)!.vocabulary.findIndex((_, i) => !words.some((w: { id: string }) => w.id === `l1-v${i + 1}`));
      expect(oldIndex).toBeGreaterThanOrEqual(0);
      backup.attempts.push({ id: randomUUID(), lessonId: 1, itemId: `l1-v${oldIndex + 1}`, result: 'good', answer: '以前的单词练习', createdAt: new Date().toISOString() });
      const restored = await app.inject({ method: 'POST', url: '/api/restore', payload: { backup } });
      expect(restored.statusCode, restored.body).toBe(200);
      expect((await app.inject('/api/backup')).json().attempts).toEqual(backup.attempts);
    } finally {
      await app.close();
      if (dirname(resolve(dir)) !== resolve(tmpdir()) || !basename(dir).startsWith('nihongo-vocab-test-')) throw new Error('Invalid cleanup path');
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
