import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve, basename } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../src/server/store';
import { retireRecordingArchives } from '../src/server/audio-retirement';
import { buildApp } from '../src/server/app';
import { wav, provider, fixtureKey } from './recordings-fixtures';
function clean(dir: string) {
  if (dirname(resolve(dir)) !== resolve(tmpdir()) || !basename(dir).startsWith('nihongo-retirement-')) throw new Error('Invalid test path');
  rmSync(dir, { recursive: true, force: true });
}
describe('audio without archives', () => {
  it('rejects every retired archive operation before processing audio or calling providers', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nihongo-retirement-'));
    let calls = 0;
    const app = buildApp({ dataDir: dir, aiFetch: async () => { calls++; throw new Error('Unexpected provider'); }, audioFetch: async () => { calls++; throw new Error('Unexpected provider'); } });
    try {
      const id = randomUUID();
      for (const method of ['GET', 'HEAD', 'POST', 'PATCH', 'DELETE'] as const) {
        for (const url of ['/api/recordings', `/api/recordings/${id}`, `/api/recordings/${id}/audio`]) {
          const response = await app.inject({ method, url, ...(method === 'POST' ? { payload: wav(), headers: { 'content-type': 'audio/wav' } } : {}) });
          expect(response.statusCode, `${method} ${url}: ${response.body}`).toBe(410);
        }
      }
      for (const url of ['/api/speaking/assess', '/api/speaking/assess-audio']) {
        expect((await app.inject({ method: 'POST', url, payload: {} })).statusCode).toBe(410);
      }
      expect(calls).toBe(0);
      expect(existsSync(join(dir, 'recordings'))).toBe(false);
      const backup = (await app.inject('/api/backup')).json();
      expect(backup.recordings).toEqual([]); expect(backup.assessments).toEqual([]);
    } finally { await app.close(); clean(dir); }
  });
  it('removes owned recordings and links, retains text and unrelated files, and is repeatable', () => {
    const dir = mkdtempSync(join(tmpdir(), 'nihongo-retirement-')); const store = new Store(dir);
    try {
      mkdirSync(join(dir, 'recordings')); const id = randomUUID();
      writeFileSync(join(dir, 'recordings', id + '.wav'), wav());
      writeFileSync(join(dir, 'recordings', 'keep.txt'), 'unrelated');
      store.save('attempts', id, { id, recordingId: id, answer: 'こんにちは。' });
      retireRecordingArchives(store, dir); retireRecordingArchives(store, dir);
      expect(existsSync(join(dir, 'recordings', id + '.wav'))).toBe(false);
      expect(existsSync(join(dir, 'recordings', 'keep.txt'))).toBe(true);
      expect(store.get('attempts', id)).toEqual({ id, answer: 'こんにちは。' });
      expect(store.backup().version).toBe(4);
    } finally { store.close(); clean(dir); }
  });
  it('scores raw audio once, persists feedback without audio, and restores a v4 backup', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nihongo-retirement-'));
    const reference = { jp: '私は学生です。', kana: 'わたしはがくせいです。', zh: '我是学生。' };
    let calls = 0;
    const app = buildApp({ dataDir: dir, practiceRandom: () => 0,
      aiFetch: async () => provider({ kind: 'speaking', goalZh: reference.zh, reference }),
      audioFetch: async () => { calls++; return provider({ text: reference.jp, summaryZh: '清楚', grammarFeedbackZh: '正确', corrections: [], pronunciation: { status: 'clear', feedbackZh: '清楚', issues: [] }, reference, meaningScore: 40, grammarScore: 30, pronunciationScore: 28, targetGrammarUsed: true }); } });
    try {
      await app.inject({ method: 'PATCH', url: '/api/settings', payload: { apiKey: fixtureKey } });
      await app.inject({ method: 'PATCH', url: '/api/speaking/audio-settings', payload: { apiKey: fixtureKey } });
      const generated = await app.inject({ method: 'POST', url: '/api/ai-practice/questions', payload: { lessonId: 1, kind: 'speaking', clientRequestId: randomUUID() } });
      expect(generated.statusCode, generated.body).toBe(200);
      const id = generated.json().question.id; const attemptId = randomUUID();
      const submit = () => app.inject({ method: 'POST', url: `/api/ai-practice/questions/${id}/assess-audio?clientAssessmentId=${attemptId}`, headers: { 'content-type': 'audio/wav' }, payload: wav() });
      const assessed = await submit(); expect(assessed.statusCode, assessed.body).toBe(200);
      expect(assessed.json().recordingId).toBeUndefined(); expect(assessed.json().totalScore).toBe(98);
      expect((await submit()).json()).toEqual(assessed.json()); expect(calls).toBe(1);
      expect(existsSync(join(dir, 'recordings'))).toBe(false);
      expect((await app.inject('/api/recordings')).statusCode).toBe(410);
      const backup = (await app.inject('/api/backup')).json(); expect(backup.version).toBe(4);
      const restored = await app.inject({ method: 'POST', url: '/api/restore', payload: { backup } });
      expect(restored.statusCode, restored.body).toBe(200);
    } finally { await app.close(); clean(dir); }
  });
});
