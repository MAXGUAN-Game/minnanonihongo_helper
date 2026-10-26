import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { chromium, expect as browserExpect, type Browser } from '@playwright/test';
import { createServer, type ViteDevServer } from 'vite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { vocabularyForLesson } from '../src/content/vocabulary';
const words = vocabularyForLesson(29).words.slice(0, 2);
let vite: ViteDevServer, browser: Browser, origin: string, cache: string;
const harness = `import React from 'react';import {createRoot} from 'react-dom/client';
import {VocabularyList} from '/src/client/VocabularyList.tsx';import {AIPractice} from '/src/client/AIPractice.tsx';
import {MasteryPanel} from '/src/client/MasteryPanel.tsx';import {useSpeech} from '/src/client/speech.ts';import '/src/client/style.css';
function Harness(){const [ai,setAI]=React.useState(false);const speech=useSpeech(()=>{});return <main style={{padding:24}}><button onClick={()=>setAI(!ai)}>切换练习</button><div className="immersive"><MasteryPanel lessonId={29} stage="vocabulary"/></div>{ai?<AIPractice lessonId={29} kind="vocabulary" speech={speech} notice={()=>{}} furigana/>:<VocabularyList lessonId={29} furigana speech={speech}/>}</main>};createRoot(document.getElementById('root')).render(<Harness/>);`;
beforeAll(async () => {
  cache = await mkdtemp(join(tmpdir(), 'nihongo-word-ui-'));
  vite = await createServer({ configFile: false, root: process.cwd(), cacheDir: cache, optimizeDeps: { include: ['react', 'react-dom', 'react-dom/client', 'react-dom', 'react/jsx-runtime', 'react/jsx-dev-runtime', 'lucide-react'], noDiscovery: true }, server: { host: '127.0.0.1', port: 0 },
    plugins: [{ name: 'word-harness', resolveId(id) { if (id === '/__word.tsx') return id; }, load(id) { if (id === '/__word.tsx') return harness; } }], esbuild: { jsx: 'automatic' } });
  await vite.listen(); const address = vite.httpServer!.address(); if (!address || typeof address === 'string') throw new Error('No address'); origin = `http://127.0.0.1:${address.port}`;
  browser = await chromium.launch({ headless: true, ...(process.platform === 'win32' ? { channel: 'msedge' } : {}) });
}, 30000);
afterAll(async () => { await browser?.close(); await vite?.close(); if (cache) await rm(cache, { recursive: true, force: true }); });
async function setup(width = 1100) {
  const context = await browser.newContext({ viewport: { width, height: 850 } }), page = await context.newPage();
  page.on('pageerror', error => console.error('Word browser error:', error.message));
  let grammarCalls = 0, marked = false, failMark = false, failNext = false;
  const question = (id: string, index: number) => ({ id, lessonId: 29, grammarSourceLessonId: 29, grammarId: 'g1', grammarTitle: '例句', model: 'local', fingerprints: [], createdAt: '2026-10-26T00:00:00Z', content: { kind: 'vocabulary', wordId: words[index].id, word: words[index].word, reading: words[index].reading, meaning: words[index].meaning, partOfSpeech: words[index].partOfSpeech } });
  const queued = new Map<string, unknown>();
  await page.route('**/__word-test', route => route.fulfill({ contentType: 'text/html', body: '<html><body><div id="root"></div><script type="module" src="/__word.tsx"></script></body></html>' }));
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url()), path = url.pathname;
    if (path.endsWith('/voice/settings')) return route.fulfill({ json: { provider: 'system', speed: 1 } });
    if (path.endsWith('/mastery') && path.includes('/ai-practice/')) return route.fulfill({ json: { modules: { vocabulary: { score: marked ? 50 : 0, count: marked ? 1 : 0, total: 2 } } } });
    if (path.endsWith('/mastery')) { if (failMark) return route.fulfill({ status: 503, json: { error: '保存失败' } }); marked = true; return route.fulfill({ json: { words, mastery: [{ wordId: words[0].id, mastered: true }] } }); }
    if (path.endsWith('/vocabulary')) return route.fulfill({ json: { lessonId: 29, complete: true, words, mastery: marked ? [{ wordId: words[0].id, mastered: true }] : [] } });
    if (path.endsWith('/grammar')) { grammarCalls++; return route.fulfill({ json: { structure: '主题和谓语', points: [{ expression: 'が', explanation: '表示主语' }] } }); }
    if (path.endsWith('/audio')) return route.fulfill({ status: 503, json: { error: '语音额度不足' } });
    if (path.includes('/vocabulary/')) return route.fulfill({ json: words.find(w => path.endsWith(w.id)) });
    if (path.endsWith('/current')) return route.fulfill({ json: { question: question('current', 0), attempt: null } });
    if (path.endsWith('/prefetch')) { const body = route.request().postDataJSON(); const value = { question: question(body.clientRequestId, 1), attempt: null }; queued.set(body.clientRequestId, value); return route.fulfill({ json: value }); }
    if (path.endsWith('/activate')) { if (failNext) return route.fulfill({ status: 400, json: { error: '下一题暂不可用' } }); return route.fulfill({ json: queued.get(path.split('/').at(-2)!) }); }
    return route.fulfill({ status: 404, json: { error: 'Unhandled fixture endpoint' } });
  });
  await page.goto(origin + '/__word-test'); await page.locator('.vocabulary-list tr').nth(1).waitFor();
  return { page, context, calls: () => grammarCalls, marked: () => marked, failMark: (v: boolean) => { failMark = v; }, failNext: (v: boolean) => { failNext = v; } };
}
describe('word detail interaction and layout', () => {
  it.each([1100, 390])('keeps translation layout stable and closes detail with click/Escape/outside at %i', async width => {
    const v = await setup(width); const { page } = v;
    try {
      const row = page.locator('.vocabulary-list tbody tr').nth(1), before = await row.boundingBox();
      await page.getByRole('button', { name: '显示翻译', exact: true }).first().click();
      const after = await row.boundingBox(); expect(after!.y).toBeCloseTo(before!.y, 0); expect(after!.width).toBeCloseTo(before!.width, 0);
      await browserExpect(page.getByRole('progressbar')).toBeVisible();
      const trigger = page.getByRole('button', { name: words[0].word, exact: true }); await trigger.click();
      await browserExpect(page.getByRole('dialog')).toContainText(words[0].detail!.example.jp); expect(v.calls()).toBe(0);
      await page.getByRole('button', { name: '语法', exact: true }).click(); await browserExpect(page.getByRole('dialog')).toContainText('表示主语'); expect(v.calls()).toBe(1);
      await page.keyboard.press('Escape'); await browserExpect(page.getByRole('dialog')).toHaveCount(0);
      await trigger.click(); await trigger.click(); await browserExpect(page.getByRole('dialog')).toHaveCount(0);
      await trigger.click(); await page.mouse.click(width - 4, 4); await browserExpect(page.getByRole('dialog')).toHaveCount(0);
      await page.getByRole('button', { name: `${words[0].word} · 发音`, exact: true }).click();
      await browserExpect(page.getByRole('alert')).toContainText('语音额度不足'); await browserExpect(page.getByRole('dialog')).toHaveCount(0);
    } finally { await v.context.close(); }
  });
  it('saves mastery before advancing; failed saves retain the question and failed next retains mastery', async () => {
    const v = await setup();
    try {
      await v.page.getByRole('button', { name: '切换练习' }).click();
      await browserExpect(v.page.locator('.vocabulary-practice-title')).toContainText(words[0].word);
      expect(await v.page.locator('.practice-prefetch').count()).toBe(0);
      await v.page.getByRole('button', { name: words[0].word, exact: true }).click(); await browserExpect(v.page.getByRole('dialog')).toContainText(words[0].meaning); await v.page.keyboard.press('Escape');
      v.failMark(true); await v.page.getByRole('switch', { name: '已掌握', exact: true }).click(); await browserExpect(v.page.getByRole('alert')).toContainText('保存失败'); expect(v.marked()).toBe(false);
      v.failMark(false); v.failNext(true); await v.page.getByRole('switch', { name: '已掌握', exact: true }).click();
      await browserExpect(v.page.getByRole('alert')).toContainText('下一题暂不可用'); expect(v.marked()).toBe(true); await browserExpect(v.page.getByRole('switch', { name: '已掌握', exact: true })).toBeChecked();
      v.failNext(false); await v.page.getByRole('button', { name: '下一题', exact: true }).click(); await browserExpect(v.page.locator('.vocabulary-practice-title')).toContainText(words[1].word);
      await browserExpect(v.page.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '50');
    } finally { await v.context.close(); }
  });
});
