import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { buildApp, type AppOptions } from '../src/server/app';
import { getLesson } from '../src/content';
import type { Session } from '../src/shared/types';

const lesson = getLesson(1)!;
const scenario = lesson.scenarios[0]!;
const key = 'sk-private-test-key-do-not-export';
const apps: ReturnType<typeof buildApp>[] = [];
const dirs: string[] = [];
function create(options: AppOptions = {}) {
  const dataDir = options.dataDir ?? mkdtempSync(join(tmpdir(), 'nihongo-server-test-'));
  if (!dirs.includes(dataDir)) dirs.push(dataDir);
  const app = buildApp({ ...options, dataDir }); apps.push(app);
  return { app, dataDir };
}
async function configure(app: ReturnType<typeof buildApp>) { return app.inject({ method: 'PATCH', url: '/api/settings', payload: { apiKey: key, setupComplete: true } }); }
async function createSession(app: ReturnType<typeof buildApp>): Promise<Session> {
  const response = await app.inject({ method: 'POST', url: '/api/sessions', payload: { lessonId: lesson.id, scenarioId: scenario.id } });
  expect(response.statusCode).toBe(200); return response.json();
}
function result(overrides: Record<string, unknown> = {}) {
  return { replyJa: 'そうですか。お仕事は何ですか？', replyZh: '原来如此。你做什么工作？', hintZh: '说出自己的职业。', completedGoals: scenario.successCriteria, corrections: [], endSession: true, ...overrides };
}
function provider(value: unknown = result(), status = 200) { return new Response(JSON.stringify({ choices: [{ message: { content: typeof value === 'string' ? value : JSON.stringify(value) } }] }), { status, headers: { 'Content-Type': 'application/json' } }); }
function mockAI(value: unknown = result()) { return vi.fn<typeof fetch>().mockImplementation(async () => provider(value)); }
async function send(app: ReturnType<typeof buildApp>, session: Session, index = 1, text = '会社員です。') {
  return app.inject({ method: 'POST', url: `/api/sessions/${session.id}/turn`, payload: { text, usedHint: false, clientTurnId: `turn-${index}` } });
}
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) {
    if (!resolve(dir).startsWith(resolve(tmpdir(), 'nihongo-server-test-'))) throw new Error('unexpected test directory');
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('local store and safe settings', () => {
  it('serves all 50 actual lessons and can open a second-volume scenario without AI configuration', async () => {
    const { app } = create();
    const all = (await app.inject('/api/lessons')).json();
    expect(all.map((item: { id: number }) => item.id)).toEqual(Array.from({ length: 50 }, (_, i) => i + 1));
    const last = (await app.inject('/api/lessons/50')).json();
    expect(last.volume).toBe(2);
    const session = (await app.inject({ method: 'POST', url: '/api/sessions', payload: { lessonId: 50, scenarioId: last.scenarios[0].id } })).json();
    expect(session.turns[0]).toMatchObject({ text: last.scenarios[0].opening.jp, source: 'lesson' });
  });
  it('persists settings, progress, reviews and conversations across a fresh app instance', async () => {
    const first = create(); await configure(first.app);
    await first.app.inject({ method: 'POST', url: '/api/progress', payload: { lessonId: 1, stage: 'speak', cursor: 1, status: 'assisted', itemId: lesson.speaking[1]!.id } });
    await first.app.inject({ method: 'POST', url: '/api/reviews', payload: { lessonId: 1, goal: '说职业', answer: lesson.speaking[0]!.answer, sourceId: 'first-card' } });
    const session = await createSession(first.app);
    await first.app.close(); apps.splice(apps.indexOf(first.app), 1);
    const second = create({ dataDir: first.dataDir });
    const bootstrap = (await second.app.inject('/api/bootstrap')).json();
    expect(bootstrap.settings).toMatchObject({ hasApiKey: true, setupComplete: true });
    expect(bootstrap.progress).toHaveLength(1); expect(bootstrap.progress[0].status).toBe('assisted');
    expect(bootstrap.totals.reviews).toBe(1); expect(bootstrap.activeSession.id).toBe(session.id);
    expect(bootstrap.activeSession.turns[0].source).toBe('lesson');
    expect(bootstrap.activeSession.turns[0].text).toBe(scenario.opening.jp);
  });
  it('keeps keys out of settings, bootstrap and backups and rejects settings mass assignment', async () => {
    const { app } = create(); const patch = await configure(app);
    expect(patch.body).not.toContain(key);
    for (const url of ['/api/settings', '/api/bootstrap', '/api/backup']) { const response = await app.inject(url); expect(response.statusCode).toBe(200); expect(response.body).not.toContain(key); expect(response.body).not.toContain('apiKey'); }
    const bad = await app.inject({ method: 'PATCH', url: '/api/settings', payload: { hasApiKey: true } }); expect(bad.statusCode).toBe(400);
    expect((await app.inject({ method: 'PATCH', url: '/api/settings', payload: { apiKey: '' } })).json().hasApiKey).toBe(false);
  });
  it('resumes the selected lesson when another lesson has a newer active conversation', async () => {
    const { app } = create(); const first = await createSession(app); const otherLesson = getLesson(2)!;
    const other = (await app.inject({ method: 'POST', url: '/api/sessions', payload: { lessonId: 2, scenarioId: otherLesson.scenarios[0]!.id } })).json();
    expect((await app.inject('/api/bootstrap')).json().activeSession.id).toBe(first.id);
    await app.inject({ method: 'PATCH', url: '/api/settings', payload: { currentLessonId: 2 } });
    expect((await app.inject('/api/bootstrap')).json().activeSession.id).toBe(other.id);
  });
  it('accepts local requests and blocks foreign Host and Origin headers before accessing settings', async () => {
    const { app } = create();
    expect((await app.inject({ url: '/api/settings', headers: { host: 'localhost:8787', origin: 'http://localhost:5173' } })).statusCode).toBe(200);
    expect((await app.inject({ url: '/api/settings', headers: { host: 'evil.test' } })).json().code).toBe('LOCAL_ONLY');
    expect((await app.inject({ method: 'PATCH', url: '/api/settings', headers: { origin: 'https://evil.test' }, payload: { apiKey: key } })).statusCode).toBe(403);
    expect((await app.inject('/api/settings')).json().hasApiKey).toBe(false);
  });
  it('records hint use honestly without automatically granting mastery', async () => {
    const { app } = create();
    const response = await app.inject({ method: 'POST', url: '/api/attempts', payload: { lessonId: 1, itemId: lesson.speaking[0]!.id, result: 'good', usedHint: true } });
    expect(response.json().result).toBe('hint');
    const bootstrap = (await app.inject('/api/bootstrap')).json();
    expect(bootstrap.progress).toEqual([]); expect(bootstrap.totals.independent).toBe(0);
    expect((await app.inject({ method: 'POST', url: '/api/attempts', payload: { lessonId: 1, itemId: 'not-this-lesson', result: 'good' } })).statusCode).toBe(400);
  });
  it('retains explicit item evidence across navigation without calling the whole lesson mastered', async () => {
    const { app } = create();
    const payload = { lessonId: 1, stage: 'speak', cursor: 0, status: 'independent', itemId: lesson.speaking[0]!.id };
    await app.inject({ method: 'POST', url: '/api/progress', payload });
    const navigation = await app.inject({ method: 'POST', url: '/api/progress', payload: { ...payload, status: 'seen' } });
    expect(navigation.json().status).toBe('independent');
    const withoutItem = await app.inject({ method: 'POST', url: '/api/progress', payload: { lessonId: 1, stage: 'speak', cursor: 0, status: 'seen' } });
    expect(withoutItem.json().status).toBe('independent');
    await app.inject({ method: 'POST', url: '/api/progress', payload: { ...payload, cursor: 1, itemId: lesson.speaking[1]!.id, status: 'seen' } });
    const bootstrap = (await app.inject('/api/bootstrap')).json();
    expect(bootstrap.progress[0].status).toBe('seen'); expect(bootstrap.totals.independent).toBe(1);
    expect((await app.inject('/api/backup')).json().attempts).toHaveLength(1);
  });
  it('keeps the last cursor in each lesson stage through backup restore', async () => {
    const { app } = create();
    await app.inject({ method: 'POST', url: '/api/progress', payload: { lessonId: 1, stage: 'speak', cursor: 2, status: 'seen' } });
    await app.inject({ method: 'POST', url: '/api/progress', payload: { lessonId: 1, stage: 'listen', cursor: 1, status: 'seen' } });
    const backup = (await app.inject('/api/backup')).json();
    expect(backup.progress).toHaveLength(2);
    expect((await app.inject({ method: 'POST', url: '/api/restore', payload: { backup } })).statusCode).toBe(200);
    const progress = (await app.inject('/api/bootstrap')).json().progress;
    expect(progress.find((item: { stage: string }) => item.stage === 'speak').cursor).toBe(2);
    expect(progress.find((item: { stage: string }) => item.stage === 'listen').cursor).toBe(1);
  });
});

describe('review scheduling and recovery', () => {
  it('deduplicates source cards and follows 1/3/7/14/30, retaining hint intervals and rejecting repeated ratings', async () => {
    const { app } = create();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now());
    const payload = { lessonId: 1, goal: '说职业', answer: lesson.speaking[0]!.answer, grammarId: lesson.grammar[0]!.id, sourceId: lesson.speaking[0]!.id };
    let card = (await app.inject({ method: 'POST', url: '/api/reviews', payload })).json();
    const duplicate = (await app.inject({ method: 'POST', url: '/api/reviews', payload })).json();
    expect(duplicate.id).toBe(card.id); expect(Date.parse(card.dueAt) - Date.now()).toBe(86400000);
    expect((await app.inject('/api/reviews?due=1')).json()).toHaveLength(0);
    const rate = async (rating: 'again' | 'hint' | 'good') => app.inject({ method: 'POST', url: `/api/reviews/${card.id}/rate`, payload: { rating } });
    clock.mockReturnValue(Date.parse(card.dueAt));
    expect((await app.inject('/api/reviews?due=1')).json()).toHaveLength(1);
    card = (await rate('hint')).json(); expect(card.intervalIndex).toBe(0); expect(Date.parse(card.dueAt) - Date.now()).toBe(86400000);
    expect((await rate('good')).statusCode).toBe(409);
    for (const [index, days] of [[1, 3], [2, 7], [3, 14], [4, 30], [4, 30]]) {
      clock.mockReturnValue(Date.parse(card.dueAt)); card = (await rate('good')).json();
      expect(card.intervalIndex).toBe(index); expect(Date.parse(card.dueAt) - Date.now()).toBe(days! * 86400000);
    }
    clock.mockReturnValue(Date.parse(card.dueAt)); card = (await rate('hint')).json(); expect(card.intervalIndex).toBe(4); expect(Date.parse(card.dueAt) - Date.now()).toBe(30 * 86400000);
    clock.mockReturnValue(Date.parse(card.dueAt)); card = (await rate('again')).json(); expect(card.intervalIndex).toBe(0); expect(Date.parse(card.dueAt) - Date.now()).toBe(86400000);
  });
  it('validates the whole backup before replacing anything and restores without changing the key', async () => {
    const aiFetch = mockAI(); const { app } = create({ aiFetch }); await configure(app);
    const session = await createSession(app);
    const original = (await app.inject('/api/backup')).json();
    const invalid = structuredClone(original); invalid.settings.currentLessonId = 2;
    invalid.progress.push({ lessonId: 1, stage: 'listen', cursor: 999, status: 'seen', updatedAt: new Date().toISOString() });
    expect((await app.inject({ method: 'POST', url: '/api/restore', payload: { backup: invalid } })).statusCode).toBe(400);
    expect((await app.inject('/api/settings')).json().currentLessonId).toBe(1);
    expect((await app.inject(`/api/sessions/${session.id}`)).statusCode).toBe(200);
    const attemptedKey = structuredClone(original); attemptedKey.settings.apiKey = 'replacement';
    expect((await app.inject({ method: 'POST', url: '/api/restore', payload: { backup: attemptedKey } })).statusCode).toBe(400);
    const valid = structuredClone(original); valid.settings.currentLessonId = 2;
    expect((await app.inject({ method: 'POST', url: '/api/restore', payload: { backup: valid } })).statusCode).toBe(200);
    expect((await app.inject('/api/settings')).json()).toMatchObject({ currentLessonId: 2, hasApiKey: true });
    expect((await app.inject('/api/backup')).json().sessions).toEqual(original.sessions);
    expect((await send(app, session)).statusCode).toBe(200);
    expect(aiFetch.mock.calls[0]![1]!.headers).toMatchObject({ Authorization: `Bearer ${key}` });
  });
  it('rejects duplicate record IDs and inconsistent session turns atomically', async () => {
    const { app } = create(); await createSession(app);
    const backup = (await app.inject('/api/backup')).json();
    backup.sessions.push(structuredClone(backup.sessions[0]));
    expect((await app.inject({ method: 'POST', url: '/api/restore', payload: { backup } })).statusCode).toBe(400);
    backup.sessions.pop(); backup.sessions[0].turnCount = 1;
    expect((await app.inject({ method: 'POST', url: '/api/restore', payload: { backup } })).statusCode).toBe(400);
    expect((await app.inject('/api/backup')).json().sessions[0].turnCount).toBe(0);
  });
  it('rejects oversized backups with an explicit safe limit', async () => {
    const { app } = create();
    const response = await app.inject({ method: 'POST', url: '/api/restore', payload: { backup: 'a'.repeat(16 * 1024 * 1024) } });
    expect(response.statusCode).toBe(413); expect(response.json().code).toBe('PAYLOAD_TOO_LARGE'); expect(response.json().error).toContain('16 MiB');
  });
});

describe('real-provider boundary without making paid requests', () => {
  it('requires a configured key without inventing an AI reply', async () => {
    const aiFetch = mockAI(); const { app } = create({ aiFetch }); const session = await createSession(app);
    const response = await send(app, session);
    expect(response.statusCode).toBe(503); expect(response.json().code).toBe('AI_NOT_CONFIGURED'); expect(aiFetch).not.toHaveBeenCalled();
    expect((await app.inject(`/api/sessions/${session.id}`)).json()).toEqual(session);
  });
  it('sends only current lesson, prerequisite targets and the session with the correct provider options', async () => {
    const aiFetch = mockAI(); const { app } = create({ aiFetch }); await configure(app); const session = await createSession(app);
    const response = await send(app, session); expect(response.statusCode).toBe(200);
    const [url, init] = aiFetch.mock.calls[0]!; expect(url).toBe('https://api.deepseek.com/chat/completions');
    const body = JSON.parse(init!.body as string);
    expect(body).toMatchObject({ model: 'deepseek-flash', thinking: { type: 'disabled' }, response_format: { type: 'json_object' } });
    expect(init!.headers).toMatchObject({ Authorization: `Bearer ${key}` });
    expect(JSON.stringify(body)).not.toContain(key); expect(body.messages).toHaveLength(3);
    expect(body.messages[0].content).toContain(lesson.title); expect(body.messages[0].content).not.toContain(getLesson(2)!.title);
    expect(response.json().turns[2].source).toBe('deepseek'); expect(response.json().turnCount).toBe(1);
  });
  it.each([
    ['network', () => Promise.reject(new Error(key)), 'AI_UNAVAILABLE'],
    ['authorization', async () => new Response(key, { status: 401 }), 'AI_AUTH_FAILED'],
    ['invalid JSON', async () => provider('not JSON'), 'AI_INVALID_RESPONSE'],
    ['wrong shape', async () => provider({ replyJa: 'はい。' }), 'AI_INVALID_RESPONSE'],
    ['invented goal', async () => provider(result({ completedGoals: ['invented mastery'] })), 'AI_INVALID_RESPONSE'],
    ['multiple questions', async () => provider(result({ replyJa: 'お名前は？お仕事は？' })), 'AI_INVALID_RESPONSE'],
    ['too many corrections', async () => provider(result({ corrections: [{}, {}, {}] })), 'AI_INVALID_RESPONSE'],
  ] as const)('keeps the session unchanged on %s and returns a safe error', async (_name, responseFactory, code) => {
    const aiFetch = vi.fn<typeof fetch>().mockImplementation(responseFactory); const { app } = create({ aiFetch }); await configure(app); const session = await createSession(app);
    const response = await send(app, session); expect(response.statusCode).toBe(502); expect(response.json().code).toBe(code); expect(response.body).not.toContain(key);
    expect((await app.inject(`/api/sessions/${session.id}`)).json()).toEqual(session);
  });
  it('deduplicates concurrent and restarted client turns and rejects key reuse for a different sentence', async () => {
    const aiFetch = mockAI(); const first = create({ aiFetch }); await configure(first.app); const session = await createSession(first.app);
    const responses = await Promise.all([send(first.app, session), send(first.app, session)]);
    expect(responses.every(response => response.statusCode === 200)).toBe(true); expect(aiFetch).toHaveBeenCalledTimes(1);
    expect(responses[0]!.json()).toEqual(responses[1]!.json());
    await first.app.close(); apps.splice(apps.indexOf(first.app), 1);
    const second = create({ aiFetch, dataDir: first.dataDir });
    expect((await send(second.app, session)).json().turnCount).toBe(1); expect(aiFetch).toHaveBeenCalledTimes(1);
    expect((await send(second.app, session, 1, '学生です。')).statusCode).toBe(409);
  });
  it('waits at least four turns before goal completion and gives at most two collected corrections', async () => {
    const correction = { goal: '说职业', original: '会社員', corrected: lesson.speaking[0]!.answer, explanation: '礼貌回答可以加上です。', grammarId: lesson.grammar[0]!.id };
    const aiFetch = mockAI(result({ corrections: [correction] })); const { app } = create({ aiFetch }); await configure(app); const session = await createSession(app);
    for (let index = 1; index <= 4; index++) {
      const response = await send(app, session, index); expect(response.statusCode).toBe(200);
      expect(response.json().status).toBe(index === 4 ? 'complete' : 'active');
    }
    expect((await send(app, session, 5)).statusCode).toBe(409); expect(aiFetch).toHaveBeenCalledTimes(4);
    const finished = (await app.inject({ method: 'POST', url: `/api/sessions/${session.id}/finish` })).json();
    expect(finished.status).toBe('complete'); expect(finished.feedback).toHaveLength(1);
    expect((await app.inject('/api/bootstrap')).json().totals.independent).toBe(0);
  });
  it('caps an unfinished scenario at six turns and supports ending early without claiming goals', async () => {
    const aiFetch = mockAI(result({ completedGoals: [], endSession: false })); const { app } = create({ aiFetch }); await configure(app); const session = await createSession(app);
    for (let index = 1; index <= 6; index++) expect((await send(app, session, index)).json().status).toBe(index === 6 ? 'complete' : 'active');
    expect((await send(app, session, 7)).statusCode).toBe(409); expect(aiFetch).toHaveBeenCalledTimes(6);
    const other = await createSession(app);
    const finished = (await app.inject({ method: 'POST', url: `/api/sessions/${other.id}/finish` })).json();
    expect(finished).toMatchObject({ status: 'complete', turnCount: 0, completedGoals: [], feedback: [] });
  });
});
