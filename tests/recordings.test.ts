import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import Database from 'better-sqlite3';
import { buildApp, type AppOptions } from '../src/server/app';
import { deploymentConfig } from '../src/server/deployment';
import { registerSpeechRoutes } from '../src/server/speech';
import { getLesson } from '../src/content';
import type { Recording } from '../src/shared/recordings';
import { fixtureKey, lesson, provider, saved, task, upload, wav } from './recordings-fixtures';

const apps: ReturnType<typeof buildApp>[] = [];
const dirs: string[] = [];
function create(options: AppOptions = {}) {
  const dataDir = options.dataDir ?? mkdtempSync(join(tmpdir(), 'nihongo-recordings-test-'));
  if (!dirs.includes(dataDir)) dirs.push(dataDir);
  const app = buildApp({ ...options, dataDir }); apps.push(app);
  return { app, dataDir };
}
async function restart(previous: ReturnType<typeof create>, options: AppOptions = {}) {
  await previous.app.close(); apps.splice(apps.indexOf(previous.app), 1);
  return create({ ...options, dataDir: previous.dataDir });
}
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) {
    if (!resolve(dir).startsWith(resolve(tmpdir(), 'nihongo-recordings-test-'))) throw new Error('Unexpected fixture directory');
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('recordings: persistence, privacy and playback', () => {
  it('persists actual WAV duration, transcript and confirmed text across restarts, independently of recognition', async () => {
    const first = create(); const bytes = wav(.75); const id = randomUUID();
    const response = await upload(first.app, { clientRecordingId: id }, bytes); expect(response.statusCode).toBe(200);
    const record = response.json<Recording>();
    expect(record).toMatchObject({ id, durationMs: 750, lessonId: 1, itemId: task.id, audioAvailable: true, audioStatus: 'available' });
    expect(Date.parse(record.expiresAt) - Date.parse(record.createdAt)).toBe(90 * 86400000);
    expect(readFileSync(join(first.dataDir, 'recordings', `${id}.wav`))).toEqual(bytes);
    const updated = await first.app.inject({ method: 'PATCH', url: `/api/recordings/${id}`, payload: { transcript: '会社員てす', confirmedText: '会社員です。' } });
    expect(updated.statusCode).toBe(200);
    const second = await restart(first);
    expect((await second.app.inject('/api/recordings?lessonId=1')).json()).toEqual([updated.json()]);
    expect((await second.app.inject(`/api/recordings/${id}/audio`)).rawPayload).toEqual(bytes);
    expect((await second.app.inject('/api/recordings?lessonId=2')).json()).toEqual([]);
  });
  it('deduplicates concurrent saves and disallows changing bytes or ownership under the same ID', async () => {
    const { app } = create(); const clientRecordingId = randomUUID();
    const responses = await Promise.all([upload(app, { clientRecordingId }), upload(app, { clientRecordingId })]);
    expect(responses.map(response => response.statusCode)).toEqual([200, 200]);
    expect(responses[0]!.json()).toEqual(responses[1]!.json());
    expect((await upload(app, { clientRecordingId: clientRecordingId.toUpperCase() })).json()).toEqual(responses[0]!.json());
    expect((await upload(app, { clientRecordingId }, wav(.5, 3000))).json().code).toBe('IDEMPOTENCY_CONFLICT');
    expect((await upload(app, { clientRecordingId, itemId: lesson.speaking[1]!.id })).statusCode).toBe(409);
    expect((await app.inject('/api/recordings?lessonId=1')).json()).toHaveLength(1);
  });
  it('lets the exact same ID retry after a failed disk save without adding phantom metadata', async () => {
    const { app, dataDir } = create(); const clientRecordingId = randomUUID();
    const blocked = join(dataDir, 'recordings', `${clientRecordingId}.wav`); mkdirSync(blocked);
    const failed = await upload(app, { clientRecordingId });
    expect(failed.statusCode).toBe(503); expect(failed.json().code).toBe('RECORDING_SAVE_FAILED');
    expect((await app.inject('/api/recordings?lessonId=1')).json()).toEqual([]);
    expect(resolve(blocked).startsWith(resolve(dataDir) + sep)).toBe(true);
    rmdirSync(blocked); // Empty fixture directory, never a recursive removal.
    expect((await upload(app, { clientRecordingId })).statusCode).toBe(200);
  });
  it('rejects invalid, silent, oversized, wrong-rate and duplicate-data audio before persistence', async () => {
    const { app } = create(); const otherRate = wav(); otherRate.writeUInt32LE(48000, 24);
    const wrongByteRate = wav(); wrongByteRate.writeUInt32LE(96000, 28);
    const chunk = wav().subarray(36); const multipleData = Buffer.concat([wav(), chunk]); multipleData.writeUInt32LE(multipleData.length - 8, 4);
    for (const bytes of [Buffer.from('bad'), wav(.1), wav(.5, 0), wav(30.01), otherRate, wrongByteRate, multipleData]) {
      const response = await upload(app, {}, bytes); expect(response.statusCode).toBe(400); expect(response.json().code).toBe('INVALID_AUDIO');
    }
    expect((await upload(app, {}, Buffer.alloc(1100001))).statusCode).toBe(413);
    expect((await upload(app, {}, wav(30))).statusCode).toBe(200);
    expect((await app.inject('/api/recordings?lessonId=1')).json()).toHaveLength(1);
  });
  it('validates the lesson/task/session and never accepts user-supplied file paths or retention dates', async () => {
    const { app } = create();
    for (const overrides of [{ itemId: lesson.grammar[0]!.id }, { lessonId: 2, itemId: task.id }, { context: 'conversation' as const, itemId: randomUUID() }, { clientRecordingId: '../outside' }]) expect((await upload(app, overrides)).statusCode).toBe(400);
    const record = await saved(app);
    for (const payload of [{ audioAvailable: true }, { expiresAt: new Date().toISOString() }, { path: '../outside.wav' }, {}]) expect((await app.inject({ method: 'PATCH', url: `/api/recordings/${record.id}`, payload })).statusCode).toBe(400);
    expect((await app.inject('/api/recordings?lessonId=51')).statusCode).toBe(400);
  });
  it('supports seek ranges and HEAD, rejecting invalid ranges without leaking full audio', async () => {
    const { app } = create(); const record = await saved(app); const bytes = wav(); const url = `/api/recordings/${record.id}/audio`;
    const full = await app.inject(url); expect(full.statusCode).toBe(200); expect(full.rawPayload).toEqual(bytes);
    expect(full.headers).toMatchObject({ 'content-type': 'audio/wav', 'cache-control': 'private, no-store', 'accept-ranges': 'bytes', 'x-content-type-options': 'nosniff' });
    for (const [range, start, end] of [['bytes=0-43', 0, 43], ['bytes=44-', 44, bytes.length - 1], ['bytes=-20', bytes.length - 20, bytes.length - 1], ['bytes=44-999999', 44, bytes.length - 1]] as const) {
      const response = await app.inject({ url, headers: { range } }); expect(response.statusCode).toBe(206);
      expect(response.rawPayload).toEqual(bytes.subarray(start, end + 1)); expect(response.headers['content-range']).toBe(`bytes ${start}-${end}/${bytes.length}`);
    }
    for (const range of ['bytes=999999-', 'bytes=44-10', 'bytes=-0', 'bytes=-', 'bytes=0-1,3-4', 'items=0-43', 'bytes=999999999999999999-']) {
      const response = await app.inject({ url, headers: { range } }); expect(response.statusCode).toBe(416); expect(response.rawPayload.length).toBe(0);
    }
    const head = await app.inject({ method: 'HEAD', url }); expect(head.statusCode).toBe(200); expect(head.rawPayload.length).toBe(0); expect(head.headers['content-length']).toBe(String(bytes.length));
  });
  it('guards uploaded files, Range and HEAD with the same web proxy and Origin checks as the app', async () => {
    const origin = 'https://study.example.com'; const token = 'recordings-private-test-proxy-token-123456';
    const { app } = create({ deployment: deploymentConfig({ DEPLOYMENT: 'web', APP_PUBLIC_ORIGIN: origin, APP_PROXY_TOKEN: token }) });
    const headers = { host: 'study.example.com', origin, 'x-nihongo-proxy': token };
    expect((await upload(app)).statusCode).toBe(403);
    expect((await upload(app, {}, wav(), { ...headers, origin: 'https://other.example.com' })).statusCode).toBe(403);
    const response = await upload(app, {}, wav(), headers); expect(response.statusCode).toBe(200); const record = response.json<Recording>();
    for (const method of ['GET', 'HEAD'] as const) {
      const url = `/api/recordings/${record.id}/audio`;
      expect((await app.inject({ method, url, headers: { host: headers.host, range: 'bytes=0-43' } })).statusCode).toBe(403);
      expect((await app.inject({ method, url, headers: { ...headers, origin: 'null' } })).statusCode).toBe(403);
      expect((await app.inject({ method, url, headers: { ...headers, range: 'bytes=0-43' } })).statusCode).toBe(206);
    }
  });
  it('retains text after delete and expires audio after 90 days without resurrecting retry uploads', async () => {
    const { app, dataDir } = create(); const record = await saved(app);
    await app.inject({ method: 'PATCH', url: `/api/recordings/${record.id}`, payload: { transcript: 'はい。', confirmedText: 'はい。' } });
    const removed = await app.inject({ method: 'DELETE', url: `/api/recordings/${record.id}` });
    expect(removed.json()).toMatchObject({ id: record.id, transcript: 'はい。', confirmedText: 'はい。', audioStatus: 'deleted', audioAvailable: false });
    expect(existsSync(join(dataDir, 'recordings', `${record.id}.wav`))).toBe(false);
    expect((await upload(app, { clientRecordingId: record.id })).json().audioAvailable).toBe(false);
    expect((await app.inject(`/api/recordings/${record.id}/audio`)).statusCode).toBe(410);
    const expiring = await saved(app); vi.spyOn(Date, 'now').mockReturnValue(Date.parse(expiring.expiresAt));
    const records = (await app.inject('/api/recordings?lessonId=1')).json<Recording[]>();
    expect(records.find(item => item.id === expiring.id)).toMatchObject({ audioAvailable: false, audioStatus: 'expired', expiresAt: expiring.expiresAt });
    expect(existsSync(join(dataDir, 'recordings', `${expiring.id}.wav`))).toBe(false);
    expect((await app.inject(`/api/recordings/${expiring.id}/audio`)).statusCode).toBe(410);
    expect((await app.inject('/api/backup')).json().recordings).toHaveLength(2);
  });
  it('retains the existing WAV transcription endpoint and clearly reports an absent model', async () => {
    const { app, dataDir } = create(); registerSpeechRoutes(app, dataDir);
    const response = await app.inject({ method: 'POST', url: '/api/speech/transcribe', headers: { 'content-type': 'audio/wav' }, payload: wav() });
    expect(response.statusCode).toBe(503); expect(response.json().code).toBe('SPEECH_NOT_INSTALLED');
    expect((await upload(app)).statusCode).toBe(200);
  });
});

describe('recordings: associations and metadata backups', () => {
  it('confirms text when saving an attempt and rejects cross-task recordings', async () => {
    const { app } = create(); const record = await saved(app);
    const payload = { lessonId: 1, itemId: task.id, result: 'hint', usedHint: true, answer: '会社員です。', recordingId: record.id };
    const response = await app.inject({ method: 'POST', url: '/api/attempts', payload }); expect(response.statusCode).toBe(200);
    expect((await app.inject('/api/recordings?lessonId=1')).json()[0].confirmedText).toBe(payload.answer);
    expect((await app.inject({ method: 'POST', url: '/api/attempts', payload: { ...payload, itemId: lesson.speaking[1]!.id } })).json().code).toBe('RECORDING_MISMATCH');
    expect((await app.inject('/api/backup')).json().attempts).toHaveLength(1);
  });
  it('associates conversation recordings with the exact session and confirms only successfully sent turns', async () => {
    const response = { replyJa: 'そうですか。お仕事は何ですか？', replyZh: '原来如此，你做什么工作？', hintZh: '说职业。', completedGoals: [], corrections: [], endSession: false };
    const aiFetch = vi.fn<typeof fetch>().mockImplementation(async () => provider(response)); const { app } = create({ aiFetch });
    const session = (await app.inject({ method: 'POST', url: '/api/sessions', payload: { lessonId: 1, scenarioId: lesson.scenarios[0]!.id } })).json();
    const record = await saved(app, { context: 'conversation', itemId: session.id });
    const payload = { text: '会社員です。', recordingId: record.id, clientTurnId: 'conversation-recording-test' }; const url = `/api/sessions/${session.id}/turn`;
    expect((await app.inject({ method: 'POST', url, payload })).statusCode).toBe(503);
    expect((await app.inject('/api/recordings?lessonId=1')).json()[0].confirmedText).toBeUndefined();
    await app.inject({ method: 'PATCH', url: '/api/settings', payload: { apiKey: fixtureKey } });
    const wrong = await saved(app);
    expect((await app.inject({ method: 'POST', url, payload: { ...payload, recordingId: wrong.id } })).statusCode).toBe(400);
    expect(aiFetch).not.toHaveBeenCalled();
    const sent = await app.inject({ method: 'POST', url, payload }); expect(sent.statusCode).toBe(200); expect(sent.json().turns[1].recordingId).toBe(record.id);
    expect((await app.inject('/api/recordings?lessonId=1')).json<Recording[]>().find(item => item.id === record.id)?.confirmedText).toBe(payload.text);
    expect((await app.inject({ method: 'POST', url, payload })).statusCode).toBe(200); expect(aiFetch).toHaveBeenCalledTimes(1);
    expect((await app.inject({ method: 'POST', url, payload: { ...payload, recordingId: undefined } })).statusCode).toBe(409);
    const backup = (await app.inject('/api/backup')).json(); expect((await app.inject({ method: 'POST', url: '/api/restore', payload: { backup } })).statusCode).toBe(200);
    expect((await app.inject(`/api/sessions/${session.id}`)).json().turns[1].recordingId).toBe(record.id);
  });
  it('preserves matching trusted local audio during a v2 roundtrip, including retry identity', async () => {
    const { app, dataDir } = create(); const record = await saved(app);
    const backup = (await app.inject('/api/backup')).json();
    expect((await app.inject({ method: 'POST', url: '/api/restore', payload: { backup } })).statusCode).toBe(200);
    expect((await app.inject('/api/recordings?lessonId=1')).json()[0]).toMatchObject({ id: record.id, audioAvailable: true, expiresAt: record.expiresAt });
    expect(readFileSync(join(dataDir, 'recordings', `${record.id}.wav`))).toEqual(wav());
    expect((await upload(app, { clientRecordingId: record.id })).statusCode).toBe(200);
  });
  it('exports metadata only and restores foreign audio as missing without extending expiry or adopting orphan files', async () => {
    const { app, dataDir } = create(); const record = await saved(app);
    await app.inject({ method: 'PATCH', url: '/api/recordings/' + record.id, payload: { transcript: 'はい。' } });
    const backup = (await app.inject('/api/backup')).json(); expect(backup.version).toBe(2); expect(backup.recordings).toHaveLength(1);
    expect(JSON.stringify(backup)).not.toContain(dataDir); expect(JSON.stringify(backup)).not.toContain('sha256'); expect(JSON.stringify(backup)).not.toContain('base64');
    const other = create();
    // A filename matching an imported UUID is insufficient: this database never owned it.
    const fs = await import('node:fs'); fs.writeFileSync(join(other.dataDir, 'recordings', `${record.id}.wav`), wav());
    expect((await other.app.inject({ method: 'POST', url: '/api/restore', payload: { backup } })).statusCode).toBe(200);
    const restored = (await other.app.inject('/api/recordings?lessonId=1')).json()[0];
    expect(restored).toMatchObject({ id: record.id, transcript: 'はい。', expiresAt: record.expiresAt, audioAvailable: false, audioStatus: 'missing' });
    expect(existsSync(join(other.dataDir, 'recordings', `${record.id}.wav`))).toBe(false);
    expect((await other.app.inject(`/api/recordings/${record.id}/audio`)).statusCode).toBe(410);
    expect((await upload(other.app, { clientRecordingId: record.id })).statusCode).toBe(409);
  });
  it('validates recording references and retention before replacing any existing records', async () => {
    const { app } = create(); await saved(app); const original = (await app.inject('/api/backup')).json();
    for (const mutate of [
      (backup: typeof original) => { backup.recordings[0].path = '../outside.wav'; },
      (backup: typeof original) => { backup.recordings[0].itemId = getLesson(2)!.speaking[0]!.id; },
      (backup: typeof original) => { backup.recordings[0].expiresAt = new Date(Date.parse(backup.recordings[0].expiresAt) + 86400000).toISOString(); },
      (backup: typeof original) => { backup.recordings.push(structuredClone(backup.recordings[0])); },
      (backup: typeof original) => { backup.attempts.push({ id: randomUUID(), lessonId: 1, itemId: task.id, result: 'hint', createdAt: new Date().toISOString(), recordingId: randomUUID() }); },
    ]) {
      const backup = structuredClone(original); mutate(backup);
      expect((await app.inject({ method: 'POST', url: '/api/restore', payload: { backup } })).statusCode).toBe(400);
      expect((await app.inject('/api/recordings?lessonId=1')).json()[0].audioAvailable).toBe(true);
    }
  });
  it('restores legacy v1 files, removing unreferenced audio and preserving keys and the restored autoplay preference', async () => {
    const first = create(); await saved(first.app); await first.app.inject({ method: 'PATCH', url: '/api/settings', payload: { apiKey: fixtureKey } });
    const { recordings, assessments: _, ...legacy } = (await first.app.inject('/api/backup')).json(); legacy.version = 1; legacy.settings.autoplay = false;
    expect((await first.app.inject({ method: 'POST', url: '/api/restore', payload: { backup: legacy } })).statusCode).toBe(200);
    expect(existsSync(join(first.dataDir, 'recordings', `${recordings[0].id}.wav`))).toBe(false);
    const second = await restart(first);
    expect((await second.app.inject('/api/settings')).json()).toMatchObject({ autoplay: false, hasApiKey: true });
    expect((await second.app.inject('/api/recordings?lessonId=1')).json()).toEqual([]);
  });
  it('enables autoplay once for old stores, then preserves the user switch through restarts', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'nihongo-recordings-test-')); dirs.push(dataDir);
    const db = new Database(join(dataDir, 'nihongo.sqlite')); db.exec('CREATE TABLE settings (id INTEGER PRIMARY KEY, value TEXT NOT NULL)');
    db.prepare('INSERT INTO settings (id, value) VALUES (1, ?)').run(JSON.stringify({ autoplay: false, currentLessonId: 27 })); db.close();
    const first = create({ dataDir }); expect((await first.app.inject('/api/settings')).json()).toMatchObject({ autoplay: true, currentLessonId: 27 });
    await first.app.inject({ method: 'PATCH', url: '/api/settings', payload: { autoplay: false } });
    const second = await restart(first); expect((await second.app.inject('/api/settings')).json().autoplay).toBe(false);
  });
});
