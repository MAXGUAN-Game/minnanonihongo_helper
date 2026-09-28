import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { buildApp } from '../src/server/app';
import { getLesson } from '../src/content';
import type { Correction, Example, Session } from '../src/shared/types';

// Contract tests only: real course + real temporary SQLite + mocked provider.
// They prove context scoping and server validation, not actual model quality.
const cases: { lessonId: number; alternative: string; mistaken: string; corrected: Example }[] = [
  { lessonId: 1, alternative: '私はチョウです。会社員です。', mistaken: '私は会社員だです。', corrected: { jp: '私は会社員です。', kana: 'わたしはかいしゃいんです。', zh: '我是公司职员。' } },
  { lessonId: 14, alternative: 'すみません、少しゆっくり話してください。', mistaken: 'ゆっくり話しますください。', corrected: { jp: 'ゆっくり話してください。', kana: 'ゆっくりはなしてください。', zh: '请慢慢说。' } },
  { lessonId: 25, alternative: '雨だったら、図書館で本を読みます。', mistaken: '雨だったらです、図書館へ行きます。', corrected: { jp: '雨だったら、図書館へ行きます。', kana: 'あめだったら、としょかんへいきます。', zh: '如果下雨，就去图书馆。' } },
  { lessonId: 26, alternative: '東口がわからないんです。', mistaken: '東口がわからないですん。', corrected: { jp: '東口がわからないんです。', kana: 'ひがしぐちがわからないんです。', zh: '我找不到东出口。' } },
  { lessonId: 50, alternative: '佐々木と申します。三時のお約束で参りました。', mistaken: '私は三時にいらっしゃいます。', corrected: { jp: '私は三時に伺います。', kana: 'わたしはさんじにうかがいます。', zh: '我将在三点拜访。' } },
];
const resources: { app: ReturnType<typeof buildApp>; directory: string }[] = [];
afterEach(async () => {
  for (const { app, directory } of resources.splice(0)) {
    await app.close();
    const absolute = resolve(directory);
    if (dirname(absolute) !== resolve(tmpdir()) || !basename(absolute).startsWith('nihongo-ai-lesson-')) throw new Error('Unexpected temporary test directory');
    rmSync(absolute, { recursive: true, force: true });
  }
});

describe('mock AI contract for representative lessons (no paid requests)', () => {
  it.each(cases)('lesson $lessonId: scoped context, variants, corrections, response rejection and 4–6 turn limits', async ({ lessonId, alternative, mistaken, corrected }) => {
    const lesson = getLesson(lessonId)!;
    const scenario = lesson.scenarios[0]!;
    const grammarId = scenario.targetGrammarIds[0]!;
    const correction: Correction = { goal: lesson.grammar.find(g => g.id === grammarId)!.title, original: mistaken, corrected, explanation: '按本课句型调整这处表达。', grammarId };
    let goals: string[] = [...scenario.successCriteria];
    let corrections: Correction[] = [];
    let replyJa = 'わかりました。';
    let endSession = true;
    const aiFetch = vi.fn<typeof fetch>().mockImplementation(async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
      replyJa, replyZh: '明白了。', hintZh: '围绕当前场景回答一句。', completedGoals: goals, corrections, endSession,
    }) } }] }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    const directory = mkdtempSync(join(tmpdir(), 'nihongo-ai-lesson-'));
    const app = buildApp({ dataDir: directory, aiFetch }); resources.push({ app, directory });
    const configured = await app.inject({ method: 'PATCH', url: '/api/settings', payload: { apiKey: 'sk-mock-only-no-real-key', currentLessonId: lessonId } });
    expect(configured.statusCode).toBe(200);
    const create = async (): Promise<Session> => {
      const response = await app.inject({ method: 'POST', url: '/api/sessions', payload: { lessonId, scenarioId: scenario.id } });
      expect(response.statusCode).toBe(200); return response.json();
    };
    let sequence = 0;
    const send = (session: Session, text = alternative, usedHint = false) => app.inject({ method: 'POST', url: `/api/sessions/${session.id}/turn`, payload: { text, usedHint, clientTurnId: `mock-l${lessonId}-turn-${++sequence}` } });
    const read = async (session: Session): Promise<Session> => (await app.inject(`/api/sessions/${session.id}`)).json();
    const requestBody = () => JSON.parse(aiFetch.mock.calls.at(-1)![1]!.body as string);
    const requestContext = () => {
      const instructions = requestBody().messages[0].content as string;
      return JSON.parse(instructions.slice(instructions.indexOf('\n当前练习数据：') + '\n当前练习数据：'.length));
    };

    const first = await create();
    expect(first.turns[0]!.text).toBe(scenario.opening.jp);
    // An answer outside the stored examples can receive the mock's valid goals;
    // the API must not introduce an exact-answer matching gate.
    expect(lesson.speaking.map(task => task.answer.jp)).not.toContain(alternative);
    const accepted = await send(first);
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json()).toMatchObject({ lessonId, scenarioId: scenario.id, turnCount: 1, status: 'active', completedGoals: scenario.successCriteria });
    expect(accepted.json().turns[1].text).toBe(alternative);
    expect(accepted.json().feedback).toEqual([]);
    const context = requestContext();
    expect(context.lesson).toEqual({ id: lessonId, title: lesson.title, canDo: lesson.canDo, grammar: lesson.grammar, vocabulary: lesson.vocabulary });
    expect(context.scenario).toEqual(scenario);
    expect(context.scenario.targetGrammarIds.every((id: string) => context.lesson.grammar.some((grammar: { id: string }) => grammar.id === id))).toBe(true);
    expect(context.prerequisites).toEqual(lesson.prerequisiteLessonIds.map(id => ({ id, canDo: getLesson(id)!.canDo })));
    expect(context.prerequisites.every((previous: { id: number }) => previous.id < lessonId)).toBe(true);
    expect(context).toMatchObject({ turnNumber: 1, currentTurnUsesHint: false, completedGoals: [] });
    expect(requestBody().messages.at(-1)).toEqual({ role: 'user', content: alternative });
    expect(requestBody().messages[0].content).toContain('接受能完成目标的合理表达变体');
    expect(requestBody().messages[0].content).toContain('最多提出一个问题');

    // Both invented IDs and a genuine ID from a different lesson are rejected.
    const snapshot = await read(first);
    const foreignGrammar = getLesson(lessonId === 1 ? 50 : 1)!.grammar[0]!.id;
    for (const wrongId of [`l${lessonId}-nonexistent`, foreignGrammar]) {
      corrections = [{ ...correction, grammarId: wrongId }];
      const rejected = await send(first, mistaken);
      expect(rejected.statusCode).toBe(502);
      expect(rejected.json().code).toBe('AI_INVALID_RESPONSE');
      expect(await read(first)).toEqual(snapshot);
    }
    corrections = []; replyJa = 'お名前は？お仕事は？';
    const tooManyQuestions = await send(first);
    expect(tooManyQuestions.statusCode).toBe(502);
    expect(tooManyQuestions.json().code).toBe('AI_INVALID_RESPONSE');
    expect(await read(first)).toEqual(snapshot);

    // Current-lesson correction metadata is accepted; hint use stays in context.
    replyJa = 'わかりました。'; corrections = [correction];
    const correctedTurn = await send(first, mistaken, true);
    expect(correctedTurn.statusCode).toBe(200);
    expect(correctedTurn.json().feedback).toEqual([correction]);
    expect(requestContext()).toMatchObject({ turnNumber: 2, currentTurnUsesHint: true });
    corrections = [];
    for (const round of [3, 4]) {
      const response = await send(first);
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ turnCount: round, status: round === 4 ? 'complete' : 'active' });
    }
    const beforeClosedAttempt = aiFetch.mock.calls.length;
    expect((await send(first)).statusCode).toBe(409);
    expect(aiFetch.mock.calls.length).toBe(beforeClosedAttempt);

    // An unfinished mock scenario still stops at six, without invented goals.
    goals = []; endSession = false;
    const unfinished = await create();
    for (let round = 1; round <= 6; round++) {
      replyJa = round === 6 ? '今日はここまでです。' : 'わかりました。';
      const response = await send(unfinished);
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ turnCount: round, status: round === 6 ? 'complete' : 'active', completedGoals: [], feedback: [] });
      expect(requestContext().turnNumber).toBe(round);
    }
    const beforeSeventh = aiFetch.mock.calls.length;
    expect((await send(unfinished)).statusCode).toBe(409);
    expect(aiFetch.mock.calls.length).toBe(beforeSeventh);
  });
});
