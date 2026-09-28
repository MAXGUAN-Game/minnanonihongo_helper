import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { buildApp, type AppOptions } from '../src/server/app';
import { deploymentConfig } from '../src/server/deployment';
import { getLesson } from '../src/content';
import type { Recording, SpeakingAssessment } from '../src/shared/recordings';
import { assessmentResult, fixtureKey, lesson, provider, saved, task } from './recordings-fixtures';

const apps: ReturnType<typeof buildApp>[] = []; const dirs: string[] = [];
function create(options: AppOptions = {}) {
  const dataDir = options.dataDir ?? mkdtempSync(join(tmpdir(), 'nihongo-assessment-test-'));
  if (!dirs.includes(dataDir)) dirs.push(dataDir);
  const app = buildApp({ ...options, dataDir }); apps.push(app); return { app, dataDir };
}
function request(app: ReturnType<typeof buildApp>, changes: Record<string, unknown> = {}) {
  return app.inject({ method: 'POST', url: '/api/speaking/assess', payload: { lessonId: 1, itemId: task.id, text: '会社員です。', clientAssessmentId: randomUUID(), ...changes } });
}
function configure(app: ReturnType<typeof buildApp>) { return app.inject({ method: 'PATCH', url: '/api/settings', payload: { apiKey: fixtureKey } }); }
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close(); vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) {
    if (!resolve(dir).startsWith(resolve(tmpdir(), 'nihongo-assessment-test-'))) throw new Error('Unexpected assessment test directory');
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('speaking assessment: honest text-only provider boundary', () => {
  it('requires configuration and never fabricates scores when the provider is absent', async () => {
    const aiFetch = vi.fn<typeof fetch>(); const { app } = create({ aiFetch });
    const response = await request(app); expect(response.statusCode).toBe(503); expect(response.json().code).toBe('AI_NOT_CONFIGURED'); expect(aiFetch).not.toHaveBeenCalled();
    expect((await app.inject('/api/backup')).json().assessments).toEqual([]);
  });
  it('sends only confirmed text and the current exercise to the official provider, accepting natural alternatives without changing mastery', async () => {
    const aiFetch = vi.fn<typeof fetch>().mockImplementation(async () => provider()); const { app } = create({ aiFetch }); await configure(app);
    const record = await saved(app); const text = '私は医者です。';
    await app.inject({ method: 'PATCH', url: `/api/recordings/${record.id}`, payload: { transcript: '私は医者てす' } });
    const response = await request(app, { text, recordingId: record.id }); expect(response.statusCode).toBe(200);
    const result = response.json<SpeakingAssessment>();
    expect(result).toMatchObject({ lessonId: 1, itemId: task.id, text, recordingId: record.id, totalScore: 95, taskScore: 48, grammarScore: 29, vocabularyScore: 18, source: 'deepseek', kind: 'expression', corrections: [], reference: task.answer });
    const [url, init] = aiFetch.mock.calls[0]!; expect(url).toBe('https://api.deepseek.com/chat/completions');
    expect(init!.headers).toMatchObject({ Authorization: `Bearer ${fixtureKey}` }); const body = JSON.parse(init!.body as string);
    expect(body).toMatchObject({ model: 'deepseek-flash', thinking: { type: 'disabled' }, response_format: { type: 'json_object' } });
    expect(body.messages.at(-1)).toEqual({ role: 'user', content: text });
    expect(body.messages[0].content).toContain('没有听到录音'); expect(body.messages[0].content).toContain('不是唯一正确答案'); expect(body.messages[0].content).toContain(task.goal);
    for (const forbidden of [fixtureKey, record.id, '私は医者てす', getLesson(50)!.title]) expect(JSON.stringify(body)).not.toContain(forbidden);
    expect(response.body).not.toContain('pronunciation');
    const recording = (await app.inject('/api/recordings?lessonId=1')).json<Recording[]>()[0]!;
    expect(recording).toMatchObject({ transcript: '私は医者てす', confirmedText: text, assessment: result });
    const bootstrap = (await app.inject('/api/bootstrap')).json(); expect(bootstrap.progress).toEqual([]); expect(bootstrap.totals.independent).toBe(0);
    const backup = (await app.inject('/api/backup')).json(); expect(backup.attempts).toEqual([]); expect(backup.assessments).toEqual([result]);
  });
  it.each([
    ['out-of-range score', () => assessmentResult({ taskScore: 51 })],
    ['non-integer score', () => assessmentResult({ grammarScore: 22.5 })],
    ['omitted dimension', () => { const { vocabularyScore: _, ...partial } = assessmentResult(); return partial; }],
    ['made-up pronunciation score', () => assessmentResult({ pronunciationScore: 99 })],
    ['too many corrections', () => assessmentResult({ corrections: [{}, {}, {}] })],
    ['unquoted correction', () => assessmentResult({ corrections: [{ goal: '说职业', original: '不存在的句子', corrected: task.answer, explanation: '加上です。' }] })],
    ['foreign grammar', () => assessmentResult({ corrections: [{ goal: '说职业', original: '会社員', corrected: task.answer, explanation: '练一下。', grammarId: getLesson(50)!.grammar[0]!.id }] })],
    ['empty result', () => ''], ['invalid JSON', () => '{"taskScore":'],
  ])('rejects %s after one format retry and preserves the original recording', async (_name, makeResult) => {
    const aiFetch = vi.fn<typeof fetch>().mockImplementation(async () => provider(makeResult())); const { app } = create({ aiFetch }); await configure(app); const record = await saved(app);
    const response = await request(app, { recordingId: record.id }); expect(response.statusCode).toBe(502); expect(response.json().code).toBe('AI_INVALID_RESPONSE'); expect(aiFetch).toHaveBeenCalledTimes(2);
    const backup = (await app.inject('/api/backup')).json(); expect(backup.assessments).toEqual([]); expect(backup.recordings[0].confirmedText).toBeUndefined(); expect(backup.recordings[0].audioAvailable).toBe(true);
  });
  it('recovers from a malformed reply once and saves only the validated assessment', async () => {
    const aiFetch = vi.fn<typeof fetch>().mockResolvedValueOnce(provider('incomplete')).mockResolvedValueOnce(provider('```json\n' + JSON.stringify(assessmentResult()) + '\n```'));
    const { app } = create({ aiFetch }); await configure(app);
    const response = await request(app); expect(response.statusCode).toBe(200); expect(aiFetch).toHaveBeenCalledTimes(2);
    expect((await app.inject('/api/backup')).json().assessments).toHaveLength(1);
  });
  it.each([
    ['network', () => Promise.reject(new Error(fixtureKey)), 'AI_UNAVAILABLE'],
    ['key rejection', async () => new Response(fixtureKey, { status: 401 }), 'AI_AUTH_FAILED'],
    ['rate limiting', async () => new Response(fixtureKey, { status: 429 }), 'AI_BUSY'],
    ['provider error', async () => new Response(fixtureKey, { status: 500 }), 'AI_UNAVAILABLE'],
    ['direct secret echo', async () => provider(assessmentResult({ summaryZh: fixtureKey })), 'AI_INVALID_RESPONSE'],
    ['escaped secret echo', async () => provider(JSON.stringify(assessmentResult({ summaryZh: fixtureKey })).replace('sk-', '\\u0073k-')), 'AI_INVALID_RESPONSE'],
  ])('keeps a safe, retryable response for %s without persisting partial scores', async (_name, reply, code) => {
    const aiFetch = vi.fn<typeof fetch>().mockImplementation(reply); const { app } = create({ aiFetch }); await configure(app);
    const response = await request(app); expect(response.statusCode).toBeGreaterThanOrEqual(500); expect(response.json().code).toBe(code); expect(response.body).not.toContain(fixtureKey); expect(aiFetch).toHaveBeenCalledTimes(1);
    expect((await app.inject('/api/backup')).json().assessments).toEqual([]);
  });
  it('blocks untrusted origins before a paid operation or any score write', async () => {
    const origin = 'https://study.example.com'; const token = 'assessment-private-test-token-1234567890';
    const aiFetch = vi.fn<typeof fetch>(); const { app } = create({ aiFetch, deployment: deploymentConfig({ DEPLOYMENT: 'web', APP_PUBLIC_ORIGIN: origin, APP_PROXY_TOKEN: token }) });
    const response = await app.inject({ method: 'POST', url: '/api/speaking/assess', headers: { host: 'study.example.com', origin: 'https://attacker.example.com', 'x-nihongo-proxy': token }, payload: { lessonId: 1, itemId: task.id, text: 'はい。', clientAssessmentId: randomUUID() } });
    expect(response.statusCode).toBe(403); expect(aiFetch).not.toHaveBeenCalled();
  });
});

describe('speaking assessment: idempotency, links and restore', () => {
  it('makes one request for concurrent/restarted identical submissions and rejects reused IDs with changed input', async () => {
    const aiFetch = vi.fn<typeof fetch>().mockImplementation(async () => provider()); const first = create({ aiFetch }); await configure(first.app);
    const clientAssessmentId = randomUUID();
    const results = await Promise.all([request(first.app, { clientAssessmentId }), request(first.app, { clientAssessmentId })]);
    expect(results.map(item => item.statusCode)).toEqual([200, 200]); expect(results[0]!.json()).toEqual(results[1]!.json()); expect(aiFetch).toHaveBeenCalledTimes(1);
    expect((await request(first.app, { clientAssessmentId, text: '学生です。' })).statusCode).toBe(409);
    expect((await request(first.app, { clientAssessmentId, itemId: lesson.speaking[1]!.id })).statusCode).toBe(409);
    await first.app.close(); apps.splice(apps.indexOf(first.app), 1);
    const second = create({ aiFetch, dataDir: first.dataDir }); expect((await request(second.app, { clientAssessmentId })).json()).toEqual(results[0]!.json()); expect(aiFetch).toHaveBeenCalledTimes(1);
  });
  it('rejects invalid target, recording scope and forged output fields before invoking the provider', async () => {
    const aiFetch = vi.fn<typeof fetch>(); const { app } = create({ aiFetch }); await configure(app); const other = await saved(app, { itemId: lesson.speaking[1]!.id });
    for (const patch of [{ recordingId: other.id }, { itemId: lesson.listening[0]!.id }, { totalScore: 100 }, { text: '   ' }, { clientAssessmentId: '../../bad' }]) expect((await request(app, patch)).statusCode).toBe(400);
    expect(aiFetch).not.toHaveBeenCalled();
  });
  it('allows the same failed request to be retried and rejects restoring while scoring is in flight', async () => {
    let resolveProvider!: (response: Response) => void;
    const aiFetch = vi.fn<typeof fetch>().mockRejectedValueOnce(new Error('offline')).mockImplementationOnce(() => new Promise(done => { resolveProvider = done; }));
    const { app } = create({ aiFetch }); await configure(app); const clientAssessmentId = randomUUID();
    expect((await request(app, { clientAssessmentId })).json().code).toBe('AI_UNAVAILABLE');
    const backup = (await app.inject('/api/backup')).json();
    const pending = request(app, { clientAssessmentId }).then(response => response);
    await vi.waitFor(() => expect(aiFetch).toHaveBeenCalledTimes(2));
    expect((await app.inject({ method: 'POST', url: '/api/restore', payload: { backup } })).statusCode).toBe(409);
    resolveProvider(provider()); expect((await pending).statusCode).toBe(200);
    expect((await app.inject('/api/backup')).json().assessments).toHaveLength(1);
  });
  it('shares a failed in-flight provider call across duplicate clicks and rejects competing text immediately', async () => {
    let resolveProvider!: (response: Response) => void;
    const aiFetch = vi.fn<typeof fetch>().mockImplementationOnce(() => new Promise(done => { resolveProvider = done; })).mockImplementation(async () => provider());
    const { app } = create({ aiFetch }); await configure(app); const clientAssessmentId = randomUUID();
    const first = request(app, { clientAssessmentId }).then(response => response);
    await vi.waitFor(() => expect(aiFetch).toHaveBeenCalledTimes(1));
    const duplicate = request(app, { clientAssessmentId }).then(response => response);
    expect((await request(app, { clientAssessmentId, text: '学生です。' })).statusCode).toBe(409);
    resolveProvider(new Response('unavailable', { status: 500 }));
    expect((await first).statusCode).toBe(502); expect((await duplicate).statusCode).toBe(502); expect(aiFetch).toHaveBeenCalledTimes(1);
    expect((await request(app, { clientAssessmentId })).statusCode).toBe(200); expect(aiFetch).toHaveBeenCalledTimes(2);
  });
  it('retains scores after audio deletion and in a foreign metadata-only restore; stale scores do not follow edited text', async () => {
    const aiFetch = vi.fn<typeof fetch>().mockImplementation(async () => provider()); const { app } = create({ aiFetch }); await configure(app); const record = await saved(app);
    const assessment = (await request(app, { recordingId: record.id })).json<SpeakingAssessment>();
    const attempt = { lessonId: 1, itemId: task.id, result: 'hint', answer: assessment.text, usedHint: true, recordingId: record.id, assessmentId: assessment.id };
    expect((await app.inject({ method: 'POST', url: '/api/attempts', payload: attempt })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/api/attempts', payload: { ...attempt, answer: '違います。' } })).json().code).toBe('ASSESSMENT_MISMATCH');
    const removed = (await app.inject({ method: 'DELETE', url: `/api/recordings/${record.id}` })).json(); expect(removed.assessment).toEqual(assessment); expect(removed.confirmedText).toBe(assessment.text);
    const backup = (await app.inject('/api/backup')).json(); const other = create();
    expect((await other.app.inject({ method: 'POST', url: '/api/restore', payload: { backup } })).statusCode).toBe(200);
    const restored = (await other.app.inject('/api/recordings?lessonId=1')).json()[0]; expect(restored).toMatchObject({ audioAvailable: false, audioStatus: 'deleted', assessment });
    const changed = (await other.app.inject({ method: 'PATCH', url: `/api/recordings/${record.id}`, payload: { confirmedText: '学生です。' } })).json(); expect(changed.assessment).toBeUndefined();
    expect((await other.app.inject('/api/backup')).json().assessments).toEqual([assessment]);
  });
  it('rejects forged totals, foreign grammar and dangling recording/attempt associations in backups atomically', async () => {
    const aiFetch = vi.fn<typeof fetch>().mockImplementation(async () => provider()); const { app } = create({ aiFetch }); await configure(app); const record = await saved(app); await request(app, { recordingId: record.id });
    const original = (await app.inject('/api/backup')).json();
    for (const mutate of [
      (backup: typeof original) => { backup.assessments[0].totalScore = 100; },
      (backup: typeof original) => { backup.assessments[0].recordingId = randomUUID(); },
      (backup: typeof original) => { backup.assessments[0].itemId = lesson.speaking[1]!.id; },
      (backup: typeof original) => { backup.assessments[0].corrections = [{ goal: '说职业', original: '会社員', corrected: task.answer, explanation: '再练。', grammarId: getLesson(50)!.grammar[0]!.id }]; },
    ]) {
      const backup = structuredClone(original); mutate(backup);
      expect((await app.inject({ method: 'POST', url: '/api/restore', payload: { backup } })).statusCode).toBe(400);
      expect((await app.inject('/api/backup')).json().assessments).toEqual(original.assessments);
    }
  });
});
