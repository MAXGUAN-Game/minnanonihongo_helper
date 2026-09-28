import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { createServer, type ViteDevServer } from 'vite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { lessons1 } from '../src/content/lessons-01-25';

let browser: Browser, vite: ViteDevServer, origin: string, cacheDir: string;
const task = lessons1[13].speaking[0];
const harness = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { SpeakingPractice } from '/src/client/SpeakingPractice.tsx';
import { RecordingHistory } from '/src/client/RecordingHistory.tsx';
import { lessons1 } from '/src/content/lessons-01-25.ts';
import '/src/client/style.css';
window.ratings=[];
window.practiceAudioSource=null;
const speech={say(text,lang,rate,sourceId){window.practiceAudioSource=sourceId},stop(){window.practiceAudioSource=null},stopSource(sourceId){if(window.practiceAudioSource===sourceId)window.practiceAudioSource=null},speaking:false,playUrl(){},getEpoch(){return 0}};
function Harness(){const [hint,setHint]=React.useState(false);return <main style={{maxWidth:900,margin:'auto',padding:20}}><h1>练习表达</h1><SpeakingPractice lessonId={14} task={lessons1[13].speaking[0]} speech={speech} notice={()=>{}} busy={false} usedHint={hint} furigana={false} onHint={()=>setHint(true)} onRate={async(result,answer)=>window.ratings.push({result,...answer})}/><RecordingHistory lessonId={14} speech={speech}/></main>}
createRoot(document.getElementById('root')).render(<Harness/>);`;

beforeAll(async () => {
  cacheDir = await mkdtemp(join(tmpdir(), 'nihongo-speaking-ui-'));
  vite = await createServer({ configFile: false, root: process.cwd(), cacheDir,
    optimizeDeps: { include: ['react', 'react-dom/client', 'react/jsx-runtime', 'react/jsx-dev-runtime', 'lucide-react'], noDiscovery: true },
    server: { host: '127.0.0.1', port: 0 }, plugins: [{ name: 'speaking-test', resolveId(id) { if (id === '/__speaking.tsx') return id; }, load(id) { if (id === '/__speaking.tsx') return harness; } }] });
  await vite.listen(); const address = vite.httpServer!.address();
  if (!address || typeof address === 'string') throw new Error('No test port');
  origin = `http://127.0.0.1:${address.port}`;
  browser = await chromium.launch({ headless: true, ...(process.platform === 'win32' ? { channel: 'msedge' } : {}) });
}, 30000);
afterAll(async () => {
  await browser?.close(); await vite?.close();
  if (cacheDir && dirname(resolve(cacheDir)) === resolve(tmpdir()) && basename(cacheDir).startsWith('nihongo-speaking-ui-')) await rm(cacheDir, { recursive: true, force: true });
});
async function setup() {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await context.route('**/*', async route => new URL(route.request().url()).origin !== origin ? route.abort() : route.fallback());
  const page = await context.newPage(); page.setDefaultTimeout(6000);
  await page.route('**/__speaking-test', route => route.fulfill({ contentType: 'text/html', body: '<html lang="zh-CN"><head><title>表达练习</title></head><body><div id="root"></div><script type="module" src="/__speaking.tsx"></script></body></html>' }));
  return { page, context, open: () => page.goto(`${origin}/__speaking-test`) };
}
function assessment(input: { clientAssessmentId: string; text: string }) {
  return { id: input.clientAssessmentId, lessonId: 14, itemId: task.id, text: input.text, createdAt: new Date().toISOString(), source: 'deepseek', kind: 'expression', taskScore: 45, grammarScore: 28, vocabularyScore: 19, totalScore: 92, summaryZh: '意思表达清楚了。', corrections: [], reference: task.answer };
}
const ratings = (page: Page) => page.evaluate(() => (window as unknown as { ratings: Array<{ answer: string; result: string }> }).ratings);

describe('speaking and recording history UI', () => {
  it('stops the reference sentence when its explanation is folded away', async () => {
    const { page, context, open } = await setup();
    await page.route('**/api/speaking/assess', route => route.fulfill({ json: assessment(route.request().postDataJSON()) }));
    try {
      await open();
      await page.locator('#speaking-answer').fill('少し待ってください。');
      await page.getByRole('button', { name: '确认并评分' }).click();
      const details = page.locator('.expression-result details');
      await details.locator('summary').click();
      await details.getByRole('button', { name: `朗读：${task.answer.jp}` }).click();
      const source = () => page.evaluate(() => (window as unknown as { practiceAudioSource: string | null }).practiceAudioSource);
      expect(await source()).toEqual(expect.any(String));
      await details.locator('summary').click();
      await expect.poll(source).toBeNull();
    } finally { await context.close(); }
  });
  it('records the actual answer, keeps hint evidence, and does not treat a score as mastery', async () => {
    const { page, context, open } = await setup();
    const inputs: Record<string, unknown>[] = [];
    await page.route('**/api/speaking/assess', route => { const input = route.request().postDataJSON(); inputs.push(input); return route.fulfill({ json: assessment(input) }); });
    try {
      await open();
      expect(await page.getByRole('button', { name: '确认并评分' }).isDisabled()).toBe(true);
      await page.locator('#speaking-answer').fill('はい、少し待ってください。');
      await page.getByRole('button', { name: '确认并评分' }).click();
      await page.getByText('意思表达清楚了。', { exact: true }).waitFor();
      expect(inputs[0].text).toBe('はい、少し待ってください。');
      expect(await ratings(page)).toEqual([]);
      const audit = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
      expect(audit.violations.map(item => item.id)).toEqual([]);
      await page.screenshot({ path: 'test-results/v1.1-speaking-mobile.png', fullPage: true });
      await page.getByRole('button', { name: '独立说出来了' }).click();
      expect((await ratings(page))[0]).toMatchObject({ result: 'good', answer: 'はい、少し待ってください。' });
      await page.getByRole('button', { name: '听示范', exact: true }).click();
      await page.getByRole('button', { name: '独立说出来了' }).click();
      expect((await ratings(page))[1].result).toBe('hint');
      await page.locator('#speaking-answer').fill('手伝ってください。');
      expect(await page.locator('.expression-result').count()).toBe(0);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    } finally { await context.close(); }
  });
  it('keeps failed scoring text and request ID for retry, but changes ID when the answer changes', async () => {
    const { page, context, open } = await setup(); const ids: string[] = [];
    await page.route('**/api/speaking/assess', route => { const input = route.request().postDataJSON(); ids.push(input.clientAssessmentId); return ids.length === 1 ? route.fulfill({ status: 502, json: { code: 'AI_UNAVAILABLE', error: '暂时无法评分。' } }) : route.fulfill({ json: assessment(input) }); });
    try {
      await open(); await page.locator('#speaking-answer').fill('少し待ってください。');
      await page.getByRole('button', { name: '确认并评分' }).click();
      await page.getByRole('alert').waitFor();
      expect(await page.locator('#speaking-answer').inputValue()).toBe('少し待ってください。');
      expect(await page.locator('.expression-score').count()).toBe(0);
      await page.getByRole('button', { name: '确认并评分' }).click(); await page.locator('.expression-result').waitFor();
      expect(ids[1]).toBe(ids[0]);
      await page.locator('#speaking-answer').fill('はい、待ちます。');
      await page.getByRole('button', { name: '确认并评分' }).click(); await page.locator('.expression-result').waitFor();
      expect(ids[2]).not.toBe(ids[0]);
    } finally { await context.close(); }
  });
  it('shows expired recordings without playback while preserving their text and expression score', async () => {
    const { page, context, open } = await setup();
    await page.route('**/api/recordings?lessonId=14', route => route.fulfill({ json: [{ id: 'old-recording', lessonId: 14, itemId: task.id, context: 'speak', createdAt: '2026-01-01T00:00:00Z', expiresAt: '2026-04-01T00:00:00Z', durationMs: 2500, audioAvailable: false, audioStatus: 'expired', confirmedText: '少し待ってください。', assessment: assessment({ clientAssessmentId: 'old-score', text: '少し待ってください。' }) }] }));
    try {
      await open(); await page.locator('.recording-history summary').click();
      await page.getByText('录音已到期', { exact: true }).waitFor();
      expect(await page.getByRole('button', { name: '播放录音', exact: true }).count()).toBe(0);
      expect(await page.getByText('表达评分 92/100', { exact: true }).isVisible()).toBe(true);
    } finally { await context.close(); }
  });
});
