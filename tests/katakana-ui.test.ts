import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Route } from '@playwright/test';
import { createServer, type ViteDevServer } from 'vite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { katakanaToHiragana, type KatakanaWord } from '../src/shared/katakana-words';

let browser: Browser, vite: ViteDevServer, origin: string, cacheDir: string;
const entries: KatakanaWord[] = [
  { word: 'コーヒー', meaningZh: '咖啡' }, { word: 'ティッシュ', meaningZh: '纸巾' },
  { word: 'バスケットボール', meaningZh: '篮球' }, { word: 'テレビ', meaningZh: '电视' },
  { word: 'サッカー', meaningZh: '足球' }, { word: 'パン', meaningZh: '面包' },
  { word: 'タクシー', meaningZh: '出租车' }, { word: 'チケット', meaningZh: '票' },
  { word: 'テーブル', meaningZh: '桌子' }, { word: 'コンピューター', meaningZh: '计算机' },
  { word: 'アルゴリズム', meaningZh: '算法' }, { word: 'オーケストラ', meaningZh: '管弦乐团' },
];
type BatchRequest = { requestId: string; count: number; recent: string[] };
const harness = `
import React, {useState} from 'react'; import {createRoot} from 'react-dom/client';
import {KatakanaWords} from '/src/client/KatakanaWords.tsx'; import {Katakana} from '/src/client/Katakana.tsx'; import '/src/client/style.css';
function Harness(){const [shown,setShown]=useState(true);return <main style={{maxWidth:800,margin:'auto',padding:18}}><button onClick={()=>setShown(false)}>离开练习</button>{shown&&(window.testKanaCharacters?<Katakana/>:<KatakanaWords/>)}</main>}
createRoot(document.getElementById('root')).render(<Harness/>);`;
beforeAll(async () => {
  cacheDir = await mkdtemp(join(tmpdir(), 'nihongo-katakana-ui-'));
  vite = await createServer({ configFile: false, root: process.cwd(), cacheDir,
    optimizeDeps: { include: ['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime', 'react/jsx-dev-runtime', 'lucide-react'], noDiscovery: true },
    server: { host: '127.0.0.1', port: 0 }, plugins: [{ name: 'katakana-test', resolveId(id) { if (id === '/__katakana-test.tsx') return id; }, load(id) { if (id === '/__katakana-test.tsx') return harness; } }] });
  await vite.listen(); const address = vite.httpServer!.address(); if (!address || typeof address === 'string') throw new Error('No test port');
  origin = `http://127.0.0.1:${address.port}`;
  browser = await chromium.launch({ headless: true, ...(process.platform === 'win32' ? { channel: 'msedge' } : {}) });
}, 30000);
afterAll(async () => {
  await browser?.close(); await vite?.close();
  if (dirname(resolve(cacheDir)) === resolve(tmpdir()) && basename(cacheDir).startsWith('nihongo-katakana-ui-')) await rm(cacheDir, { recursive: true, force: true });
});

async function setup(options: { intercept?: (route: Route, index: number, body: BatchRequest, reply: () => Promise<void>) => Promise<void>; ignoreAbort?: boolean; characters?: boolean } = {}) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  if (options.characters) await context.addInitScript(() => { Object.assign(window, { testKanaCharacters: true }); });
  if (options.ignoreAbort) await context.addInitScript(() => {
    const original = window.fetch.bind(window); window.fetch = (url, init) => original(url, String(url).includes('/katakana/words') ? { ...init, signal: undefined } : init);
  });
  await context.route('**/*', route => new URL(route.request().url()).origin !== origin ? route.abort('blockedbyclient') : route.fallback());
  const page = await context.newPage(); page.setDefaultTimeout(6000);
  const requests: BatchRequest[] = [];
  let offset = 0;
  await page.route('**/__katakana-test', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html lang="zh-CN"><head><title>片假名练习</title></head><body><div id="root"></div><script type="module" src="/__katakana-test.tsx"></script></body></html>' }));
  await page.route('**/api/katakana/words', async route => {
    const body = route.request().postDataJSON() as BatchRequest; requests.push(body);
    const reply = async () => { const words = entries.slice(offset, offset + body.count); offset += body.count; await route.fulfill({ json: { words } }); };
    if (options.intercept) return options.intercept(route, requests.length, body, reply);
    await reply();
  });
  await page.goto(origin + '/__katakana-test'); await page.getByRole('heading', { name: options.characters ? '片假名' : '片假名单词 · AI练习', exact: true }).waitFor();
  const start = async () => { await page.getByRole('button', { name: '开始练习', exact: true }).click(); await page.locator('#katakana-word-answer').waitFor(); };
  return { context, page, requests, start, field: page.locator(options.characters ? '#kana-answer' : '#katakana-word-answer'), prompt: page.locator(options.characters ? '.kana-prompt' : '.kana-word'), toggle: page.getByRole('switch', { name: '回车答对自动下一题' }) };
}

describe('ordinary kana character submission', () => {
  it('shows a compact toggle, submits only on Enter, accepts both scripts and counts each answer once', async () => {
    const value = await setup({ characters: true }); const { page, field, prompt, toggle, context } = value;
    try {
      await page.clock.install();
      expect(await toggle.isChecked()).toBe(false);
      expect(Math.round((await toggle.boundingBox())!.width)).toBe(43);
      const initial = await prompt.innerText();
      await field.fill(initial); await page.clock.fastForward(2000);
      expect(await prompt.innerText()).toBe(initial);
      expect(await page.getByText('已完成 0 · 104 项', { exact: true }).count()).toBe(1);
      expect(await page.getByText('正确', { exact: true }).count()).toBe(0);
      await field.dispatchEvent('compositionstart'); await field.press('Enter'); await field.dispatchEvent('compositionend');
      expect(await page.getByText('正确', { exact: true }).count()).toBe(0);
      await field.press('Enter'); await page.getByText('正确', { exact: true }).waitFor();
      await page.clock.fastForward(2000); expect(await prompt.innerText()).toBe(initial);
      await field.press('Enter'); expect(await page.getByText('已完成 1 · 104 项', { exact: true }).count()).toBe(1);
      await expect.poll(() => prompt.innerText()).not.toBe(initial);
      expect(await field.inputValue()).toBe('');
      await field.fill('wrong'); await field.press('Enter'); await page.getByText('请再试一次', { exact: true }).waitFor();
      expect(await page.getByText('已完成 1 · 104 项', { exact: true }).count()).toBe(1);
      await field.fill(katakanaToHiragana(await prompt.innerText())); await field.press('Enter');
      await page.getByText('正确', { exact: true }).waitFor();
      expect(await page.getByText('已完成 2 · 104 项', { exact: true }).count()).toBe(1);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      expect(value.requests).toHaveLength(0);
    } finally { await context.close(); }
  });

  it('automatically advances only when opted in and cancels timers on toggle-off, manual Next and unmount', async () => {
    const value = await setup({ characters: true }); const { page, field, prompt, toggle, context } = value;
    try {
      await page.clock.install(); const initial = await prompt.innerText();
      await toggle.check(); await field.fill(initial); await field.press('Enter');
      await page.getByText('正确', { exact: true }).waitFor();
      await toggle.uncheck(); await page.clock.fastForward(2000); expect(await prompt.innerText()).toBe(initial);
      await toggle.check(); await field.press('Enter'); await page.clock.fastForward(1000);
      await expect.poll(() => prompt.innerText()).not.toBe(initial);
      expect(await field.inputValue()).toBe('');
      expect(await field.evaluate(node => document.activeElement === node)).toBe(true);
      expect(await page.getByText('已完成 1 · 104 项', { exact: true }).count()).toBe(1);
      await field.fill(await prompt.innerText()); await field.press('Enter');
      await page.getByText('正确', { exact: true }).waitFor();
      await page.getByRole('button', { name: '下一题', exact: true }).click();
      const manual = await prompt.innerText(); await page.clock.fastForward(2000);
      expect(await prompt.innerText()).toBe(manual);
      expect(await page.getByText('已完成 2 · 104 项', { exact: true }).count()).toBe(1);
      await field.fill(manual); await field.press('Enter'); await page.getByText('正确', { exact: true }).waitFor();
      await page.getByRole('button', { name: '离开练习', exact: true }).click();
      await page.locator('.kana-practice').waitFor({ state: 'detached' }); await page.clock.fastForward(2000);
      expect(await page.locator('.kana-practice').count()).toBe(0); expect(value.requests).toHaveLength(0);
    } finally { await context.close(); }
  });

  it('shares the toggle with AI words and preserves it across refresh', async () => {
    const value = await setup({ characters: true }); const { page, toggle, context } = value;
    try {
      await toggle.check();
      await page.getByRole('button', { name: 'AI练习', exact: true }).click();
      await value.start(); expect(await toggle.isChecked()).toBe(true);
      await toggle.uncheck();
      await page.getByRole('button', { name: '假名练习', exact: true }).click();
      await page.locator('#kana-answer').waitFor(); expect(await toggle.isChecked()).toBe(false);
      await toggle.check(); await page.reload(); await page.locator('#kana-answer').waitFor();
      expect(await toggle.isChecked()).toBe(true);
    } finally { await context.close(); }
  });
});

describe('katakana word submission and five-question buffer', () => {
  it('submits only on Enter, ignores IME confirmation, reveals meaning after correctness and counts once', async () => {
    const value = await setup(); const { page, field, prompt, toggle, context } = value;
    try {
      expect(value.requests).toHaveLength(0); await value.start(); await page.clock.install();
      expect(await toggle.isChecked()).toBe(false);
      expect(await page.locator('.katakana-meaning').count()).toBe(0);
      await field.fill(entries[0].word); await page.clock.fastForward(2000);
      expect(await prompt.innerText()).toBe(entries[0].word); expect(await page.locator('.katakana-meaning').count()).toBe(0);
      await field.dispatchEvent('compositionstart'); await field.press('Enter'); await field.dispatchEvent('compositionend');
      expect(await page.locator('.katakana-meaning').count()).toBe(0);
      await field.press('Enter'); await page.getByText('中文释义：咖啡', { exact: true }).waitFor();
      await page.clock.fastForward(2000); expect(await prompt.innerText()).toBe(entries[0].word);
      await field.press('Enter'); expect(await page.getByText('已完成 1', { exact: true }).count()).toBe(1);
      await expect.poll(() => prompt.innerText()).toBe(entries[1].word);
      expect(await page.locator('.katakana-meaning').count()).toBe(0); expect(await field.inputValue()).toBe('');
      await field.fill('ていっしゅ'); await field.press('Enter'); await page.getByText('请再试一次', { exact: true }).waitFor();
      expect(await page.locator('.katakana-meaning').count()).toBe(0);
      await field.fill(katakanaToHiragana(entries[1].word)); await field.press('Enter'); await page.getByText('中文释义：纸巾', { exact: true }).waitFor();
      expect(await page.getByText('已完成 2', { exact: true }).count()).toBe(1);
    } finally { await context.close(); }
  });

  it('automatically advances only with the toggle, cancels a scheduled advance when disabled and remembers the preference', async () => {
    const value = await setup(); const { page, field, prompt, toggle, context } = value;
    try {
      await value.start(); await page.clock.install();
      await toggle.check(); await field.fill(entries[0].word); await field.press('Enter');
      await page.getByText('中文释义：咖啡', { exact: true }).waitFor();
      await toggle.uncheck(); await page.clock.fastForward(2000); expect(await prompt.innerText()).toBe(entries[0].word);
      await toggle.check(); await field.press('Enter'); await page.clock.fastForward(1000);
      await expect.poll(() => prompt.innerText()).toBe(entries[1].word);
      expect(await field.inputValue()).toBe(''); expect(await field.evaluate(node => document.activeElement === node)).toBe(true);
      expect(await page.getByText('已完成 1', { exact: true }).count()).toBe(1);
      await page.reload(); await value.start(); expect(await toggle.isChecked()).toBe(true);
    } finally { await context.close(); }
  });

  it('fills exactly five future words, stops when full and immediately refills each consumed slot', async () => {
    const value = await setup(); const { page, prompt, field, context } = value;
    try {
      await value.start(); await expect.poll(() => value.requests.map(item => item.count)).toEqual([1, 5]);
      await page.getByText('正在准备下一题……', { exact: true }).waitFor({ state: 'hidden' });
      await page.clock.install(); await page.clock.fastForward(60000); expect(value.requests).toHaveLength(2);
      expect(value.requests[1].recent).toEqual([entries[0].word]);
      expect(await field.isEnabled()).toBe(true); expect(await prompt.innerText()).toBe(entries[0].word);
      for (let consumed = 1; consumed <= 3; consumed++) {
        await page.getByRole('button', { name: '下一题', exact: true }).click();
        await expect.poll(() => prompt.innerText()).toBe(entries[consumed].word);
        await expect.poll(() => value.requests.length).toBe(consumed + 2);
        expect(value.requests.at(-1)!.count).toBe(1);
        expect(value.requests.at(-1)!.recent).toContain(entries[consumed + 4].word);
        await page.getByText('正在准备下一题……', { exact: true }).waitFor({ state: 'hidden' });
      }
      await page.clock.fastForward(60000); expect(value.requests).toHaveLength(5);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    } finally { await context.close(); }
  });

  it('waits for an in-flight batch without duplicate generation when Next empties the buffer', async () => {
    let release!: () => void; const gate = new Promise<void>(done => { release = done; });
    const value = await setup({ intercept: async (_route, index, _body, reply) => { if (index === 2) await gate; await reply(); } });
    try {
      await value.start(); await expect.poll(() => value.requests.length).toBe(2);
      expect(await value.field.isEnabled()).toBe(true);
      await value.page.getByRole('button', { name: '下一题', exact: true }).click();
      expect(await value.prompt.innerText()).toBe(entries[0].word); expect(await value.field.isDisabled()).toBe(true); expect(value.requests).toHaveLength(2);
      release(); await expect.poll(() => value.prompt.innerText()).toBe(entries[1].word);
      await expect.poll(() => value.requests.map(item => item.count)).toEqual([1, 5, 1]);
      expect(await value.field.isEnabled()).toBe(true);
    } finally { release(); await value.context.close(); }
  });

  it('keeps the current answer usable after a background failure and retries the same batch only on request', async () => {
    const value = await setup({ intercept: async (route, index, _body, reply) => {
      if (index === 2) { await route.fulfill({ status: 502, json: { error: '出题暂时失败。' } }); return; }
      await reply();
    } });
    try {
      await value.start(); await value.page.getByRole('alert').waitFor(); await value.page.clock.install();
      await value.field.fill(entries[0].word); await value.field.press('Enter'); await value.page.getByText('中文释义：咖啡', { exact: true }).waitFor();
      await value.page.clock.fastForward(60000); expect(value.requests).toHaveLength(2);
      await value.page.getByRole('button', { name: '重试出题', exact: true }).click(); await expect.poll(() => value.requests.length).toBe(3);
      expect(value.requests[2]).toEqual(value.requests[1]); expect(await value.prompt.innerText()).toBe(entries[0].word);
      await value.page.getByRole('button', { name: '下一题', exact: true }).click(); await expect.poll(() => value.prompt.innerText()).toBe(entries[1].word);
    } finally { await value.context.close(); }
  });

  it('ignores a late background result after leaving and does not request more words', async () => {
    let release!: () => void; const gate = new Promise<void>(done => { release = done; });
    const value = await setup({ ignoreAbort: true, intercept: async (_route, index, _body, reply) => { if (index === 2) await gate; await reply(); } });
    try {
      await value.start(); await expect.poll(() => value.requests.length).toBe(2);
      await value.page.getByRole('button', { name: '离开练习', exact: true }).click(); await value.page.locator('.kana-practice').waitFor({ state: 'detached' });
      release(); await value.page.clock.install(); await value.page.clock.fastForward(60000);
      expect(value.requests).toHaveLength(2); expect(await value.page.locator('.kana-practice').count()).toBe(0);
    } finally { release(); await value.context.close(); }
  });

  it('unlocks retry after timeout even if fetch ignores abort, without accepting the stale result', async () => {
    let release!: () => void; const gate = new Promise<void>(done => { release = done; });
    const value = await setup({ ignoreAbort: true, intercept: async (route, index, _body, reply) => {
      if (index === 1) { await gate; await route.fulfill({ json: { words: [entries[9]] } }); return; }
      await reply();
    } });
    try {
      await value.page.clock.install();
      await value.page.getByRole('button', { name: '开始练习', exact: true }).click();
      await expect.poll(() => value.requests.length).toBe(1);
      await value.page.clock.fastForward(40001); await value.page.getByText('出题超时，请重试。', { exact: true }).waitFor();
      expect(await value.page.getByRole('button', { name: '开始练习', exact: true }).isEnabled()).toBe(true);
      await value.page.getByRole('button', { name: '重试出题', exact: true }).click();
      await expect.poll(() => value.prompt.innerText()).toBe(entries[0].word);
      await expect.poll(() => value.requests.length).toBe(3);
      expect(value.requests[1]).toEqual(value.requests[0]);
      release(); await value.page.clock.fastForward(60000);
      expect(await value.prompt.innerText()).toBe(entries[0].word); expect(await value.field.isEnabled()).toBe(true);
      expect(value.requests).toHaveLength(3);
    } finally { release(); await value.context.close(); }
  });
});

describe('second Enter after a correct kana answer', () => {
  it.each([true, false])('advances once immediately and cancels automatic advancement (characters=%s)', async characters => {
    const value = await setup({ characters }); const { page, field, prompt, toggle, context } = value;
    try {
      if (!characters) await value.start();
      await page.clock.install({ time: new Date('2026-10-25T00:00:00Z') });
      await page.clock.pauseAt(new Date('2026-10-25T00:00:01Z'));
      const initial = await prompt.innerText();
      await toggle.check(); await field.fill(initial); await field.press('Enter');
      await page.getByText('正确', { exact: true }).waitFor();
      await field.dispatchEvent('keydown', { key: 'Enter', repeat: true });
      expect(await prompt.innerText()).toBe(initial);
      await field.dispatchEvent('compositionstart'); await field.press('Enter'); await field.dispatchEvent('compositionend');
      expect(await prompt.innerText()).toBe(initial);
      await field.press('Enter');
      await expect.poll(() => prompt.innerText()).not.toBe(initial);
      const second = await prompt.innerText();
      expect(await field.inputValue()).toBe('');
      expect(await field.evaluate(node => document.activeElement === node)).toBe(true);
      await page.clock.fastForward(2000);
      expect(await prompt.innerText()).toBe(second);
      expect(await page.locator('.katakana-toolbar').innerText()).toContain('已完成 1');
      await field.dispatchEvent('keydown', { key: 'Enter', repeat: true });
      expect(await prompt.innerText()).toBe(second);
      await field.fill('wrong'); await field.press('Enter');
      await page.getByText('请再试一次', { exact: true }).waitFor();
      await field.press('Enter'); expect(await prompt.innerText()).toBe(second);
      await field.fill(katakanaToHiragana(second)); await field.press('Enter');
      await page.getByText('正确', { exact: true }).waitFor();
      await page.clock.fastForward(1000);
      await expect.poll(() => prompt.innerText()).not.toBe(second);
      expect(await page.locator('.katakana-toolbar').innerText()).toContain('已完成 2');
    } finally { await context.close(); }
  });
});
