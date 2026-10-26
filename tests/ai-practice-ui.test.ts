import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Route } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { createServer, type ViteDevServer } from 'vite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { lessons1 } from '../src/content/lessons-01-25';
import type { PracticeAttempt, PracticeCurrent, PracticeKind, PracticeQuestion } from '../src/shared/ai-practice';

let browser: Browser, vite: ViteDevServer, origin: string, cacheDir: string;
const lesson = lessons1[13];
const sentence = { jp: '少し待ってください。', kana: 'すこしまってください。', zh: '请等一下。' };
const harness = `
import React from 'react'; import { createRoot } from 'react-dom/client';
import { Study } from '/src/client/Study.tsx'; import { useSpeech } from '/src/client/speech.ts';
import { lessons1 } from '/src/content/lessons-01-25.ts'; import '/src/client/style.css';
const bootstrap={deployment:'web',settings:{currentLessonId:14,dailyMinutes:15,largeText:false,furigana:true,autoplay:false,model:'deepseek-flash',hasApiKey:true,setupComplete:true},progress:[{lessonId:14,stage:'listen',cursor:0,status:'seen',updatedAt:'2026-10-06T00:00:00Z'}],dueReviews:[],activeSession:null,totals:{sessions:0,reviews:0,independent:0},speech:{ready:false,modelReady:false,binaryReady:false,message:'not installed'}};
function Harness(){ const speech=useSpeech(message=>window.notices.push(message)); return <main style={{maxWidth:1000,margin:'auto',padding:18}}><h1>AI练习测试</h1><Study lesson={lessons1[13]} bootstrap={bootstrap} speech={speech} notice={message=>window.notices.push(message)} refresh={async()=>{}}/></main> }
createRoot(document.getElementById('root')).render(<Harness/>);`;
beforeAll(async () => {
  cacheDir = await mkdtemp(join(tmpdir(), 'nihongo-ai-practice-ui-'));
  vite = await createServer({ configFile: false, root: process.cwd(), cacheDir,
    optimizeDeps: { include: ['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime', 'react/jsx-dev-runtime', 'lucide-react'], noDiscovery: true },
    server: { host: '127.0.0.1', port: 0 }, plugins: [{ name: 'ai-practice-ui-test', resolveId(id) { if (id === '/__ai-practice.tsx') return id; }, load(id) { if (id === '/__ai-practice.tsx') return harness; } }] });
  await vite.listen(); const address = vite.httpServer!.address(); if (!address || typeof address === 'string') throw new Error('No port'); origin = `http://127.0.0.1:${address.port}`;
  browser = await chromium.launch({ headless: true, ...(process.platform === 'win32' ? { channel: 'msedge' } : {}) });
}, 30000);
afterAll(async () => { await browser?.close(); await vite?.close(); if (dirname(resolve(cacheDir)) === resolve(tmpdir()) && basename(cacheDir).startsWith('nihongo-ai-practice-ui-')) await rm(cacheDir, { recursive: true, force: true }); });
function makeQuestion(kind: PracticeKind, id: string): PracticeQuestion {
  return { id, lessonId: 14, grammarSourceLessonId: 14, grammarId: lesson.grammar[0].id, grammarTitle: lesson.grammar[0].title, fingerprints: ['a'.repeat(64)], model: 'deepseek-flash', createdAt: '2026-10-06T00:00:00Z',
    content: kind === 'vocabulary' ? { kind, wordId: 'l14-v1', word: '待ちます', reading: 'まちます', meaning: '等待' } : kind === 'dictation' ? { kind, sentence } : kind === 'speaking' ? { kind, goalZh: sentence.zh, reference: sentence } : {
      kind, lines: [sentence, sentence, sentence, sentence], questionZh: '对方希望你做什么？', options: ['等一下', '离开', '吃饭', '游泳'], answerIndex: 0, explanationZh: '对方说「少し待ってください」。',
    } };
}
function score(questionId: string, recordingId: string, id: string): Extract<PracticeAttempt, { kind: 'speaking' }> {
  return { id, questionId, lessonId: 14, kind: 'speaking', recordingId, createdAt: '2026-10-06T00:00:00Z', usedHint: false, latencyMs: 1000, totalScore: 96,
    result: { text: sentence.jp, summaryZh: '意思表达清楚。', grammarFeedbackZh: '目标语法使用正确。', corrections: [], reference: sentence,
      pronunciation: { status: 'clear', feedbackZh: '发音清楚。', issues: [] }, meaningScore: 40, grammarScore: 30, pronunciationScore: 26, targetGrammarUsed: true } };
}
function audioRequest(route: Route) {
  const url = new URL(route.request().url());
  expect(route.request().postDataBuffer()?.subarray(0, 4).toString()).toBe('RIFF');
  return { questionId: url.pathname.split('/').at(-2)!, clientAssessmentId: url.searchParams.get('clientAssessmentId')!, recordingId: '' };
}
async function setup(options: { generate?: (route: Route, index: number) => Promise<void>; prefetch?: (route: Route, index: number) => Promise<void>; activate?: (route: Route, index: number) => Promise<void>; assess?: (route: Route) => Promise<void>; ignoreAbort?: boolean } = {}) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await context.addInitScript(({ ignoreAbort }) => {
    Object.assign(window, { notices: [], said: [], stoppedTracks: 0 });
    Object.defineProperty(window, 'speechSynthesis', { configurable: true, value: { getVoices: () => [{ localService: true, lang: 'ja-JP' }], cancel() {}, resume() {}, pause() {}, addEventListener() {}, removeEventListener() {},
      speak(utterance: SpeechSynthesisUtterance) { (window as unknown as { said: string[] }).said.push(utterance.text); queueMicrotask(() => utterance.onend?.({} as SpeechSynthesisEvent)); } } });
    Object.defineProperty(window, 'SpeechSynthesisUtterance', { configurable: true, value: class { text: string; onend = null; constructor(text: string) { this.text = text; } } });
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: async () => ({ getTracks: () => [{ stop() { (window as unknown as { stoppedTracks: number }).stoppedTracks++; } }] }) } });
    class Capture { static isTypeSupported(mime: string) { return mime === 'audio/webm'; } state = 'inactive'; mimeType = 'audio/webm'; onstop: (() => void) | null = null; ondataavailable: ((event: { data: Blob }) => void) | null = null;
      start() { this.state = 'recording'; } stop() { this.state = 'inactive'; queueMicrotask(() => { this.ondataavailable?.({ data: new Blob(['Japanese recording'], { type: this.mimeType }) }); this.onstop?.(); }); } }
    Object.defineProperty(window, 'MediaRecorder', { configurable: true, value: Capture });
    Object.defineProperty(window, 'AudioContext', { configurable: true, value: class { decodeAudioData() { return Promise.resolve({ duration: 3 }); } close() { return Promise.resolve(); } } });
    Object.defineProperty(window, 'OfflineAudioContext', { configurable: true, value: class { destination = {}; frames: number; constructor(_channels: number, frames: number) { this.frames = frames; } createBufferSource() { return { connect() {}, start() {} }; } startRendering() { return Promise.resolve({ getChannelData: () => new Float32Array(this.frames).fill(.1) }); } } });
    if (ignoreAbort) { const original = window.fetch.bind(window); window.fetch = (input, init) => original(input, String(input).includes('/ai-practice/') ? { ...init, signal: undefined } : init); }
  }, { ignoreAbort: options.ignoreAbort ?? false });
  await context.route('**/*', route => new URL(route.request().url()).origin !== origin ? route.abort('blockedbyclient') : route.fallback());
  const page = await context.newPage(); page.setDefaultTimeout(6000);
  const positions = new Map<string, PracticeCurrent>(), generation: Record<string, unknown>[] = [], answers: Record<string, unknown>[] = [], assessments: Record<string, unknown>[] = [], uploads: URL[] = [], transcribes: string[] = [];
  const queued = new Map<string, PracticeCurrent>(), prefetched: Record<string, unknown>[] = [], activations: string[] = [];
  await page.route('**/__ai-practice-test', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html lang="zh-CN"><head><title>AI练习</title></head><body><div id="root"></div><script type="module" src="/__ai-practice.tsx"></script></body></html>' }));
  await page.route('**/api/ai-practice/current?*', route => route.fulfill({ json: positions.get(new URL(route.request().url()).searchParams.get('kind')!) ?? { question: null, attempt: null } }));
  await page.route('**/api/ai-practice/questions', async route => {
    const body = route.request().postDataJSON(); generation.push(body);
    if (options.generate) return options.generate(route, generation.length);
    const value = { question: makeQuestion(body.kind, body.clientRequestId), attempt: null }; positions.set(body.kind, value); await route.fulfill({ json: value });
  });
  await page.route('**/api/ai-practice/prefetch', async route => {
    const body = route.request().postDataJSON(); prefetched.push(body);
    if (options.prefetch) return options.prefetch(route, prefetched.length);
    const value = { question: makeQuestion(body.kind, body.clientRequestId), attempt: null }; queued.set(body.clientRequestId, value); await route.fulfill({ json: value });
  });
  await page.route('**/api/ai-practice/questions/*/activate', async route => {
    const id = new URL(route.request().url()).pathname.split('/').at(-2)!; activations.push(id);
    if (options.activate) return options.activate(route, activations.length);
    const value = queued.get(id); if (!value?.question) return route.fulfill({ status: 404, json: { error: '没有找到题目。' } });
    positions.set(value.question.content.kind, value); await route.fulfill({ json: value });
  });
  await page.route('**/api/ai-practice/questions/*/answer', async route => {
    const body = route.request().postDataJSON(); body.answer = body.answer.trim(); answers.push(body); const id = route.request().url().split('/').at(-2)!;
    const position = [...positions.values()].find(item => item.question?.id === id)!; const kind = position.question!.content.kind;
    const audioScore = score(id, '', body.clientAttemptId);
    const value = kind === 'speaking' ? { ...audioScore, recordingId: undefined, inputMode: 'text', answer: body.answer, totalScore: null,
      result: { ...audioScore.result, text: body.answer, pronunciationScore: null, pronunciation: { status: 'uncertain', feedbackZh: '拼写不评估发音。', issues: [] } } } as PracticeAttempt
      : { id: body.clientAttemptId, questionId: id, lessonId: 14, kind, answer: body.answer, correct: kind === 'dialogue' ? body.answer === '0' : true, feedbackZh: '答案检查完成。', usedHint: false, createdAt: '2026-10-06T00:00:00Z', latencyMs: 20 } as PracticeAttempt;
    position.attempt = value; await route.fulfill({ json: value });
  });
  await page.route('**/api/ai-practice/questions/*/assess-audio?*', async route => {
    const body = audioRequest(route); assessments.push(body); if (options.assess) return options.assess(route);
    const id = body.questionId; const position = [...positions.values()].find(item => item.question?.id === id)!;
    const kind = position.question!.content.kind;
    const value = kind === 'speaking' ? score(id, body.recordingId, body.clientAssessmentId) : {
      id: body.clientAssessmentId, questionId: id, lessonId: 14, kind, answer: sentence.jp,
      inputMode: 'audio', correct: true, feedbackZh: '录音回答检查完成。', usedHint: false, createdAt: '2026-10-06T00:00:00Z', latencyMs: 100,
    } as PracticeAttempt;
    position.attempt = value; await route.fulfill({ json: value });
  });
  await page.route('**/api/speaking/audio-settings', route => route.fulfill({ json: { provider: 'qwen', model: 'qwen3.8-omni-flash', workspaceId: '', hasApiKey: true } }));
  await page.route('**/api/voice/settings', route => route.fulfill({ json: { provider: 'system', speed: 1 } }));
  await page.route('**/api/progress', route => route.fulfill({ json: { ...route.request().postDataJSON(), updatedAt: '2026-10-06T00:00:00Z' } }));
  await page.route('**/api/recordings**', async route => {
    if (route.request().method() === 'GET') return route.fulfill({ json: [] });
    if (route.request().method() === 'PATCH') return route.fulfill({ json: {} });
    const url = new URL(route.request().url()); uploads.push(url); expect(url.searchParams.get('context')).toBe('ai-speak'); expect(route.request().postDataBuffer()?.subarray(0, 4).toString()).toBe('RIFF');
    return route.fulfill({ json: { id: url.searchParams.get('clientRecordingId'), durationMs: 3000 } });
  });
  await page.route('**/api/speech/transcribe', route => { transcribes.push(route.request().url()); return route.abort(); });
  await page.goto(origin + '/__ai-practice-test'); await page.getByRole('heading', { name: 'AI练习测试' }).waitFor();
  const enter = async (speaking = false) => { if (speaking) await page.locator('.stage-tabs').getByRole('button', { name: '口语', exact: false }).click(); if (!speaking) await page.getByRole('button', { name: 'AI练习', exact: true }).click(); await page.locator('.ai-practice .study-navigation .button').waitFor({ state: 'visible' }); };
  const start = async () => { await page.getByRole('button', { name: '开始练习', exact: true }).click(); await page.getByRole('button', { name: '下一题', exact: true }).waitFor(); };
  return { context, page, generation, prefetched, activations, queued, answers, assessments, uploads, transcribes, positions, enter, start };
}
describe('AI practice within the actual Study page', () => {
  it.each(['dictation', 'dialogue', 'speaking', 'vocabulary'] as const)('keeps five future %s questions without advancing, and refills one after consuming one', async kind => {
    const value = await setup(); const { page, context } = value;
    try {
      if (kind === 'speaking') await value.enter(true);
      else if (kind === 'vocabulary') { await page.locator('.stage-tabs').getByRole('button', { name: '单词', exact: true }).click(); await page.getByRole('button', { name: 'AI练习', exact: true }).click(); }
      else { await value.enter(); if (kind === 'dialogue') await page.getByRole('button', { name: '对话听力', exact: true }).click(); }
      expect(value.prefetched).toHaveLength(0);
      await value.start(); await expect.poll(() => value.prefetched.length).toBe(5);
      const firstId = value.generation[0].clientRequestId;
      const bufferedId = value.prefetched[0].clientRequestId;
      expect(value.positions.get(kind)?.question?.id).toBe(firstId);
      expect(value.activations).toEqual([]);
      await page.clock.install(); await page.clock.fastForward(60000);
      expect(value.prefetched).toHaveLength(5);
      await page.getByRole('button', { name: '下一题', exact: true }).click();
      await expect.poll(() => value.activations.length).toBe(1);
      await expect.poll(() => value.prefetched.length).toBe(6);
      expect(value.activations[0]).toBe(bufferedId);
      expect(value.positions.get(kind)?.question?.id).toBe(bufferedId);
      expect(value.generation).toHaveLength(1);
      await page.clock.fastForward(60000); expect(value.prefetched).toHaveLength(6);
    } finally { await context.close(); }
  });
  it('allows typing and grading while the next question is still being prepared', async () => {
    let release!: () => void; const gate = new Promise<void>(done => { release = done; });
    const value = await setup({ prefetch: async (route, index) => {
      const body = route.request().postDataJSON(); if (index === 1) await gate;
      const current = { question: makeQuestion(body.kind, body.clientRequestId), attempt: null };
      value.queued.set(body.clientRequestId, current); await route.fulfill({ json: current });
    } }); const { page, context } = value;
    try {
      await value.enter(); await value.start(); await expect.poll(() => value.prefetched.length).toBe(1);
      const field = page.locator('textarea'); expect(await field.isEnabled()).toBe(true);
      await field.fill(sentence.jp); await field.press('Enter');
      await page.locator('.answer-feedback').waitFor();
      expect(value.answers).toHaveLength(1); expect(value.activations).toEqual([]);
      expect(value.positions.get('dictation')?.question?.id).toBe(value.generation[0].clientRequestId);
      release(); await expect.poll(() => value.prefetched.length).toBe(5);
      expect(await field.inputValue()).toBe(sentence.jp);
      expect(await page.locator('.answer-feedback').innerText()).toContain('答案检查完成。');
      expect(value.activations).toEqual([]);
    } finally { release(); await context.close(); }
  });
  it('pauses a failed background refill, preserves the current draft and retries with the same request id', async () => {
    const value = await setup({ prefetch: async (route, index) => {
      if (index === 1) return route.fulfill({ status: 503, json: { error: '后续题目暂时不可用', code: 'PRACTICE_UNAVAILABLE' } });
      const body = route.request().postDataJSON(); const current = { question: makeQuestion(body.kind, body.clientRequestId), attempt: null };
      value.queued.set(body.clientRequestId, current); await route.fulfill({ json: current });
    } }); const { page, context } = value;
    try {
      await value.enter(); await value.start(); await page.locator('textarea').fill('まだ考えています。');
      await expect.poll(() => value.prefetched.length).toBe(1);
      expect(await page.getByText('后续题目暂时不可用', { exact: false }).count()).toBe(0);
      await page.clock.install(); await page.clock.fastForward(60000);
      expect(value.prefetched).toHaveLength(1); expect(value.activations).toEqual([]);
      expect(await page.locator('textarea').inputValue()).toBe('まだ考えています。');
      await page.getByRole('button', { name: '下一题', exact: true }).click();
      await expect.poll(() => value.activations.length).toBe(1);
      expect(value.prefetched[1].clientRequestId).toBe(value.prefetched[0].clientRequestId);
      await expect.poll(() => page.locator('textarea').inputValue()).toBe('');
      expect(value.positions.get('dictation')?.question?.id).toBe(value.prefetched[0].clientRequestId);
    } finally { await context.close(); }
  });
  it('ignores a late background result after changing listening modes', async () => {
    let release!: () => void; const gate = new Promise<void>(done => { release = done; });
    const value = await setup({ ignoreAbort: true, prefetch: async route => {
      const body = route.request().postDataJSON(); if (body.kind === 'dictation') await gate;
      const current = { question: makeQuestion(body.kind, body.clientRequestId), attempt: null };
      value.queued.set(body.clientRequestId, current); await route.fulfill({ json: current });
    } }); const { page, context } = value;
    try {
      await value.enter(); await value.start(); await expect.poll(() => value.prefetched.length).toBe(1);
      await page.getByRole('button', { name: '对话听力', exact: true }).click(); await value.start();
      await expect.poll(() => value.prefetched.filter(item => item.kind === 'dialogue').length).toBe(5);
      release(); await page.clock.install(); await page.clock.fastForward(60000);
      expect(value.prefetched.filter(item => item.kind === 'dictation')).toHaveLength(1);
      expect(value.positions.get('dialogue')?.question?.id).toBe(value.generation[1].clientRequestId);
      expect(await page.locator('.ai-practice .answer-choices button').count()).toBe(4);
      expect(value.activations).toEqual([]);
    } finally { release(); await context.close(); }
  });
  it('skips a vocabulary candidate mastered after prefetch before showing the next question', async () => {
    const value = await setup({ activate: async (route, index) => {
      if (index === 1) return route.fulfill({ json: { question: null, attempt: null } });
      const id = new URL(route.request().url()).pathname.split('/').at(-2)!;
      const current = value.queued.get(id)!; value.positions.set('vocabulary', current); await route.fulfill({ json: current });
    } }); const { page, context } = value;
    try {
      await page.locator('.stage-tabs').getByRole('button', { name: '单词', exact: true }).click(); await page.getByRole('button', { name: 'AI练习', exact: true }).click();
      await value.start(); await expect.poll(() => value.prefetched.length).toBe(5);
      const usableId = value.prefetched[1].clientRequestId;
      await page.getByRole('button', { name: '下一题', exact: true }).click();
      await expect.poll(() => value.activations.length).toBe(2);
      await expect.poll(() => value.prefetched.length).toBe(7);
      expect(value.positions.get('vocabulary')?.question?.id).toBe(usableId);
      expect(value.activations).toEqual([value.prefetched[0].clientRequestId, usableId]);
      expect(value.generation).toHaveLength(1);
    } finally { await context.close(); }
  });
  it('toggles word mastery, refreshes the percentage and counts, and preserves failures', async () => {
    const value = await setup(); const { page, context } = value;
    const word = { id: 'l14-v1', lessonId: 14, word: '待ちます', reading: 'まちます', meaning: '等待', partOfSpeech: '动词' };
    let mastered = false, fail = false;
    const content = () => ({ lessonId: 14, complete: true, words: [word], mastery: [{ wordId: word.id, mastered, correctCount: 0 }] });
    try {
      await page.route('**/api/lessons/14/vocabulary', route => route.fulfill({ json: content() }));
      await page.route('**/api/lessons/14/vocabulary/*/mastery', route => {
        if (fail) return route.fulfill({ status: 500, json: { error: '保存失败，请重试。' } });
        mastered = route.request().postDataJSON().mastered; return route.fulfill({ json: content() });
      });
      await page.route('**/api/ai-practice/mastery?*', route => route.fulfill({ json: { modules: { vocabulary: { count: Number(mastered), total: 1, score: mastered ? 100 : 0, provisional: false } } } }));
      await page.locator('.stage-tabs').getByRole('button', { name: '单词', exact: true }).click();
      const toggle = page.getByRole('switch', { name: '待ちます · 已掌握' });
      await toggle.waitFor(); expect(await toggle.isChecked()).toBe(false);
      await toggle.click(); await expect.poll(() => toggle.isChecked()).toBe(true);
      await expect.poll(() => page.locator('.charge-caption').innerText()).toContain('1 / 1 · 100%');
      expect(await page.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('100');
      await page.reload(); await page.locator('.stage-tabs').getByRole('button', { name: '单词', exact: true }).click();
      await toggle.waitFor(); expect(await toggle.isChecked()).toBe(true);
      fail = true; await toggle.click(); await page.getByRole('alert').waitFor(); expect(await toggle.isChecked()).toBe(true);
      fail = false; await toggle.click(); await expect.poll(() => toggle.isChecked()).toBe(false);
      await expect.poll(() => page.locator('.charge-caption').innerText()).toContain('0 / 1 · 0%');
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.addStyleTag({ content: ':root{font-size:200%!important}' });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    } finally { await context.close(); }
  });
  it('shows a completed vocabulary state without requesting more questions', async () => {
    const value = await setup(); const { page, context } = value;
    try {
      await page.route('**/api/ai-practice/current?*', route => route.fulfill({ json: { question: null, attempt: null, completed: true } }));
      await page.locator('.stage-tabs').getByRole('button', { name: '单词', exact: true }).click();
      await page.getByRole('button', { name: 'AI练习', exact: true }).click();
      await page.getByText('本单元单词已全部掌握！可在单词表中取消勾选，重新练习。').waitFor();
      expect(await page.getByRole('button', { name: '开始练习', exact: true }).isDisabled()).toBe(true);
      expect(value.generation).toHaveLength(0);
      expect(value.prefetched).toHaveLength(0);
    } finally { await context.close(); }
  });
  it('supports speaking spelling, preserves drafts across input modes and restores the submitted text and score', async () => {
    const value = await setup({ generate: async route => {
      const body = route.request().postDataJSON();
      const question = { ...makeQuestion('speaking', body.clientRequestId), grammarSourceLessonId: 13, grammarId: lessons1[12].grammar[0].id, grammarTitle: lessons1[12].grammar[0].title };
      const current = { question, attempt: null }; value.positions.set('speaking', current);
      await route.fulfill({ json: current });
    } }); const { page, context } = value;
    try {
      await value.enter(true); await value.start();
      const mode = page.getByRole('combobox', { name: '回答模式' });
      expect(await mode.inputValue()).toBe('audio'); await mode.selectOption('text');
      const field = page.getByRole('textbox', { name: '用日语写出你的回答' });
      await field.fill(sentence.jp); await mode.selectOption('audio'); await mode.selectOption('text');
      expect(await field.inputValue()).toBe(sentence.jp);
      await field.dispatchEvent('compositionstart'); await field.press('Enter'); expect(value.answers).toHaveLength(0);
      await field.dispatchEvent('compositionend'); await field.press('Enter');
      await page.getByRole('heading', { name: '文字表达参考分 · 70/70' }).waitFor();
      const reference = page.locator('details').filter({ has: page.getByText('查看参考表达', { exact: true }) });
      expect(await reference.evaluate(node => (node as HTMLDetailsElement).open)).toBe(true);
      expect(await reference.locator('.japanese').isVisible()).toBe(true);
      expect(await reference.locator('.practice-focus').innerText()).toContain(`考点：${lessons1[12].grammar[0].title} · 所属单元：第13单元`);
      expect(value.generation).toHaveLength(1); expect(value.assessments).toHaveLength(0);
      expect(await page.getByText('可以靠近麦克风重录。').count()).toBe(0);
      expect(await page.locator('.ai-score-parts').innerText()).not.toContain('发音');
      await page.reload(); await value.enter(true); expect(await mode.inputValue()).toBe('text');
      expect(await field.inputValue()).toBe(sentence.jp); await page.getByRole('heading', { name: '文字表达参考分 · 70/70' }).waitFor();
      expect(await reference.locator('.japanese').isVisible()).toBe(true);
      await page.getByRole('switch', { name: '回车答对自动下一题' }).check(); await field.press('Enter');
      await expect.poll(() => value.activations.length).toBe(1); await expect.poll(() => field.inputValue()).toBe('');
      expect(value.generation).toHaveLength(1);
    } finally { await context.close(); }
  });
  it('prevents input-mode switching while recording', async () => {
    const value = await setup();
    try {
      await value.enter(true); await value.start();
      await value.page.getByRole('button', { name: '开始录音：点击或按住说话', exact: true }).click();
      expect(await value.page.getByRole('combobox', { name: '回答模式' }).isDisabled()).toBe(true);
    } finally { await value.context.close(); }
  });
  it.each(['dictation', 'vocabulary'] as const)('submits %s on Enter without advancing by default and persists the opt-in switch', async kind => {
    const value = await setup(); const { page, context } = value;
    const enter = async () => {
      if (kind === 'dictation') await value.enter();
      else { await page.locator('.stage-tabs').getByRole('button', { name: '单词' }).click(); await page.getByRole('button', { name: 'AI练习', exact: true }).click(); }
    };
    try {
      await enter(); await value.start();
      const toggle = page.getByRole('switch', { name: '回车答对自动下一题' });
      expect(await toggle.isChecked()).toBe(false);
      await page.clock.install();
      await page.locator('textarea').fill(sentence.jp); await page.locator('textarea').press('Enter');
      await page.locator('.answer-feedback').waitFor(); await page.clock.fastForward(1000);
      expect(value.answers).toHaveLength(1); expect(value.generation).toHaveLength(1);
      expect(value.activations).toEqual([]);
      expect(await page.locator('textarea').inputValue()).toBe(sentence.jp);
      await toggle.check();
      await page.getByRole('button', { name: kind === 'dictation' ? '检查听写' : '检查句子', exact: true }).click();
      await expect.poll(() => value.answers.length).toBe(2); await page.clock.fastForward(1000);
      expect(value.generation).toHaveLength(1);
      expect(value.activations).toEqual([]);
      await page.reload(); await enter(); expect(await toggle.isChecked()).toBe(true);
    } finally { await context.close(); }
  });
  it.each(['dictation', 'vocabulary'] as const)('advances %s on Enter after grading, ignores IME Enter and restores input focus', async kind => {
    const value = await setup(); const { page, context } = value;
    try {
      if (kind === 'dictation') await value.enter();
      else { await page.locator('.stage-tabs').getByRole('button', { name: '单词' }).click(); await page.getByRole('button', { name: 'AI练习', exact: true }).click(); }
      await value.start(); await page.getByRole('switch', { name: '回车答对自动下一题' }).check(); const field = page.locator('textarea'); await field.fill('少し待ってください。');
      await field.dispatchEvent('compositionstart'); await field.press('Enter');
      expect(value.answers).toHaveLength(0); expect(value.generation).toHaveLength(1);
      expect(value.activations).toEqual([]);
      await field.dispatchEvent('compositionend'); await field.press('Enter');
      await expect.poll(() => value.activations.length).toBe(1);
      expect(value.generation).toHaveLength(1);
      await expect.poll(() => field.inputValue()).toBe('');
      expect(value.answers).toHaveLength(1);
      await expect.poll(() => field.evaluate(el => document.activeElement === el)).toBe(true);
    } finally { await context.close(); }
  });
  it.each(['dictation', 'vocabulary', 'speaking'] as const)('advances %s on a second correct Enter without grading again when auto-advance is off', async kind => {
    const value = await setup(); const { page, context } = value;
    try {
      if (kind === 'speaking') await value.enter(true);
      else if (kind === 'dictation') await value.enter();
      else { await page.locator('.stage-tabs').getByRole('button', { name: '单词' }).click(); await page.getByRole('button', { name: 'AI练习', exact: true }).click(); }
      await value.start();
      if (kind === 'speaking') await page.getByRole('combobox', { name: '回答模式' }).selectOption('text');
      const field = page.locator('textarea');
      expect(await page.getByRole('switch', { name: '回车答对自动下一题' }).isChecked()).toBe(false);
      await field.fill(sentence.jp); await field.press('Enter');
      await expect.poll(() => value.answers.length).toBe(1);
      if (kind === 'speaking') await page.getByRole('heading', { name: '文字表达参考分 · 70/70' }).waitFor();
      else await page.locator('.answer-feedback.success').waitFor();
      await expect.poll(() => field.isEnabled()).toBe(true);
      expect(value.activations).toEqual([]);
      await field.dispatchEvent('keydown', { key: 'Enter', code: 'Enter', repeat: true });
      await field.dispatchEvent('compositionstart'); await field.press('Enter'); await field.dispatchEvent('compositionend');
      await field.press('Shift+Enter');
      expect(value.activations).toEqual([]); expect(value.answers).toHaveLength(1);
      await field.fill(sentence.jp); await field.press('Enter');
      await expect.poll(() => value.activations.length).toBe(1);
      await expect.poll(() => field.inputValue()).toBe('');
      await expect.poll(() => field.evaluate(node => document.activeElement === node)).toBe(true);
      expect(value.answers).toHaveLength(1); expect(value.generation).toHaveLength(1);
    } finally { await context.close(); }
  });
  it.each(['dictation', 'vocabulary', 'speaking'] as const)('reassesses an edited %s answer instead of advancing from a stale correct result', async kind => {
    const value = await setup(); const { page, context } = value;
    try {
      if (kind === 'speaking') await value.enter(true);
      else if (kind === 'dictation') await value.enter();
      else { await page.locator('.stage-tabs').getByRole('button', { name: '单词' }).click(); await page.getByRole('button', { name: 'AI练习', exact: true }).click(); }
      await value.start();
      if (kind === 'speaking') await page.getByRole('combobox', { name: '回答模式' }).selectOption('text');
      const field = page.locator('textarea');
      await field.fill(sentence.jp); await field.press('Enter');
      await expect.poll(() => value.answers.length).toBe(1); await expect.poll(() => field.isEnabled()).toBe(true);
      await field.fill('もう少し待ってください。'); await field.press('Enter');
      await expect.poll(() => value.answers.length).toBe(2); await expect.poll(() => field.isEnabled()).toBe(true);
      expect(value.activations).toEqual([]); expect(value.answers[1].answer).toBe('もう少し待ってください。');
      await field.press('Enter'); await expect.poll(() => value.activations.length).toBe(1);
      expect(value.answers).toHaveLength(2);
    } finally { await context.close(); }
  });
  it('advances immediately on the second Enter and cancels an already scheduled automatic next', async () => {
    const value = await setup(); const { page, context } = value;
    try {
      await value.enter(); await value.start();
      await page.clock.install({ time: new Date('2026-10-25T00:00:00Z') });
      await page.clock.pauseAt(new Date('2026-10-25T00:00:01Z'));
      await page.getByRole('switch', { name: '回车答对自动下一题' }).check();
      const field = page.locator('textarea'); await field.fill(sentence.jp); await field.press('Enter');
      await page.locator('.answer-feedback.success').waitFor(); await expect.poll(() => field.isEnabled()).toBe(true);
      await field.press('Enter'); await expect.poll(() => value.activations.length).toBe(1);
      await expect.poll(() => field.inputValue()).toBe('');
      await page.clock.fastForward(2000);
      expect(value.activations).toHaveLength(1); expect(value.answers).toHaveLength(1);
    } finally { await context.close(); }
  });
  it('grades a typed answer after a successful recording instead of treating audio feedback as a spelling pass', async () => {
    const value = await setup(); const { page, context } = value;
    try {
      await value.enter(true); await value.start();
      await page.getByRole('button', { name: '开始录音：点击或按住说话', exact: true }).click();
      await page.getByRole('button', { name: '结束录音', exact: true }).click();
      await page.getByRole('heading', { name: 'AI练习参考分 · 96/100' }).waitFor();
      await page.getByRole('combobox', { name: '回答模式' }).selectOption('text');
      const field = page.locator('textarea'); await field.fill(sentence.jp); await field.press('Enter');
      await page.getByRole('heading', { name: '文字表达参考分 · 70/70' }).waitFor();
      expect(value.answers).toHaveLength(1); expect(value.activations).toEqual([]);
      await field.press('Enter'); await expect.poll(() => value.activations.length).toBe(1);
      expect(value.answers).toHaveLength(1);
    } finally { await context.close(); }
  });
  it('keeps an incorrect Enter answer and does not advance on a grading failure', async () => {
    const value = await setup(); const { page, context } = value;
    try {
      await value.enter(); await value.start(); await page.getByRole('switch', { name: '回车答对自动下一题' }).check();
      await page.route('**/api/ai-practice/questions/*/answer', route => route.fulfill({ json: { kind: 'dictation', correct: false, feedbackZh: '请再试一次', usedHint: false } }));
      await page.locator('textarea').fill('違います'); await page.locator('textarea').press('Enter');
      await page.locator('.answer-feedback').waitFor(); expect(value.generation).toHaveLength(1);
      expect(await page.locator('textarea').inputValue()).toBe('違います');
      await page.route('**/api/ai-practice/questions/*/answer', route => route.fulfill({ status: 503, json: { error: '暂时不可用' } }));
      await page.locator('textarea').press('Enter'); await page.getByRole('alert').waitFor();
      expect(value.generation).toHaveLength(1);
      expect(value.activations).toEqual([]);
    } finally { await context.close(); }
  });
  it('honors switching auto-advance off while an answer is being graded', async () => {
    const value = await setup(); const { page, context } = value;
    let release!: () => void; const gate = new Promise<void>(done => { release = done; });
    let requested = false;
    try {
      await value.enter(); await value.start(); await page.clock.install();
      await page.route('**/api/ai-practice/questions/*/answer', async route => {
        requested = true; await gate;
        await route.fulfill({ json: { kind: 'dictation', correct: true, feedbackZh: '正确', usedHint: false } });
      });
      const toggle = page.getByRole('switch', { name: '回车答对自动下一题' });
      await toggle.check(); await page.locator('textarea').fill(sentence.jp); await page.locator('textarea').press('Enter');
      await expect.poll(() => requested).toBe(true); await toggle.uncheck(); release();
      await page.locator('.answer-feedback').waitFor(); await page.clock.fastForward(1000);
      expect(value.generation).toHaveLength(1); expect(await page.locator('textarea').inputValue()).toBe(sentence.jp);
      expect(value.activations).toEqual([]);
    } finally { release?.(); await context.close(); }
  });
  it('keeps the spelling switch accessible in mobile and enlarged layouts', async () => {
    const value = await setup();
    try {
      await value.enter(); await value.start();
      const audit = await new AxeBuilder({ page: value.page }).include('.ai-practice').withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
      expect(audit.violations).toEqual([]);
      await value.page.addStyleTag({ content: ':root{font-size:200%!important}' });
      expect(await value.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      const toggle = value.page.getByRole('switch', { name: '回车答对自动下一题' });
      await toggle.focus(); await value.page.keyboard.press('Space'); expect(await toggle.isChecked()).toBe(true);
    } finally { await value.context.close(); }
  });
  it.each(['dictation', 'vocabulary'] as const)('submits %s recording directly, restores only text feedback, and remembers the answer mode', async kind => {
    const value = await setup(); const { page, context } = value;
    try {
      const enter = async () => {
        if (kind === 'dictation') await value.enter();
        else { await page.locator('.stage-tabs').getByRole('button', { name: '单词' }).click(); await page.getByRole('button', { name: 'AI练习', exact: true }).click(); }
      };
      await enter(); await value.start();
      await page.getByLabel('回答模式', { exact: true }).selectOption('audio');
      expect(await page.locator('textarea').count()).toBe(0);
      await page.getByRole('button', { name: '开始录音：点击或按住说话', exact: true }).click();
      await page.getByRole('button', { name: '结束录音', exact: true }).click();
      await page.getByText('录音回答检查完成。', { exact: false }).waitFor();
      expect(value.assessments).toHaveLength(1); expect(value.uploads).toEqual([]); expect(value.transcribes).toEqual([]);
      expect(await page.locator('.recording-preview .audio-controls').count()).toBe(1);
      expect(await page.locator('textarea').count()).toBe(0);
      await page.reload(); await enter();
      await page.getByText('录音回答检查完成。', { exact: false }).waitFor();
      expect(await page.getByLabel('回答模式', { exact: true }).inputValue()).toBe('audio');
      expect(await page.locator('.recording-preview').count()).toBe(0); expect(value.assessments).toHaveLength(1);
    } finally { await context.close(); }
  });
  it('keeps a typed draft and an in-flight audio request through language and immersive preference changes', async () => {
    let release!: () => void; const gate = new Promise<void>(done => { release = done; });
    const value = await setup({ assess: async route => { const body = audioRequest(route); await gate; await route.fulfill({ json: score(body.questionId, '', body.clientAssessmentId) }); } });
    const { page, context } = value;
    try {
      await value.enter(); await value.start(); await page.locator('textarea').fill('まだ書いています。');
      await page.evaluate("import('/src/client/preferences.ts').then(m => m.setPreferences({locale:'ja-JP',immersive:true,collapsed:true}))");
      expect(await page.locator('textarea').inputValue()).toBe('まだ書いています。');
      expect(await page.getByRole('button', { name: '次の問題', exact: true }).isVisible()).toBe(true);
      await page.evaluate("import('/src/client/preferences.ts').then(m => m.setPreferences({locale:'zh-CN',immersive:false}))");
      await page.locator('.stage-tabs').getByRole('button', { name: '口语' }).click(); await value.start();
      await page.getByRole('button', { name: '开始录音：点击或按住说话', exact: true }).click(); await page.getByRole('button', { name: '结束录音', exact: true }).click();
      await expect.poll(() => value.assessments.length).toBe(1);
      await page.evaluate("import('/src/client/preferences.ts').then(m => m.setPreferences({locale:'ja-JP',immersive:true}))");
      release(); await page.locator('.audio-assessment-result').waitFor();
      expect(await page.locator('.audio-assessment-result').innerText()).toContain('96/100');
      expect(value.assessments).toHaveLength(1); expect(value.uploads).toEqual([]);
    } finally { release(); await context.close(); }
  });
  it('uses matching male/female channels for complete dialogue, slow playback and individual transcript lines', async () => {
    const value = await setup(); const { page, context } = value; const requests: { speaker: string; rate: number }[] = [];
    try {
      await page.route('**/api/voice/settings', route => route.fulfill({ json: { provider: 'minimax', speed: 1 } }));
      await page.route('**/api/voice/synthesize', route => { requests.push(route.request().postDataJSON()); return route.fulfill({ contentType: 'audio/wav', body: Buffer.from('mock audio') }); });
      await page.evaluate(() => {
        Object.defineProperty(window, 'Audio', { configurable: true, value: class {
          readyState = 4; duration = 2; currentTime = 0; paused = true; onended: (() => void) | null = null;
          play() { this.paused = false; setTimeout(() => this.onended?.(), 0); return Promise.resolve(); }
          pause() { this.paused = true; } removeAttribute() {} load() {}
        } });
      });
      await value.enter(); await page.getByRole('button', { name: '对话听力', exact: true }).click(); await value.start();
      await page.getByRole('button', { name: '播放', exact: true }).click();
      await expect.poll(() => requests.length).toBe(4);
      expect(requests.map(item => item.speaker)).toEqual(['dialogue-a', 'dialogue-b', 'dialogue-a', 'dialogue-b']);
      await page.getByRole('button', { name: '慢放', exact: true }).click(); expect(requests).toHaveLength(4); await page.getByRole('button', { name: '从头播放', exact: true }).click(); await expect.poll(() => requests.length).toBe(8);
      expect(requests.slice(4).map(item => item.rate)).toEqual([1, 1, 1, 1]);
      await page.locator('.ai-practice .answer-choices button').first().click(); await page.getByText('答对了。', { exact: true }).waitFor();
      expect(await page.locator('.ai-practice details').evaluate(node => (node as HTMLDetailsElement).open)).toBe(true);
      const lines = page.locator('.ai-practice .dialogue-line');
      expect(await lines.nth(0).innerText()).toContain('A（男）'); expect(await lines.nth(1).innerText()).toContain('B（女）');
      await lines.nth(1).getByRole('button', { name: '播放', exact: true }).click(); await expect.poll(() => requests.length).toBe(9);
      expect(requests[8].speaker).toBe('dialogue-b');
      await lines.nth(0).getByRole('button', { name: '播放', exact: true }).click(); await expect.poll(() => requests.length).toBe(10);
      expect(requests[9].speaker).toBe('dialogue-a');
      await page.evaluate(() => { document.documentElement.style.fontSize = '200%'; });
      expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
      const audit = await new AxeBuilder({ page }).include('.ai-practice').analyze();
      expect(audit.violations).toEqual([]);
    } finally { await context.close(); }
  });
  it('does not silently replace gender-specific dialogue playback with an unlabelled system voice', async () => {
    const value = await setup();
    try {
      await value.enter(); await value.page.getByRole('button', { name: '对话听力', exact: true }).click(); await value.start();
      await value.page.getByRole('button', { name: '播放', exact: true }).click();
      await expect.poll(() => value.page.evaluate(() => (window as unknown as { notices: string[] }).notices.join(''))).toContain('MiniMax');
      expect(await value.page.evaluate(() => (window as unknown as { said: string[] }).said)).toEqual([]);
    } finally { await value.context.close(); }
  });
  it('merges immediate double clicks into one generation request', async () => {
    let release!: () => void; const gate = new Promise<void>(done => { release = done; });
    const value = await setup({ generate: async route => { const body = route.request().postDataJSON(); await gate; await route.fulfill({ json: { question: makeQuestion(body.kind, body.clientRequestId), attempt: null } }); } });
    try {
      await value.enter(); await value.page.getByRole('button', { name: '开始练习' }).evaluate(button => { (button as HTMLButtonElement).click(); (button as HTMLButtonElement).click(); });
      await value.page.getByText('AI正在生成新题', { exact: false }).waitFor(); expect(value.generation).toHaveLength(1);
      release(); await value.page.getByRole('button', { name: '下一题', exact: true }).waitFor();
    } finally { release(); await value.context.close(); }
  });
  it('ignores a late audio score after switching to grammar', async () => {
    let release!: () => void; const gate = new Promise<void>(done => { release = done; });
    const value = await setup({ ignoreAbort: true, assess: async route => { const body = audioRequest(route); await gate; await route.fulfill({ json: score(route.request().url().split('/').at(-2)!, body.recordingId, body.clientAssessmentId) }); } });
    try {
      await value.enter(true); await value.start(); await value.page.getByRole('button', { name: '开始录音：点击或按住说话', exact: true }).click(); await value.page.getByRole('button', { name: '结束录音', exact: true }).click();
      await value.page.getByText('AI正在听录音', { exact: false }).waitFor(); await value.page.getByRole('button', { name: '语法', exact: false }).click(); release();
      await value.page.locator('.ai-practice').waitFor({ state: 'detached' }); expect(await value.page.getByRole('heading', { name: 'AI练习参考分 · 96/100' }).count()).toBe(0);
    } finally { release(); await value.context.close(); }
  });
  it('waits for practice to start, hides dictation in DOM and aria labels, accepts IME input and resumes feedback', async () => {
    const value = await setup(); const { page, context } = value;
    try {
      await value.enter(); expect(value.generation).toHaveLength(0); await value.start();
      expect(await page.locator('body').innerText()).not.toContain(sentence.jp); expect(await page.locator('body').innerText()).not.toContain(sentence.kana);
      expect(await page.locator('[aria-label]').evaluateAll(nodes => nodes.map(node => node.getAttribute('aria-label')).join(' '))).not.toContain(sentence.jp);
      await page.getByRole('button', { name: '播放', exact: true }).click(); await page.waitForFunction(() => (window as unknown as { said: string[] }).said.length > 0);
      await page.getByRole('textbox', { name: '你听到的完整日语句子' }).fill(sentence.kana); await page.getByRole('textbox').press('Space');
      expect(value.answers).toHaveLength(0); await page.getByRole('button', { name: '检查听写' }).click(); await page.getByText('答案检查完成。', { exact: false }).waitFor();
      expect(await page.locator('.ai-practice .japanese').innerText()).toBe(sentence.jp);
      await page.reload(); await value.enter(); await page.getByText('答案检查完成。', { exact: false }).waitFor(); expect(value.generation).toHaveLength(1);
    } finally { await context.close(); }
  });
  it('shows Chinese dialogue choices with transcript hidden until submission and keeps next-question above the card', async () => {
    const value = await setup(); const { page, context } = value;
    try {
      await value.enter(); await page.getByRole('button', { name: '对话听力', exact: true }).click(); await value.start();
      expect(await page.locator('.ai-practice .answer-choices button').count()).toBe(4); expect(await page.locator('body').innerText()).not.toContain(sentence.jp);
      const nav = await page.locator('.ai-practice .study-navigation').boundingBox(); const card = await page.locator('.ai-practice .study-card').boundingBox(); expect(nav!.y + nav!.height).toBeLessThanOrEqual(card!.y);
      await page.locator('.ai-practice .answer-choices button').first().click(); await page.getByText('答对了。', { exact: true }).waitFor();
      await expect.poll(() => page.locator('.ai-practice .dialogue-line').count()).toBe(4);
      expect(await page.locator('.ai-practice .dialogue-line').first().isVisible()).toBe(true);
    } finally { await context.close(); }
  });
  it('keeps the current question and automatically retries invalid generation with the same request ID', async () => {
    const value = await setup({ prefetch: async (route, index) => {
      const body = route.request().postDataJSON(); if (index <= 2) return route.fulfill({ status: 502, json: { error: 'AI未能生成不同且完整的新题，请重试。原题仍保留。', code: 'PRACTICE_INVALID_RESPONSE' } });
      const current = { question: makeQuestion('dictation', body.clientRequestId), attempt: null }; value.queued.set(body.clientRequestId, current); return route.fulfill({ json: current });
    } });
    try {
      await value.enter(); await value.start(); await value.page.locator('textarea').fill(sentence.jp); const original = await value.page.locator('.ai-practice .study-card').innerText();
      await expect.poll(() => value.prefetched.length).toBe(1);
      await value.page.clock.install();
      await value.page.getByRole('button', { name: '下一题', exact: true }).click(); await value.page.getByText('正在自动重试出题 1/3', { exact: false }).waitFor();
      expect(await value.page.locator('.ai-practice .study-card').innerText()).toBe(original);
      expect(await value.page.locator('textarea').inputValue()).toBe(sentence.jp);
      expect(await value.page.getByRole('button', { name: '重试出题' }).count()).toBe(0);
      await value.page.clock.fastForward(1000); await expect.poll(() => value.activations.length).toBe(1);
      await expect.poll(() => value.page.locator('textarea').inputValue()).toBe('');
      expect(new Set(value.prefetched.slice(0, 3).map(item => item.clientRequestId)).size).toBe(1);
      expect(value.prefetched[0].clientRequestId).not.toBe(value.generation[0].clientRequestId);
    } finally { await value.context.close(); }
  });
  it('bounds automatic generation retries and keeps the request id stable', async () => {
    const value = await setup({ generate: route => route.fulfill({ status: 502, json: { error: '出题服务暂不可用', code: 'PRACTICE_UNAVAILABLE' } }) });
    try {
      await value.enter(); await value.page.clock.install(); await value.page.getByRole('button', { name: '开始练习', exact: true }).click();
      for (let retry = 1; retry <= 3; retry++) {
        await value.page.getByText(`正在自动重试出题 ${retry}/3`, { exact: false }).waitFor();
        await value.page.clock.fastForward(1000 * 2 ** (retry - 1));
      }
      await value.page.getByRole('alert').waitFor(); await value.page.clock.fastForward(60000);
      expect(value.generation).toHaveLength(4);
      expect(new Set(value.generation.map(item => item.clientRequestId)).size).toBe(1);
    } finally { await value.context.close(); }
  });
  it.each(['stop', 'leave'] as const)('cancels a scheduled generation retry on %s', async action => {
    const value = await setup({ generate: route => route.fulfill({ status: 502, json: { error: '新题重复', code: 'PRACTICE_INVALID_RESPONSE' } }) });
    try {
      await value.enter(); await value.page.clock.install(); await value.page.getByRole('button', { name: '开始练习', exact: true }).click();
      await value.page.getByText('正在自动重试出题 1/3', { exact: false }).waitFor();
      if (action === 'stop') await value.page.getByRole('button', { name: '停止出题', exact: true }).click();
      else { await value.page.locator('.stage-tabs').getByRole('button', { name: '语法' }).click(); await value.page.locator('.ai-practice').waitFor({ state: 'detached' }); }
      await value.page.clock.fastForward(60000); expect(value.generation).toHaveLength(1);
    } finally { await value.context.close(); }
  });
  it('does not automatically retry a missing key', async () => {
    const value = await setup({ generate: route => route.fulfill({ status: 503, json: { error: '请配置密钥', code: 'PRACTICE_NOT_CONFIGURED' } }) });
    try {
      await value.enter(); await value.page.clock.install(); await value.page.getByRole('button', { name: '开始练习', exact: true }).click();
      await value.page.getByRole('alert').waitFor(); await value.page.clock.fastForward(60000);
      expect(value.generation).toHaveLength(1);
    } finally { await value.context.close(); }
  });
  it('does not let a late generated question overwrite a different mode', async () => {
    let release!: () => void; const gate = new Promise<void>(done => { release = done; });
    const value = await setup({ ignoreAbort: true, generate: async route => { const body = route.request().postDataJSON(); await gate; await route.fulfill({ json: { question: makeQuestion(body.kind, body.clientRequestId), attempt: null } }); } });
    try {
      await value.enter(); await value.page.getByRole('button', { name: '开始练习' }).click(); await value.page.getByText('AI正在生成新题', { exact: false }).waitFor();
      await value.page.getByRole('button', { name: '对话听力', exact: true }).click(); release(); await value.page.getByRole('button', { name: '开始练习' }).waitFor();
      expect(await value.page.locator('.ai-practice').innerText()).toContain('对话听力'); expect(await value.page.locator('.ai-practice').innerText()).not.toContain('完整写出');
    } finally { release(); await value.context.close(); }
  });
  it('records against a dynamic question and scores raw audio without Whisper, then resumes the result', async () => {
    const value = await setup(); const { page, context } = value;
    try {
      await value.enter(true); await value.start(); await page.getByText('用日语表达：请等一下。', { exact: true }).waitFor();
      expect(await page.locator('.ai-practice').innerText()).not.toContain(sentence.jp);
      await page.getByRole('button', { name: '开始录音：点击或按住说话', exact: true }).click(); await page.getByRole('button', { name: '结束录音', exact: true }).waitFor(); await page.getByRole('button', { name: '结束录音', exact: true }).click();
      await page.getByRole('heading', { name: 'AI练习参考分 · 96/100' }).waitFor(); expect(value.uploads).toHaveLength(0); expect(value.assessments).toHaveLength(1); expect(value.transcribes).toHaveLength(0);
      expect(await page.locator('.ai-practice .practice-focus').innerText()).toContain('所属单元：第14单元');
      expect(await page.locator('.ai-practice details[open] .japanese').isVisible()).toBe(true);
      expect(value.assessments[0].questionId).toBe(value.generation[0].clientRequestId);
      await page.reload(); await value.enter(true); await page.getByRole('heading', { name: 'AI练习参考分 · 96/100' }).waitFor(); expect(value.assessments).toHaveLength(1);
    } finally { await context.close(); }
  });
  it('retains an in-memory recording and stable score ID after a failed assessment', async () => {
    const value = await setup({ assess: async route => { const body = audioRequest(route); if (value.assessments.length === 1) return route.fulfill({ status: 504, json: { error: '评分等待超时。' } }); const id = route.request().url().split('/').at(-2)!; return route.fulfill({ json: score(id, body.recordingId, body.clientAssessmentId) }); } });
    try {
      await value.enter(true); await value.start(); await value.page.getByRole('button', { name: '开始录音：点击或按住说话', exact: true }).click(); await value.page.getByRole('button', { name: '结束录音', exact: true }).click();
      await value.page.getByText('评分等待超时。', { exact: true }).waitFor(); await value.page.getByRole('button', { name: '重试评分' }).click(); await value.page.getByRole('heading', { name: 'AI练习参考分 · 96/100' }).waitFor();
      expect(value.assessments[0]).toEqual(value.assessments[1]); expect(value.uploads).toHaveLength(0);
    } finally { await value.context.close(); }
  });
  it('stops recording when switching to grammar and renders accessibly at mobile and 200% scale', async () => {
    const value = await setup();
    try {
      await value.enter(true); await value.start();
      const audit = await new AxeBuilder({ page: value.page }).include('main').withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze(); expect(audit.violations).toEqual([]);
      await value.page.addStyleTag({ content: ':root{font-size:200%!important}' }); expect(await value.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await value.page.getByRole('button', { name: '开始录音：点击或按住说话', exact: true }).click(); await value.page.getByRole('button', { name: '结束录音', exact: true }).waitFor();
      await value.page.getByRole('button', { name: '语法', exact: false }).click(); await value.page.waitForFunction(() => (window as unknown as { stoppedTracks: number }).stoppedTracks > 0);
      expect(await value.page.locator('.ai-practice').count()).toBe(0);
    } finally { await value.context.close(); }
  });
});
