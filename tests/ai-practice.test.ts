import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { buildApp, type AppOptions } from '../src/server/app';
import { diceSimilarity, normalizePracticeText, questionFingerprints, samplePracticeGrammar } from '../src/server/ai-practice';
import type { PracticeContent, PracticeCurrent, PracticeKind } from '../src/shared/ai-practice';
import { getLesson } from '../src/content';
import { fixtureKey, provider, wav } from './recordings-fixtures';

const apps: ReturnType<typeof buildApp>[] = [], dirs: string[] = [];
const sentence = { jp: '私は学生です。', kana: 'わたしはがくせいです。', zh: '我是学生。' };
const alternative = { jp: '毎朝、駅まで歩いています。', kana: 'まいあさえきまであるいています。', zh: '我每天早上步行到车站。' };
const dialogue: PracticeContent = { kind: 'dialogue', lines: [sentence, alternative, { jp: '今日は休みです。', kana: 'きょうはやすみです。', zh: '今天休息。' }, { jp: '一緒に映画を見ませんか。', kana: 'いっしょにえいがをみませんか。', zh: '一起看电影好吗？' }], questionZh: '今天有什么安排？', options: ['看电影', '游泳', '读书', '上班'], answerIndex: 0, explanationZh: '对方邀请一起看电影。' };
const scored = (uncertain = false) => ({ text: sentence.jp, summaryZh: '意思清楚。', grammarFeedbackZh: '语法正确。', corrections: [],
  pronunciation: { status: uncertain ? 'uncertain' : 'clear', feedbackZh: uncertain ? '暂时无法判断读音。' : '读音清楚。', issues: [] }, reference: sentence,
  meaningScore: 40, grammarScore: 30, pronunciationScore: uncertain ? null : 28, targetGrammarUsed: true });
function create(options: AppOptions = {}) {
  const dataDir = options.dataDir ?? mkdtempSync(join(tmpdir(), 'nihongo-ai-practice-test-'));
  if (!dirs.includes(dataDir)) dirs.push(dataDir);
  const aiFetch = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
    const context = JSON.parse(JSON.parse(init!.body as string).messages[1].content);
    return provider(context.kind === 'speaking' ? { kind: 'speaking', goalZh: sentence.zh, reference: sentence } : context.kind === 'dialogue' ? dialogue : { kind: 'dictation', sentence });
  });
  const audioFetch = vi.fn<typeof fetch>().mockImplementation(async () => provider(scored()));
  const app = buildApp({ practiceRandom: () => 0, aiFetch, audioFetch, ...options, dataDir }); apps.push(app);
  return { app, dataDir, aiFetch, audioFetch };
}
async function configure(app: ReturnType<typeof buildApp>) {
  await app.inject({ method: 'PATCH', url: '/api/settings', payload: { apiKey: fixtureKey } });
  await app.inject({ method: 'PATCH', url: '/api/speaking/audio-settings', payload: { apiKey: 'sk-ai-practice-audio-key' } });
}
const generate = (app: ReturnType<typeof buildApp>, kind: PracticeKind = 'dictation', clientRequestId = randomUUID(), lessonId = 1) => app.inject({ method: 'POST', url: '/api/ai-practice/questions', payload: { lessonId, kind, clientRequestId } });
async function question(app: ReturnType<typeof buildApp>, kind: PracticeKind = 'dictation', lessonId = 1) {
  const response = await generate(app, kind, randomUUID(), lessonId); expect(response.statusCode, response.body).toBe(200); return response.json<PracticeCurrent>().question!;
}
const answer = (app: ReturnType<typeof buildApp>, id: string, value: string, clientAttemptId = randomUUID()) => app.inject({ method: 'POST', url: `/api/ai-practice/questions/${id}/answer`, payload: { answer: value, clientAttemptId } });
async function recording(_app: ReturnType<typeof buildApp>, _id: string, _lessonId = 1) { return randomUUID(); }
const assess = (app: ReturnType<typeof buildApp>, id: string, _recordingId: string, clientAssessmentId = randomUUID()) => app.inject({ method: 'POST', url: `/api/ai-practice/questions/${id}/assess-audio?clientAssessmentId=${clientAssessmentId}`, headers: { 'content-type': 'audio/wav' }, payload: wav() });
afterEach(async () => {
  vi.useRealTimers();
  for (const app of apps.splice(0)) await app.close();
  for (const dir of dirs.splice(0)) {
    if (dirname(resolve(dir)) !== resolve(tmpdir()) || !basename(dir).startsWith('nihongo-ai-practice-test-')) throw new Error('Unexpected test path');
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('weighted grammar and content identity', () => {
  it.each([[1, .99, 1], [2, .799, 2], [2, .8, 1], [26, .699, 26], [26, .7, 25], [26, .899, 25], [26, .9, 24], [50, .99, 48]])('lesson %i at %f chooses lesson %i', (id, value, expected) => {
    const random = vi.fn().mockReturnValueOnce(value).mockReturnValue(0);
    const result = samplePracticeGrammar(id, random); expect(result.lesson.id).toBe(expected); expect(result.grammar.id).toBe(getLesson(expected)!.grammar[0].id);
  });
  it('normalizes width, punctuation and kana script; compares repeated bigrams correctly', () => {
    expect(normalizePracticeText('ﾜﾀｼ　は、がくせいです！')).toBe(normalizePracticeText(sentence.kana));
    expect(diceSimilarity('aaaa', 'aaab')).toBeCloseTo(2 / 3);
    expect(diceSimilarity('ab', 'xy')).toBe(0); expect(diceSimilarity('a', 'a')).toBe(1);
    const a = questionFingerprints({ kind: 'dictation', sentence });
    const b = questionFingerprints({ kind: 'speaking', goalZh: sentence.zh, reference: { ...sentence, jp: '私 は 学生です！' } });
    expect(a.some(value => b.includes(value))).toBe(true);
  });
});
describe('persistent generation and retry safety', () => {
  it('prioritizes this lesson vocabulary and adds only courses with submitted work', async () => {
    const { app, aiFetch } = create(); await configure(app);
    expect((await app.inject({ method: 'POST', url: '/api/progress', payload: { lessonId: 2, stage: 'understand', cursor: 0, status: 'seen' } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/api/attempts', payload: { lessonId: 1, itemId: getLesson(1)!.speaking[0].id, result: 'again', answer: '学生' } })).statusCode).toBe(200);
    await question(app, 'dictation', 5);
    const messages = JSON.parse(aiFetch.mock.calls[0]![1]!.body as string).messages;
    const context = JSON.parse(messages[1].content);
    expect(new Set(context.vocabulary.map((word: { lessonId: number }) => word.lessonId))).toEqual(new Set([1, 5]));
    expect(messages[0].content).toContain('本课词表'); expect(messages[0].content).toContain('实际练过课程');
  });
  it('bounds a stalled provider by the shared deadline and leaves the original position intact', async () => {
    const { app, aiFetch } = create(); await configure(app); const old = await question(app);
    aiFetch.mockImplementation(async () => new Promise<Response>(() => {}));
    vi.useFakeTimers(); const response = generate(app);
    await vi.waitFor(() => expect(aiFetch).toHaveBeenCalledTimes(2));
    await vi.advanceTimersByTimeAsync(35001);
    expect((await response).json().code).toBe('PRACTICE_TIMEOUT'); vi.useRealTimers();
    expect((await app.inject('/api/ai-practice/current?lessonId=1&kind=dictation')).json().question.id).toBe(old.id);
  });
  it('does not generate when restoring an empty position, and clearly reports a missing key', async () => {
    const { app, aiFetch } = create(); expect((await app.inject('/api/ai-practice/current?lessonId=1&kind=dictation')).json()).toEqual({ question: null, attempt: null });
    expect(aiFetch).not.toHaveBeenCalled(); expect((await generate(app)).json().code).toBe('PRACTICE_NOT_CONFIGURED');
  });
  it('merges concurrent generation and reuses successful IDs without altering original progress', async () => {
    const { app, aiFetch } = create(); await configure(app); const id = randomUUID();
    const responses = await Promise.all([generate(app, 'dictation', id), generate(app, 'dictation', id)]);
    expect(responses.every(response => response.statusCode === 200)).toBe(true); expect(aiFetch).toHaveBeenCalledTimes(1);
    expect((await generate(app, 'dictation', id)).json().question.id).toBe(id);
    expect((await generate(app, 'speaking', id)).statusCode).toBe(409);
    expect((await app.inject('/api/bootstrap')).json().progress).toEqual([]);
  });
  it('checks concurrent different request IDs before committing identical sentences', async () => {
    const { app, aiFetch } = create(); await configure(app);
    const responses = await Promise.all([generate(app), generate(app)]);
    expect(responses.map(response => response.statusCode).sort()).toEqual([200, 502]);
    expect((await app.inject('/api/backup')).json().aiQuestions).toHaveLength(1); expect(aiFetch).toHaveBeenCalledTimes(3);
  });
  it('rejects cross-mode duplicates permanently, retries once, and keeps the current question on failure', async () => {
    const { app, aiFetch } = create(); await configure(app); const old = await question(app);
    expect((await generate(app, 'speaking')).statusCode).toBe(502); expect(aiFetch).toHaveBeenCalledTimes(3);
    expect((await generate(app)).statusCode).toBe(502);
    expect((await app.inject('/api/ai-practice/current?lessonId=1&kind=dictation')).json().question.id).toBe(old.id);
    aiFetch.mockImplementationOnce(async () => provider({ kind: 'dictation', sentence: alternative }));
    const next = await question(app); expect(next.id).not.toBe(old.id);
    const backup = (await app.inject('/api/backup')).json(); expect(backup.aiQuestions).toHaveLength(2);
  });
  it('rejects near duplicates even when their exact fingerprints differ', async () => {
    const { app, aiFetch } = create(); await configure(app);
    const original = { jp: '私は毎朝駅の近くの図書館で新聞を読んでから学校に行きます。', kana: 'わたしはまいあさえきのちかくのとしょかんでしんぶんをよんでからがっこうにいきます。', zh: '我每天早上在车站附近的图书馆看报，然后去学校。' };
    aiFetch.mockResolvedValueOnce(provider({ kind: 'dictation', sentence: original })); await question(app);
    aiFetch.mockImplementation(async () => provider({ kind: 'dictation', sentence: { ...original, jp: original.jp.replace('毎朝', '毎晩'), kana: original.kana.replace('まいあさ', 'まいばん') } }));
    expect((await generate(app)).json().code).toBe('PRACTICE_INVALID_RESPONSE');
  });
  it('restores positions and fingerprints after a restart', async () => {
    const first = create(); await configure(first.app); const old = await question(first.app); await first.app.close(); apps.splice(apps.indexOf(first.app), 1);
    const second = create({ dataDir: first.dataDir });
    expect((await second.app.inject('/api/ai-practice/current?lessonId=1&kind=dictation')).json().question.id).toBe(old.id);
    expect((await generate(second.app)).statusCode).toBe(502);
  });
  it('regenerates malformed dialogue candidates but never commits a duplicate-option question', async () => {
    const { app, aiFetch } = create(); await configure(app);
    aiFetch.mockResolvedValueOnce(provider({ ...dialogue, options: ['重复', '重复', '其他', '另一个'] }));
    const result = await question(app, 'dialogue'); expect(result.content.kind).toBe('dialogue'); expect(aiFetch).toHaveBeenCalledTimes(2);
  });
});
describe('dictation and dialogue answers', () => {
  it('accepts complete kana without a cloud call, rejects ID reuse, and marks subsequent answers assisted', async () => {
    const { app, aiFetch } = create(); await configure(app); const item = await question(app); const id = randomUUID();
    const first = await answer(app, item.id, 'わたし は がくせいです！', id); expect(first.json()).toMatchObject({ correct: true, usedHint: false });
    expect((await answer(app, item.id, 'わたし は がくせいです！', id)).json().id).toBe(id); expect(aiFetch).toHaveBeenCalledTimes(1);
    expect((await answer(app, item.id, '私は学生です。', id)).statusCode).toBe(409);
    expect((await answer(app, item.id, sentence.jp)).json().usedHint).toBe(true);
  });
  it('sends mixed kana/kanji to the text judge, and requires completeness rather than accepting paraphrases', async () => {
    const { app, aiFetch } = create(); await configure(app); const item = await question(app);
    aiFetch.mockResolvedValueOnce(provider({ correct: true, feedbackZh: '假名和汉字写法等价。' }));
    expect((await answer(app, item.id, '私はがくせいです。')).json().correct).toBe(true);
    aiFetch.mockResolvedValueOnce(provider({ correct: false, feedbackZh: '漏写了「私は」。' }));
    expect((await answer(app, item.id, '学生です。')).json().correct).toBe(false);
    expect(JSON.parse(aiFetch.mock.calls[2]![1]!.body as string).messages[0].content).toContain('同义改写也不正确');
  });
  it('judges a dialogue locally and restores submitted feedback', async () => {
    const { app, aiFetch } = create(); await configure(app); const item = await question(app, 'dialogue');
    expect((await answer(app, item.id, '9')).statusCode).toBe(400);
    expect((await answer(app, item.id, '2')).json().correct).toBe(false);
    expect((await answer(app, item.id, '0')).json()).toMatchObject({ correct: true, usedHint: true });
    expect(aiFetch).toHaveBeenCalledTimes(1);
    expect((await app.inject('/api/ai-practice/current?lessonId=1&kind=dialogue')).json().attempt.correct).toBe(true);
  });
});
describe('raw audio scoring and history', () => {
  it('binds raw WAV to the generated task, computes totals, merges retries, and preserves feedback after deletion', async () => {
    const { app, aiFetch, audioFetch } = create(); await configure(app); const item = await question(app, 'speaking'); const id = await recording(app, item.id); const scoreId = randomUUID();
    const scores = await Promise.all([assess(app, item.id, id, scoreId), assess(app, item.id, id, scoreId)]);
    expect(scores[0].json()).toMatchObject({ totalScore: 98, usedHint: false }); expect(audioFetch).toHaveBeenCalledTimes(1); expect(aiFetch).toHaveBeenCalledTimes(1);
    const body = JSON.parse(audioFetch.mock.calls[0]![1]!.body as string);
    expect(body.messages[1].content[1].input_audio.data).toBe(`data:audio/wav;base64,${wav().toString('base64')}`);
    expect(body.messages[0].content).toContain('meaningScore');
    expect((await app.inject('/api/recordings?lessonId=1')).statusCode).toBe(410);
    expect((await assess(app, item.id, id, scoreId)).json().totalScore).toBe(98);
    expect((await assess(app, item.id, id)).json().usedHint).toBe(true);
    expect((await app.inject('/api/ai-practice/current?lessonId=1&kind=speaking')).json().attempt.totalScore).toBe(98);

  });
  it('does not force a pronunciation or total score when uncertain, and marks a re-recording assisted', async () => {
    const { app, audioFetch } = create(); await configure(app); const item = await question(app, 'speaking');
    audioFetch.mockImplementation(async () => provider(scored(true)));
    expect((await assess(app, item.id, await recording(app, item.id))).json()).toMatchObject({ totalScore: null, result: { pronunciationScore: null } });
    expect((await assess(app, item.id, await recording(app, item.id))).json().usedHint).toBe(true);
  });
  it('accepts previous-lesson grammar feedback and rejects mismatched recordings and impossible scores', async () => {
    const { app, audioFetch } = create({ practiceRandom: () => .75 }); await configure(app); const item = await question(app, 'speaking', 26);
    expect(item.grammarSourceLessonId).toBe(25); const id = await recording(app, item.id, 26);
    audioFetch.mockResolvedValueOnce(provider({ ...scored(), corrections: [{ goal: sentence.zh, original: '学生', corrected: sentence, explanation: '语法建议。', grammarId: item.grammarId }] }));
    expect((await assess(app, item.id, id)).statusCode).toBe(200);
    audioFetch.mockResolvedValueOnce(provider({ ...scored(), meaningScore: 41 })); expect((await assess(app, item.id, id)).statusCode).toBe(502);
    const wrong = await app.inject({ method: 'POST', url: `/api/recordings?lessonId=25&context=ai-speak&itemId=${item.id}&clientRecordingId=${randomUUID()}`, headers: { 'content-type': 'audio/wav' }, payload: wav() }); expect(wrong.statusCode).toBe(410);
  });
  it('does not save a zero score for unintelligible audio', async () => {
    const { app, audioFetch } = create(); await configure(app); const item = await question(app, 'speaking');
    audioFetch.mockResolvedValueOnce(provider({ unassessable: true, reasonZh: '听不清' }));
    expect((await assess(app, item.id, await recording(app, item.id))).statusCode).toBe(422);
    expect((await app.inject('/api/ai-practice/current?lessonId=1&kind=speaking')).json().attempt).toBeNull();
  });
});
describe('v3 backup compatibility', () => {
  it('roundtrips generated tasks, audio scores and fingerprints while protecting old data on invalid references', async () => {
    const { app, aiFetch } = create(); await configure(app); const item = await question(app, 'speaking'); const id = await recording(app, item.id); await assess(app, item.id, id);
    const backup = (await app.inject('/api/backup')).json(); expect(backup.version).toBe(4); expect(JSON.stringify(backup)).not.toContain(fixtureKey);
    expect((await app.inject({ method: 'POST', url: '/api/restore', payload: { backup } })).statusCode).toBe(200);
    expect((await app.inject('/api/ai-practice/current?lessonId=1&kind=speaking')).json().attempt.totalScore).toBe(98);
    for (const mutate of [(copy: typeof backup) => { copy.aiQuestions[0].grammarSourceLessonId = 50; }, (copy: typeof backup) => { copy.aiPositions[0].questionId = randomUUID(); }, (copy: typeof backup) => { copy.aiAttempts[0].recordingId = randomUUID(); }, (copy: typeof backup) => { copy.aiQuestions[0].fingerprints = ['a'.repeat(64)]; }]) {
      const copy = structuredClone(backup); mutate(copy); expect((await app.inject({ method: 'POST', url: '/api/restore', payload: { backup: copy } })).statusCode).toBe(400);
      expect((await app.inject('/api/ai-practice/current?lessonId=1&kind=speaking')).json().question.id).toBe(item.id);
    }
    aiFetch.mockImplementation(async () => provider({ kind: 'dictation', sentence })); expect((await generate(app)).statusCode).toBe(502);
  });
  it.each([1, 2])('imports legacy v%i and retains credentials', async version => {
    const { app } = create(); await configure(app);
    const { aiQuestions: _q, aiAttempts: _a, aiPositions: _p, recordings: _r, assessments: _s, vocabularyMastery: _v, ...base } = (await app.inject('/api/backup')).json();
    await question(app);
    const backup = version === 1 ? { ...base, version } : { ...base, version, recordings: [], assessments: [] };
    expect((await app.inject({ method: 'POST', url: '/api/restore', payload: { backup } })).statusCode).toBe(200);
    expect((await app.inject('/api/ai-practice/current?lessonId=1&kind=dictation')).json().question).toBeNull();
    expect((await app.inject('/api/settings')).json().hasApiKey).toBe(true);
  });
});
