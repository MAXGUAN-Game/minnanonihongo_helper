import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { deploymentConfig } from '../src/server/deployment';
import { closePractice, configurePractice, createPractice } from './practice-fixtures';
import { legacyBackup } from './legacy-backup-fixtures';
import { task, wav } from './recordings-fixtures';

describe('retired recordings and legacy migration', () => {
  it.each([1, 2, 3] as const)('imports v%i text and progress without reviving any waveform', async version => {
    const first = createPractice(); await configurePractice(first.app); const backup = await legacyBackup(first.app, version);
    const archiveDir = join(first.dataDir, 'recordings'); mkdirSync(archiveDir);
    const audioPath = join(archiveDir, `${backup.recordings?.[0]?.id ?? randomUUID()}.wav`); writeFileSync(audioPath, wav());
    const tmp = join(first.dataDir, 'speech', 'tmp'); mkdirSync(tmp, { recursive: true }); writeFileSync(join(tmp, 'utterance-old.wav'), wav());
    const restored = await first.app.inject({ method: 'POST', url: '/api/restore', payload: { backup } }); expect(restored.statusCode, restored.body).toBe(200);
    expect(existsSync(audioPath)).toBe(false); expect(existsSync(join(tmp, 'utterance-old.wav'))).toBe(false);
    const current = (await first.app.inject('/api/backup')).json();
    expect(current.version).toBe(4); expect(current.recordings).toEqual([]);
    expect(current.attempts[0]).toMatchObject({ answer: '会社員です。', result: 'good' }); expect(current.progress).toEqual(backup.progress);
    expect(JSON.stringify(current)).not.toContain('recordingId'); expect(JSON.stringify(current)).not.toContain('base64');
    expect((await first.app.inject({ method: 'POST', url: '/api/restore', payload: { backup: current } })).statusCode).toBe(200);
    await closePractice(first.app); const second = createPractice({ dataDir: first.dataDir });
    expect((await second.app.inject('/api/settings')).json()).toMatchObject({ autoplay: false, hasApiKey: true });
    expect((await second.app.inject('/api/speaking/audio-settings')).json().hasApiKey).toBe(true);
    expect((await second.app.inject('/api/recordings')).statusCode).toBe(410);
    expect((await second.app.inject('/api/backup')).json().attempts).toEqual(current.attempts);
  });
  it('rejects archive references from old clients without creating attempts', async () => {
    const { app } = createPractice();
    const result = await app.inject({ method: 'POST', url: '/api/attempts', payload: { lessonId: 1, itemId: task.id, result: 'good', recordingId: randomUUID() } });
    expect(result.statusCode).toBe(410); expect((await app.inject('/api/backup')).json().attempts).toEqual([]);
  });
  it('validates old archive associations before replacing existing text', async () => {
    const { app } = createPractice(); const original = await legacyBackup(app, 3);
    expect((await app.inject({ method: 'POST', url: '/api/restore', payload: { backup: original } })).statusCode).toBe(200);
    for (const mutate of [
      (b: typeof original) => { b.recordings[0].path = '../outside.wav'; },
      (b: typeof original) => { b.recordings[0].expiresAt = b.recordings[0].createdAt; },
      (b: typeof original) => { b.recordings.push(structuredClone(b.recordings[0])); },
      (b: typeof original) => { b.attempts[0].recordingId = randomUUID(); },
    ]) {
      const backup = structuredClone(original); mutate(backup);
      expect((await app.inject({ method: 'POST', url: '/api/restore', payload: { backup } })).statusCode).toBe(400);
      expect((await app.inject('/api/backup')).json().attempts[0].answer).toBe('会社員です。');
    }
  });
  it('requires authentication for retired archive URLs before disclosing their status', async () => {
    const token = 'retired-private-test-token-1234567890';
    const { app } = createPractice({ deployment: deploymentConfig({ DEPLOYMENT: 'web', APP_PUBLIC_ORIGIN: 'https://study.example.com', APP_PROXY_TOKEN: token }) });
    for (const method of ['GET', 'HEAD', 'POST', 'DELETE'] as const) {
      expect((await app.inject({ method, url: '/api/recordings', headers: { host: 'study.example.com' } })).statusCode).toBe(403);
      expect((await app.inject({ method, url: '/api/recordings', headers: { host: 'study.example.com', 'x-nihongo-proxy': token, origin: 'https://study.example.com' } })).statusCode).toBe(401);
    }
  });
  it('keeps the previously chosen autoplay setting when the application restarts', async () => {
    const first = createPractice();
    await first.app.inject({ method: 'PATCH', url: '/api/settings', payload: { autoplay: false } });
    await closePractice(first.app); const second = createPractice({ dataDir: first.dataDir });
    expect((await second.app.inject('/api/settings')).json().autoplay).toBe(false);
    await closePractice(second.app);
    const db = new Database(join(first.dataDir, 'nihongo.sqlite'));
    expect(db.prepare('SELECT COUNT(*) AS n FROM recordings').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM recording_files').get()).toEqual({ n: 0 }); db.close();
  });
});
