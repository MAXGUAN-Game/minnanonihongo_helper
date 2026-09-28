import { describe, expect, it, vi } from 'vitest';
import { getLesson } from '../src/content';
import type { Session } from '../src/shared/types';
import { requestTurn } from '../src/server/ai';
import { aiResponseSchema, ApiError } from '../src/server/schemas';

// Provider contract regression only: no API requests, saved settings or SQLite.
const lesson = getLesson(27)!;
const scenario = lesson.scenarios[0]!;
const timestamp = '2026-09-27T00:00:00.000Z';
const apiKey = 'sk-mock-empty-response-test-only';
const answer = {
  replyJa: 'はい、窓から海が見えます。',
  replyZh: '是的，从窗户可以看到海。',
  hintZh: '还可以问问能听到什么声音。',
  completedGoals: [],
  corrections: [],
  endSession: false,
};

function newSession(): Session {
  return {
    id: 'mock-hotel-session', lessonId: lesson.id, scenarioId: scenario.id,
    status: 'active', turnCount: 0, feedback: [], completedGoals: [], updatedAt: timestamp,
    turns: [{ id: 'mock-opening', role: 'assistant', text: scenario.opening.jp, translation: scenario.opening.zh, source: 'lesson', createdAt: timestamp }],
  };
}

function provider(content = JSON.stringify(answer)) {
  return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content } }] }), {
    status: 200, headers: { 'Content-Type': 'application/json' },
  });
}

function request(aiFetch: typeof fetch, session = newSession(), text = '窓から海が見えますか。') {
  return requestTurn({
    aiFetch, apiKey, model: 'deepseek-chat', lesson, scenario, session, text, usedHint: false,
    prerequisites: lesson.prerequisiteLessonIds.map(id => ({ id, canDo: getLesson(id)!.canDo })),
  });
}

describe('DeepSeek empty JSON response recovery', () => {
  it.each(['            ', '\n\t  '])('retries whitespace-only content once and accepts the next valid reply (%j)', async content => {
    const aiFetch = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(provider(content))
      .mockResolvedValueOnce(provider());
    const session = newSession();
    const original = structuredClone(session);

    await expect(request(aiFetch, session)).resolves.toEqual(answer);
    expect(aiFetch).toHaveBeenCalledTimes(2);
    expect(session).toEqual(original);
    for (const [, init] of aiFetch.mock.calls) {
      const body = JSON.parse(init!.body as string);
      expect(body.messages.at(-1)).toEqual({ role: 'user', content: '窓から海が見えますか。' });
      expect(JSON.stringify(body)).not.toContain(apiKey);
    }
  });

  it('stops after two blank responses with a safe ApiError and leaves the session unchanged', async () => {
    const aiFetch = vi.fn<typeof fetch>().mockImplementation(async () => provider('            '));
    const session = newSession();
    const original = structuredClone(session);

    const failure = await request(aiFetch, session).catch(error => error);
    expect(failure).toBeInstanceOf(ApiError);
    expect(failure).toMatchObject({ status: 502, code: 'AI_INVALID_RESPONSE' });
    expect(failure.message).not.toContain(apiKey);
    expect(aiFetch).toHaveBeenCalledTimes(2);
    expect(session).toEqual(original);
  });

  it('accepts an ordinary valid response with exactly one provider call', async () => {
    const aiFetch = vi.fn<typeof fetch>().mockResolvedValueOnce(provider());

    await expect(request(aiFetch)).resolves.toEqual(answer);
    expect(aiFetch).toHaveBeenCalledTimes(1);
  });

  it('does not retry a network failure', async () => {
    const aiFetch = vi.fn<typeof fetch>().mockRejectedValue(new Error(apiKey));

    const failure = await request(aiFetch).catch(error => error);
    expect(failure).toBeInstanceOf(ApiError);
    expect(failure).toMatchObject({ status: 502, code: 'AI_UNAVAILABLE' });
    expect(failure.message).not.toContain(apiKey);
    expect(aiFetch).toHaveBeenCalledTimes(1);
  });

  it('repairs invalid JSON once without changing the original question', async () => {
    const aiFetch = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(provider('{"replyJa":'))
      .mockResolvedValueOnce(provider());

    await expect(request(aiFetch)).resolves.toEqual(answer);
    expect(aiFetch).toHaveBeenCalledTimes(2);
    for (const [, init] of aiFetch.mock.calls) {
      const body = JSON.parse(init!.body as string);
      expect(body.messages.at(-1)).toEqual({ role: 'user', content: '窓から海が見えますか。' });
    }
  });

  it('stops after two invalid JSON replies without changing the session', async () => {
    const aiFetch = vi.fn<typeof fetch>().mockImplementation(async () => provider('{"replyJa":'));
    const session = newSession();
    const original = structuredClone(session);

    await expect(request(aiFetch, session)).rejects.toMatchObject({ status: 502, code: 'AI_INVALID_RESPONSE' });
    expect(aiFetch).toHaveBeenCalledTimes(2);
    expect(session).toEqual(original);
  });

  it('keeps strict rejection without retrying an unknown goal', async () => {
    const aiFetch = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(provider(JSON.stringify({ ...answer, completedGoals: ['invented mastery'] })))
      .mockResolvedValueOnce(provider());

    await expect(request(aiFetch)).rejects.toMatchObject({ status: 502, code: 'AI_INVALID_RESPONSE' });
    expect(aiFetch).toHaveBeenCalledTimes(1);
  });

  it('uses JSON assistant history and provides a concrete JSON example with scenario role guidance', async () => {
    const session = newSession();
    session.turnCount = 1;
    session.turns.push(
      { id: 'mock-user-1', role: 'user', text: '窓から海が見えますか。', source: 'user', createdAt: timestamp },
      { id: 'mock-assistant-1', role: 'assistant', text: answer.replyJa, translation: answer.replyZh, hint: answer.hintZh, source: 'deepseek', createdAt: timestamp },
    );
    const aiFetch = vi.fn<typeof fetch>().mockResolvedValueOnce(provider());

    await request(aiFetch, session, '夜は静かですか。');
    const body = JSON.parse(aiFetch.mock.calls[0]![1]!.body as string) as { messages: { role: string; content: string }[] };
    const assistantMessages = body.messages.filter(message => message.role === 'assistant');
    expect(assistantMessages).toHaveLength(2);
    assistantMessages.forEach((message, index) => {
      const parsed = aiResponseSchema.parse(JSON.parse(message.content));
      const previous = session.turns[index * 2]!;
      expect(parsed).toMatchObject({ replyJa: previous.text, replyZh: previous.translation });
    });
    expect(body.messages.filter(message => message.role === 'user').map(message => message.content))
      .toEqual(['窓から海が見えますか。', '夜は静かですか。']);

    const system = body.messages[0]!.content;
    const contextMarker = '\n当前练习数据：';
    const markerIndex = system.lastIndexOf(contextMarker);
    expect(markerIndex).toBeGreaterThan(0);
    const instructions = system.slice(0, markerIndex);
    expect(instructions).toMatch(/"replyJa"\s*:/);
    expect(instructions).toMatch(/goal[\s\S]{0,100}(?:用户|学习者)/);
    expect(instructions).toMatch(/setting[\s\S]{0,100}角色/);
    expect(instructions).toContain('最多提出一个问题');
    expect(instructions).toContain('绝不声称检测了发音');
    expect(JSON.parse(system.slice(markerIndex + contextMarker.length)))
      .toMatchObject({ scenario, turnNumber: 2, currentTurnUsesHint: false });
    expect(aiFetch).toHaveBeenCalledTimes(1);
  });
});
