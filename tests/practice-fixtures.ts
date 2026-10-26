import { afterEach, expect, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { buildApp, type AppOptions } from '../src/server/app';
import type { PracticeCurrent, PracticeKind } from '../src/shared/ai-practice';
import { fixtureKey, provider, wav } from './recordings-fixtures';
export const reference = { jp: '私は学生です。', kana: 'わたしはがくせいです。', zh: '我是学生。' };
export const audioKey = 'sk-direct-audio-test-key';
export const scoreResult = () => ({ text: reference.jp, summaryZh: '意思清楚。', grammarFeedbackZh: '语法正确。', corrections: [], pronunciation: { status: 'clear', feedbackZh: '读音清楚。', issues: [] }, reference, meaningScore: 40, grammarScore: 30, pronunciationScore: 28, targetGrammarUsed: true });
const apps: ReturnType<typeof buildApp>[] = [], dirs = new Set<string>();
export function createPractice(options: AppOptions = {}) {
  const dataDir = options.dataDir ?? mkdtempSync(join(tmpdir(), 'nihongo-direct-practice-')); dirs.add(dataDir);
  const aiFetch = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
    const context = JSON.parse(JSON.parse(init!.body as string).messages[1].content);
    return provider(context.kind === 'speaking' ? { kind: 'speaking', goalZh: reference.zh, reference } : { kind: 'dictation', sentence: reference });
  });
  const audioFetch = vi.fn<typeof fetch>().mockImplementation(async () => provider(scoreResult()));
  const app = buildApp({ dataDir, practiceRandom: () => 0, aiFetch, audioFetch, ...options }); apps.push(app);
  return { app, dataDir, aiFetch, audioFetch };
}
export async function closePractice(app: ReturnType<typeof buildApp>) { await app.close(); apps.splice(apps.indexOf(app), 1); }
export async function configurePractice(app: ReturnType<typeof buildApp>) {
  expect((await app.inject({ method: 'PATCH', url: '/api/settings', payload: { apiKey: fixtureKey } })).statusCode).toBe(200);
  expect((await app.inject({ method: 'PATCH', url: '/api/speaking/audio-settings', payload: { apiKey: audioKey } })).statusCode).toBe(200);
}
export async function generatePractice(app: ReturnType<typeof buildApp>, kind: PracticeKind = 'speaking', lessonId = 1) {
  const response = await app.inject({ method: 'POST', url: '/api/ai-practice/questions', payload: { lessonId, kind, clientRequestId: randomUUID() } });
  expect(response.statusCode, response.body).toBe(200); return response.json<PracticeCurrent>().question!;
}
export function submitAudio(app: ReturnType<typeof buildApp>, questionId: string, clientAssessmentId = randomUUID(), bytes = wav(), extraQuery = '') {
  return app.inject({ method: 'POST', url: `/api/ai-practice/questions/${questionId}/assess-audio?clientAssessmentId=${clientAssessmentId}${extraQuery}`, headers: { 'content-type': 'audio/wav' }, payload: bytes });
}
afterEach(async () => {
  vi.useRealTimers(); for (const app of apps.splice(0)) await app.close();
  for (const dir of dirs) {
    if (dirname(resolve(dir)) !== resolve(tmpdir()) || !basename(dir).startsWith('nihongo-direct-practice-')) throw new Error('Unexpected test path');
    rmSync(dir, { recursive: true, force: true });
  }
  dirs.clear();
});
