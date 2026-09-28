import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { buildApp, type AppOptions } from '../src/server/app';
import { getLesson, lessons } from '../src/content';
import { getGrammarChatScenario, GRAMMAR_CHAT_MAX_TURNS } from '../src/shared/grammar-chat';
import type { Session } from '../src/shared/types';
import type { Backup } from '../src/server/schemas';

const apps: ReturnType<typeof buildApp>[] = [];
const dirs: string[] = [];
const fakeKey = 'sk-grammar-chat-test-only';
function create(options: AppOptions = {}) {
  const dataDir = options.dataDir ?? mkdtempSync(join(tmpdir(), 'nihongo-grammar-chat-test-'));
  if (!dirs.includes(dataDir)) dirs.push(dataDir);
  const app = buildApp({ ...options, dataDir });
  apps.push(app);
  return { app, dataDir };
}
async function close(app: ReturnType<typeof buildApp>) {
  await app.close();
  apps.splice(apps.indexOf(app), 1);
}
async function configure(app: ReturnType<typeof buildApp>, currentLessonId = 27) {
  const response = await app.inject({ method: 'PATCH', url: '/api/settings', payload: { apiKey: fakeKey, currentLessonId, setupComplete: true } });
  expect(response.statusCode).toBe(200);
}
function mockAI() {
  return vi.fn<typeof fetch>().mockImplementation(async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ replyJa: '海が見えます。何が聞こえますか？', replyZh: '能看见海。能听见什么？', hintZh: '可以说「波の音が聞こえます」。', completedGoals: [], corrections: [], endSession: true }) } }] }), { headers: { 'Content-Type': 'application/json' } }));
}
async function createChat(app: ReturnType<typeof buildApp>, lessonId = 27, grammarId?: string): Promise<Session> {
  const response = await app.inject({ method: 'POST', url: '/api/sessions', payload: { lessonId, mode: 'grammar', ...(grammarId ? { grammarId } : {}) } });
  expect(response.statusCode).toBe(200);
  return response.json();
}
async function send(app: ReturnType<typeof buildApp>, session: Session, index: number, text = '海が見えます。') {
  return app.inject({ method: 'POST', url: `/api/sessions/${session.id}/turn`, payload: { text, usedHint: false, clientTurnId: `grammar-turn-${index}` } });
}
async function backup(app: ReturnType<typeof buildApp>): Promise<Backup> { return (await app.inject('/api/backup')).json(); }
async function restore(app: ReturnType<typeof buildApp>, value: Backup) { return app.inject({ method: 'POST', url: '/api/restore', payload: { backup: value } }); }
function withTurns(session: Session, count: number): Session {
  const value = structuredClone(session);
  value.turnCount = count;
  value.turns = [value.turns[0]!];
  for (let index = 1; index <= count; index++) value.turns.push(
    { id: `restored-user-${index}`, role: 'user', text: '海が見えます。', source: 'user', createdAt: session.updatedAt },
    { id: `restored-ai-${index}`, role: 'assistant', text: 'そうですね。', source: 'deepseek', createdAt: session.updatedAt },
  );
  return value;
}

afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) {
    if (!resolve(dir).startsWith(resolve(tmpdir(), 'nihongo-grammar-chat-test-'))) throw new Error('unexpected grammar chat test directory');
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('per-lesson grammar chat creation', () => {
  it.each([1, 27, 50])('creates whole-lesson and focused chat for lesson %i without a cloud call', async lessonId => {
    const aiFetch = mockAI();
    const { app } = create({ aiFetch });
    const lesson = getLesson(lessonId)!;
    const whole = await createChat(app, lessonId);
    expect(whole).toMatchObject({ lessonId, mode: 'grammar', scenarioId: `l${lessonId}-grammar-chat`, status: 'active', turnCount: 0, feedback: [], completedGoals: [] });
    expect(whole.grammarId).toBeUndefined();
    expect(whole.turns).toHaveLength(1);
    expect(whole.turns[0]).toMatchObject({ text: getGrammarChatScenario(lesson)!.opening.jp, source: 'lesson' });
    const focused = await createChat(app, lessonId, lesson.grammar[0]!.id);
    expect(focused).toMatchObject({ grammarId: lesson.grammar[0]!.id, scenarioId: whole.scenarioId });
    expect(aiFetch).not.toHaveBeenCalled();
  });
  it('opens an actual grammar chat for each of the 50 lessons', async () => {
    const { app } = create();
    for (const lesson of lessons) {
      const session = await createChat(app, lesson.id, lesson.grammar.at(-1)!.id);
      expect(session.scenarioId).toBe(`l${lesson.id}-grammar-chat`);
      expect(session.grammarId).toBe(lesson.grammar.at(-1)!.id);
    }
  });
  it.each([
    { lessonId: 27, mode: 'grammar', grammarId: getLesson(1)!.grammar[0]!.id },
    { lessonId: 27, mode: 'grammar', grammarId: 'invented-grammar' },
    { lessonId: 27, mode: 'grammar', scenarioId: getLesson(27)!.scenarios[0]!.id },
    { lessonId: 27, mode: 'grammar', scenarioId: 'l1-grammar-chat' },
    { lessonId: 27, mode: 'scenario', scenarioId: getLesson(27)!.scenarios[0]!.id, grammarId: getLesson(27)!.grammar[0]!.id },
    { lessonId: 27, scenarioId: getLesson(27)!.scenarios[0]!.id, grammarId: getLesson(27)!.grammar[0]!.id },
    { lessonId: 27 },
  ])('rejects inconsistent chat configuration %# without saving a session', async payload => {
    const { app } = create();
    expect((await app.inject({ method: 'POST', url: '/api/sessions', payload })).statusCode).toBe(400);
    expect((await backup(app)).sessions).toEqual([]);
  });
  it('accepts the canonical virtual scenario ID and retains legacy scenario creation', async () => {
    const { app } = create();
    const grammar = await app.inject({ method: 'POST', url: '/api/sessions', payload: { lessonId: 27, mode: 'grammar', scenarioId: 'l27-grammar-chat' } });
    expect(grammar.statusCode).toBe(200);
    for (const mode of [undefined, 'scenario']) {
      const response = await app.inject({ method: 'POST', url: '/api/sessions', payload: { lessonId: 27, scenarioId: getLesson(27)!.scenarios[0]!.id, ...(mode ? { mode } : {}) } });
      expect(response.statusCode).toBe(200);
      expect(response.json().mode).toBe(mode);
    }
  });
});

describe('grammar chat turn lifecycle', () => {
  it('continues beyond six turns until the learner ends, without assigning mastery', async () => {
    const aiFetch = mockAI(); const { app } = create({ aiFetch }); await configure(app);
    const session = await createChat(app);
    for (let index = 1; index <= 8; index++) {
      const response = await send(app, session, index);
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ status: 'active', turnCount: index, completedGoals: [] });
    }
    expect(aiFetch).toHaveBeenCalledTimes(8);
    const finished = (await app.inject({ method: 'POST', url: `/api/sessions/${session.id}/finish` })).json();
    expect(finished).toMatchObject({ status: 'complete', turnCount: 8, completedGoals: [] });
    expect((await send(app, session, 9)).json().code).toBe('SESSION_COMPLETE');
    expect((await app.inject('/api/bootstrap')).json().totals.independent).toBe(0);
    const saved = await backup(app);
    expect(saved.progress).toEqual([]); expect(saved.attempts).toEqual([]);
    expect((await restore(app, saved)).statusCode).toBe(200);
  });
  it('deduplicates simultaneous sends and preserves deduplication through restart', async () => {
    const aiFetch = mockAI(); const first = create({ aiFetch }); await configure(first.app);
    const session = await createChat(first.app);
    const responses = await Promise.all([send(first.app, session, 1), send(first.app, session, 1)]);
    expect(responses.every(response => response.statusCode === 200)).toBe(true);
    expect(responses[0]!.json()).toEqual(responses[1]!.json());
    expect(aiFetch).toHaveBeenCalledTimes(1);
    await close(first.app);
    const second = create({ dataDir: first.dataDir, aiFetch });
    expect((await send(second.app, session, 1)).json().turnCount).toBe(1);
    expect((await send(second.app, session, 1, '山が見えます。')).json().code).toBe('IDEMPOTENCY_CONFLICT');
    expect(aiFetch).toHaveBeenCalledTimes(1);
  });
  it('preserves an unconfigured or failed chat without inventing a response', async () => {
    const aiFetch = vi.fn<typeof fetch>().mockRejectedValue(new Error('offline'));
    const { app } = create({ aiFetch }); const session = await createChat(app);
    expect((await send(app, session, 1)).json().code).toBe('AI_NOT_CONFIGURED');
    expect(aiFetch).not.toHaveBeenCalled();
    await configure(app);
    expect((await send(app, session, 1)).json().code).toBe('AI_UNAVAILABLE');
    expect((await app.inject(`/api/sessions/${session.id}`)).json()).toEqual(session);
  });
  it('enforces the safety cap after a restored long conversation and still deduplicates its last turn', async () => {
    const aiFetch = mockAI(); const { app } = create({ aiFetch }); await configure(app);
    const session = await createChat(app);
    const saved = await backup(app); saved.sessions[0] = withTurns(session, GRAMMAR_CHAT_MAX_TURNS - 1);
    expect((await restore(app, saved)).statusCode).toBe(200);
    const response = await send(app, session, GRAMMAR_CHAT_MAX_TURNS);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ turnCount: GRAMMAR_CHAT_MAX_TURNS, status: 'complete' });
    expect((await send(app, session, GRAMMAR_CHAT_MAX_TURNS)).json()).toEqual(response.json());
    expect((await send(app, session, GRAMMAR_CHAT_MAX_TURNS + 1)).json().code).toBe('SESSION_COMPLETE');
    expect(aiFetch).toHaveBeenCalledTimes(1);
    expect((await restore(app, await backup(app))).statusCode).toBe(200);
  });
});

describe('mixed legacy and grammar conversation backups', () => {
  it('rejects feedback outside the chosen grammar focus while preserving the existing chat', async () => {
    const { app } = create();
    const lesson = getLesson(27)!;
    const session = await createChat(app, 27, lesson.grammar[1]!.id);
    const saved = await backup(app);
    saved.sessions[0]!.feedback = [{ goal: '另一个语法点', original: 'test', corrected: lesson.grammar[0]!.examples[0]!, explanation: '测试范围', grammarId: lesson.grammar[0]!.id }];
    expect((await restore(app, saved)).statusCode).toBe(400);
    expect((await app.inject(`/api/sessions/${session.id}`)).json()).toEqual(session);
  });
  it('restores old and new session records, resumes focused grammar chat after restart and omits the key', async () => {
    const first = create(); await configure(first.app, 27);
    const legacy = (await first.app.inject({ method: 'POST', url: '/api/sessions', payload: { lessonId: 27, scenarioId: getLesson(27)!.scenarios[0]!.id } })).json();
    const grammar = await createChat(first.app, 27, getLesson(27)!.grammar[1]!.id);
    const saved = await backup(first.app);
    expect(saved.sessions[0]).toEqual(legacy);
    expect(saved.sessions[0]!.mode).toBeUndefined();
    saved.sessions[1] = withTurns(grammar, 8);
    expect(JSON.stringify(saved)).not.toContain(fakeKey);
    expect((await restore(first.app, saved)).statusCode).toBe(200);
    await close(first.app);
    const second = create({ dataDir: first.dataDir });
    const bootstrap = (await second.app.inject('/api/bootstrap')).json();
    expect(bootstrap.activeSession).toMatchObject({ id: grammar.id, mode: 'grammar', grammarId: grammar.grammarId, turnCount: 8 });
    expect(bootstrap.settings.hasApiKey).toBe(true);
    expect((await backup(second.app)).sessions).toEqual(saved.sessions);
  });
  it.each(['focus', 'scenario', 'opening', 'opening-translation', 'goals', 'legacy-mode', 'missing-mode', 'turn-cap', 'active-at-cap'] as const)('rejects invalid %s backup without replacing existing records', async change => {
    const { app } = create(); const session = await createChat(app);
    const saved = await backup(app);
    const bad = structuredClone(saved);
    const invalid = bad.sessions[0]!;
    if (change === 'focus') invalid.grammarId = getLesson(1)!.grammar[0]!.id;
    if (change === 'scenario') invalid.scenarioId = 'l1-grammar-chat';
    if (change === 'opening') invalid.turns[0]!.text = 'Different opening';
    if (change === 'opening-translation') invalid.turns[0]!.translation = '另一个语法点的开场白';
    if (change === 'goals') invalid.completedGoals = ['invented mastery'];
    if (change === 'legacy-mode' || change === 'missing-mode') {
      bad.sessions[0] = withTurns(invalid, 7);
      if (change === 'legacy-mode') bad.sessions[0].mode = 'scenario';
      else delete bad.sessions[0].mode;
    }
    if (change === 'turn-cap') bad.sessions[0] = withTurns(invalid, GRAMMAR_CHAT_MAX_TURNS + 1);
    if (change === 'active-at-cap') bad.sessions[0] = withTurns(invalid, GRAMMAR_CHAT_MAX_TURNS);
    expect((await restore(app, bad)).statusCode).toBe(400);
    expect((await app.inject(`/api/sessions/${session.id}`)).json()).toEqual(session);
    expect((await backup(app)).sessions).toEqual(saved.sessions);
  });
});
