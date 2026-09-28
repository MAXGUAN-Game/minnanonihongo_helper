import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { getLesson } from '../src/content';
import { requestTurn } from '../src/server/ai';
import { buildApp } from '../src/server/app';
import { aiResponseSchema, backupSchema } from '../src/server/schemas';
import { getGrammarChatScenario } from '../src/shared/grammar-chat';
import type { Correction, Session } from '../src/shared/types';

// Provider format regressions use mocks and temporary databases only. They do
// not read local credentials, saved learner records or access a paid service.
const apiKey = 'sk-mock-reply-format-contract-only';
const timestamp = '2026-09-27T10:00:00.000Z';
const exactReply = 'いいですね。じゃ、質問です。「明日、雨が降ったら、何をしますか。」';
const answer = {
  replyJa: exactReply,
  replyZh: '很好。那我问你：如果明天下雨，你会做什么？',
  hintZh: '试着用「雨が降ったら」说一句。',
  completedGoals: [] as string[],
  corrections: [] as Correction[],
  endSession: false,
};

function fixture(grammarId?: string) {
  const lesson = getLesson(25)!;
  const scenario = getGrammarChatScenario(lesson, grammarId)!;
  const session: Session = {
    id: 'mock-format-session', mode: 'grammar', grammarId,
    lessonId: lesson.id, scenarioId: scenario.id, status: 'active', turnCount: 0,
    feedback: [], completedGoals: [], updatedAt: timestamp,
    turns: [{ id: 'opening', role: 'assistant', text: scenario.opening.jp,
      translation: scenario.opening.zh, source: 'lesson', createdAt: timestamp }],
  };
  return { lesson, scenario, session };
}

function provider(content: unknown) {
  return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: {
    content: typeof content === 'string' ? content : JSON.stringify(content),
  } }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

function mockReply(content: unknown) {
  return vi.fn<typeof fetch>().mockImplementation(async () => provider(content));
}

function request(aiFetch: typeof fetch, data = fixture()) {
  return requestTurn({ aiFetch, apiKey, model: 'deepseek-flash',
    lesson: data.lesson, scenario: data.scenario, session: data.session,
    text: 'はい、お願いします', usedHint: false,
    prerequisites: data.lesson.prerequisiteLessonIds.map(id => ({ id, canDo: getLesson(id)!.canDo })),
  });
}

function correction(): Correction {
  const grammar = getLesson(25)!.grammar[0]!;
  return { goal: grammar.title, original: '雨を降ったら、家にいます。',
    corrected: grammar.examples[0]!, explanation: '留意条件句中的助词。', grammarId: grammar.id };
}

describe('provider reply normalization and bounded format repair', () => {
  it('accepts the actual lesson 25 greeting and quoted question without miscounting punctuation', async () => {
    const data = fixture();
    const before = structuredClone(data.session);
    const aiFetch = mockReply(answer);

    await expect(request(aiFetch, data)).resolves.toEqual(answer);
    expect(aiFetch).toHaveBeenCalledTimes(1);
    expect(data.session).toEqual(before);
  });

  it.each(['```json\n', '```\n'])('accepts a whole fenced JSON object (%j)', async fence => {
    const aiFetch = mockReply(` \n${fence}${JSON.stringify(answer)}\n\`\`\`\n `);
    await expect(request(aiFetch)).resolves.toEqual(answer);
    expect(aiFetch).toHaveBeenCalledTimes(1);
  });

  it('projects known response, correction and example fields into the canonical schema', async () => {
    const feedback = correction();
    const raw = { ...answer, providerNote: 'not part of learner records', corrections: [{
      ...feedback, confidence: 0.9, corrected: { ...feedback.corrected, extraReading: 'ignored' },
    }] };
    const aiFetch = mockReply(raw);

    const result = await request(aiFetch);
    expect(result).toEqual({ ...answer, corrections: [feedback] });
    expect(aiResponseSchema.parse(result)).toEqual(result);
    expect(aiFetch).toHaveBeenCalledTimes(1);
  });

  it.each(['missing', 'null'] as const)('defaults only %s auxiliary fields', async kind => {
    const raw = { replyJa: answer.replyJa, replyZh: answer.replyZh,
      ...(kind === 'null' ? { hintZh: null, completedGoals: null, corrections: null, endSession: null } : {}),
    };
    const aiFetch = mockReply(raw);
    const result = await request(aiFetch);

    expect(result).toEqual({ ...answer, hintZh: '' });
    expect(aiResponseSchema.parse(result)).toEqual(result);
    expect(aiFetch).toHaveBeenCalledTimes(1);
  });

  it.each([null, '', ' \t '])('omits an empty optional correction grammarId (%j)', async grammarId => {
    const { grammarId: _unused, ...feedback } = correction();
    const aiFetch = mockReply({ ...answer, corrections: [{ ...feedback, grammarId }] });
    const result = await request(aiFetch);

    expect(result).toEqual({ ...answer, corrections: [feedback] });
    expect(aiResponseSchema.parse(result)).toEqual(result);
    expect(aiFetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['missing Japanese', { ...answer, replyJa: undefined }],
    ['missing Chinese', { ...answer, replyZh: undefined }],
    ['empty Japanese', { ...answer, replyJa: '   ' }],
    ['null Chinese', { ...answer, replyZh: null }],
    ['numeric hint', { ...answer, hintZh: 1 }],
    ['scalar goals', { ...answer, completedGoals: 'done' }],
    ['object corrections', { ...answer, corrections: {} }],
    ['string boolean', { ...answer, endSession: 'false' }],
    ['missing correction explanation', { ...answer, corrections: [{ ...correction(), explanation: undefined }] }],
    ['missing correction reading', { ...answer, corrections: [{ ...correction(), corrected: { jp: '雨が降ったら、家にいます。', zh: '如果下雨，我就待在家。' } }] }],
    ['overlong Japanese', { ...answer, replyJa: 'あ'.repeat(801) }],
  ] as const)('does not fabricate or coerce %s after two invalid replies', async (_name, raw) => {
    const data = fixture();
    const before = structuredClone(data.session);
    const aiFetch = mockReply(raw);

    await expect(request(aiFetch, data)).rejects.toMatchObject({ status: 502, code: 'AI_INVALID_RESPONSE' });
    expect(aiFetch).toHaveBeenCalledTimes(2);
    expect(data.session).toEqual(before);
  });

  it('repairs a malformed reply once with the same history, user text and deadline', async () => {
    const aiFetch = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(provider('{"replyJa":'))
      .mockResolvedValueOnce(provider(answer));

    await expect(request(aiFetch)).resolves.toEqual(answer);
    expect(aiFetch).toHaveBeenCalledTimes(2);
    const first = aiFetch.mock.calls[0]![1]!;
    const second = aiFetch.mock.calls[1]![1]!;
    expect(second.signal).toBe(first.signal);
    const firstBody = JSON.parse(first.body as string);
    const secondBody = JSON.parse(second.body as string);
    expect(secondBody.messages.slice(1)).toEqual(firstBody.messages.slice(1));
    expect(secondBody.messages.at(-1)).toEqual({ role: 'user', content: 'はい、お願いします' });
    expect(JSON.stringify(secondBody)).not.toContain(apiKey);
  });

  it('shares the same two-attempt budget between blank and malformed replies', async () => {
    const aiFetch = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(provider('   \n'))
      .mockResolvedValueOnce(provider('{"replyJa":'))
      .mockResolvedValueOnce(provider(answer));

    await expect(request(aiFetch)).rejects.toMatchObject({ status: 502, code: 'AI_INVALID_RESPONSE' });
    expect(aiFetch).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['invented goal', { ...answer, completedGoals: ['invented mastery'], extra: true }],
    ['unknown grammar', { ...answer, corrections: [{ ...correction(), grammarId: 'invented-grammar', extra: true }] }],
    ['foreign grammar', { ...answer, corrections: [{ ...correction(), grammarId: getLesson(1)!.grammar[0]!.id }] }],
    ['multiple questions', { ...answer, replyJa: '雨が降りますか？家にいますか？' }],
    ['secret in unknown metadata', { ...answer, providerExtra: apiKey }],
  ] as const)('keeps %s as a strict failure without a repair call', async (_name, raw) => {
    const data = fixture();
    const before = structuredClone(data.session);
    const aiFetch = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(provider(raw))
      .mockResolvedValueOnce(provider(answer));

    const failure = await request(aiFetch, data).catch(error => error);
    expect(failure).toMatchObject({ status: 502, code: 'AI_INVALID_RESPONSE' });
    expect(failure.message).not.toContain(apiKey);
    expect(aiFetch).toHaveBeenCalledTimes(1);
    expect(data.session).toEqual(before);
  });

  it('does not erase an out-of-focus grammar ID during normalization', async () => {
    const lesson = getLesson(25)!;
    const data = fixture(lesson.grammar[0]!.id);
    const aiFetch = mockReply({ ...answer, extra: true,
      corrections: [{ ...correction(), grammarId: lesson.grammar[1]!.id, extra: true }],
    });

    await expect(request(aiFetch, data)).rejects.toMatchObject({ status: 502, code: 'AI_INVALID_RESPONSE' });
    expect(aiFetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    'Here is the JSON: ' + JSON.stringify(answer),
    JSON.stringify(answer) + '\n' + JSON.stringify(answer),
    '```json\n' + JSON.stringify(answer) + '\n``` trailing explanation',
  ])('does not extract a guessed object from unrelated surrounding text', async content => {
    const aiFetch = mockReply(content);
    await expect(request(aiFetch)).rejects.toMatchObject({ status: 502, code: 'AI_INVALID_RESPONSE' });
    expect(aiFetch).toHaveBeenCalledTimes(2);
  });
});

const resources: { app: ReturnType<typeof buildApp>; directory: string }[] = [];
afterEach(async () => {
  for (const { app, directory } of resources.splice(0)) {
    await app.close();
    const absolute = resolve(directory);
    if (dirname(absolute) !== resolve(tmpdir()) || !basename(absolute).startsWith('nihongo-reply-format-')) throw new Error('Unexpected temporary test directory');
    rmSync(absolute, { recursive: true, force: true });
  }
});

function temporaryApp(aiFetch: typeof fetch) {
  const directory = mkdtempSync(join(tmpdir(), 'nihongo-reply-format-'));
  const app = buildApp({ dataDir: directory, aiFetch });
  resources.push({ app, directory });
  return app;
}

describe('format repair persistence and canonical backups', () => {
  it('commits one pair after repair, deduplicates client retry and restores the normalized backup', async () => {
    const aiFetch = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(provider('{"replyJa":'))
      .mockResolvedValueOnce(provider({ ...answer, extra: 'discard before saving',
        corrections: [{ ...correction(), grammarId: null, extra: true,
          corrected: { ...correction().corrected, extra: true } }],
      }));
    const app = temporaryApp(aiFetch);
    expect((await app.inject({ method: 'PATCH', url: '/api/settings', payload: { apiKey } })).statusCode).toBe(200);
    const created = await app.inject({ method: 'POST', url: '/api/sessions', payload: { lessonId: 25, mode: 'grammar' } });
    expect(created.statusCode).toBe(200);
    const session = created.json<Session>();
    const input = { text: 'はい、お願いします', usedHint: false, clientTurnId: 'mock-format-first-turn' };
    const sent = await app.inject({ method: 'POST', url: `/api/sessions/${session.id}/turn`, payload: input });

    expect(sent.statusCode).toBe(200);
    const saved = sent.json<Session>();
    expect(saved.turnCount).toBe(1);
    expect(saved.turns).toHaveLength(3);
    expect(saved.turns[1]).toMatchObject({ role: 'user', text: input.text });
    expect(saved.turns[2]).toMatchObject({ role: 'assistant', source: 'deepseek', text: exactReply });
    const { grammarId: _unused, ...feedback } = correction();
    expect(saved.feedback).toEqual([feedback]);
    expect(aiFetch).toHaveBeenCalledTimes(2);

    const repeated = await app.inject({ method: 'POST', url: `/api/sessions/${session.id}/turn`, payload: input });
    expect(repeated.statusCode).toBe(200);
    expect(repeated.json()).toEqual(saved);
    expect(aiFetch).toHaveBeenCalledTimes(2);

    const backupResponse = await app.inject('/api/backup');
    expect(backupResponse.statusCode).toBe(200);
    const backup = backupSchema.parse(backupResponse.json());
    expect(backup.sessions).toEqual([saved]);
    expect(JSON.stringify(backup)).not.toContain(apiKey);
    const restoredApp = temporaryApp(vi.fn<typeof fetch>());
    const restored = await restoredApp.inject({ method: 'POST', url: '/api/restore', payload: { backup } });
    expect(restored.statusCode).toBe(200);
    expect((await restoredApp.inject(`/api/sessions/${session.id}`)).json()).toEqual(saved);

    const invalidBackup = structuredClone(backup);
    Object.assign(invalidBackup.sessions[0]!.feedback[0]!, { extra: true });
    expect(backupSchema.safeParse(invalidBackup).success).toBe(false);
    const rejected = await restoredApp.inject({ method: 'POST', url: '/api/restore', payload: { backup: invalidBackup } });
    expect(rejected.statusCode).toBe(400);
    expect((await restoredApp.inject(`/api/sessions/${session.id}`)).json()).toEqual(saved);
  });
});
