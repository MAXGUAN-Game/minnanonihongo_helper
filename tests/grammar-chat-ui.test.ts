import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { createServer, type ViteDevServer } from 'vite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { lessons2 } from '../src/content/lessons-26-50';
import { getGrammarChatScenario } from '../src/shared/grammar-chat';
import type { Session } from '../src/shared/types';

// Browser checks use an isolated component and intercepted HTTP. No user data,
// speech service, or paid model is accessed.
const lesson = lessons2[1];
let browser: Browser;
let vite: ViteDevServer;
let origin: string;
let cacheDir: string;
const makeSession = (mode: 'grammar' | 'scenario' = 'grammar', grammarId?: string): Session => {
  const scene = mode === 'grammar' ? getGrammarChatScenario(lesson, grammarId)! : lesson.scenarios[0];
  return { id: `${mode}-session`, lessonId: lesson.id, scenarioId: scene.id, mode, ...(grammarId ? { grammarId } : {}), status: 'active', turnCount: 0,
    turns: [{ id: `${mode}-opening`, role: 'assistant', source: 'lesson', text: scene.opening.jp, translation: scene.opening.zh, createdAt: '2026-01-01T00:00:00Z' }],
    feedback: [], completedGoals: [], updatedAt: '2026-01-01T00:00:00Z' };
};
const harness = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { Conversation } from '/src/client/Conversation.tsx';
import { lessons2 } from '/src/content/lessons-26-50.ts';
import '/src/client/style.css';
const initial = await fetch('/api/test-session').then(r=>r.json());
window.speechCalls=[];
const speech={stop(){},say(...args){window.speechCalls.push(args)},speaking:false};
const settings={currentLessonId:27,dailyMinutes:15,largeText:true,furigana:true,autoplay:false,model:'mock',hasApiKey:true,setupComplete:true};
function Harness(){
  const [resume,setResume]=React.useState(initial);
  const [message,setMessage]=React.useState('');
  const refresh=async()=>setResume(await fetch('/api/test-session').then(r=>r.json()));
  return <main className="main-area"><div className="page-content"><h1>练习测试</h1><p role="status">{message}</p><section className="study-card"><Conversation lesson={lessons2[1]} resume={resume} settings={settings} speech={speech} notice={setMessage} refresh={refresh} addCorrection={async()=>{}}/></section></div></main>;
}
createRoot(document.getElementById('root')).render(<Harness/>);
`;
beforeAll(async () => {
  cacheDir = await mkdtemp(join(tmpdir(), 'language-master-grammar-ui-'));
  vite = await createServer({ configFile: false, root: process.cwd(), cacheDir,
    optimizeDeps: { include: ['react', 'react-dom/client', 'react/jsx-runtime', 'react/jsx-dev-runtime', 'lucide-react'], noDiscovery: true },
    server: { host: '127.0.0.1', port: 0 }, plugins: [{ name: 'isolated-grammar-chat',
      resolveId(id) { if (id === '/__grammar-harness.tsx') return id; }, load(id) { if (id === '/__grammar-harness.tsx') return harness; },
    }] });
  await vite.listen();
  const address = vite.httpServer!.address();
  if (!address || typeof address === 'string') throw new Error('Missing test server port');
  origin = `http://127.0.0.1:${address.port}`;
  browser = await chromium.launch({ headless: true, ...(process.platform === 'win32' ? { channel: 'msedge' } : {}) });
}, 30000);
afterAll(async () => {
  await browser?.close(); await vite?.close();
  if (cacheDir && dirname(resolve(cacheDir)) === resolve(tmpdir()) && basename(cacheDir).startsWith('language-master-grammar-ui-')) await rm(cacheDir, { recursive: true, force: true });
});

async function setup(initial: Session | null = null, resumeAfterFinish: Session | null = null): Promise<{ page: Page; context: BrowserContext; requests: Array<Record<string, unknown>>; turns: Array<Record<string, unknown>>; finished: string[] }> {
  let current = initial;
  const requests: Array<Record<string, unknown>> = [];
  const turns: Array<Record<string, unknown>> = [];
  const finished: string[] = [];
  const context = await browser.newContext({ viewport: { width: 1100, height: 1000 } });
  await context.route('**/*', async route => { if (new URL(route.request().url()).origin !== origin) await route.abort('blockedbyclient'); else await route.fallback(); });
  const page = await context.newPage(); page.setDefaultTimeout(8000);
  await page.route('**/__grammar-test', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html lang="zh-CN"><head><title>语法自由聊测试</title></head><body class="large-text"><div id="root"></div><script type="module" src="/__grammar-harness.tsx"></script></body></html>' }));
  await page.route('**/api/test-session', route => route.fulfill({ json: current?.status === 'complete' ? resumeAfterFinish : current }));
  await page.route('**/api/sessions', async route => {
    const input = route.request().postDataJSON(); requests.push(input);
    current = makeSession(input.mode === 'grammar' ? 'grammar' : 'scenario', input.grammarId);
    await route.fulfill({ json: current });
  });
  await page.route('**/api/sessions/*/turn', async route => {
    const input = route.request().postDataJSON(); turns.push(input);
    if (!current) throw new Error('Missing conversation');
    current = { ...current, turnCount: current.turnCount + 1, turns: [...current.turns,
      { id: input.clientTurnId, role: 'user', source: 'user', text: input.text, createdAt: '2026-01-01T00:01:00Z' },
      { id: `reply-${turns.length}`, role: 'assistant', source: 'deepseek', text: '窓から海が見えます。', translation: '这里表示自然进入视野。\n这句话的意思是：从窗户能看到海。', createdAt: '2026-01-01T00:01:00Z' },
    ] };
    await route.fulfill({ json: current });
  });
  await page.route('**/api/sessions/*/finish', async route => { finished.push(route.request().url()); current = { ...current!, status: 'complete' }; await route.fulfill({ json: current }); });
  await page.goto(`${origin}/__grammar-test`);
  return { page, context, requests, turns, finished };
}

describe('grammar free chat UI', () => {
  it('offers the new module alongside both authored scenes and fills an explicit whole-lesson starter without sending', async () => {
    const { page, context, requests, turns } = await setup();
    try {
      await page.getByRole('heading', { name: '语法自由聊', exact: true }).waitFor();
      expect(await page.locator('.scenario-card').count()).toBe(2);
      expect(await page.getByLabel('这次想聊什么？').inputValue()).toBe('');
      await page.getByRole('button', { name: '开始语法自由聊', exact: true }).click();
      await page.locator('#answer-draft').waitFor();
      expect(requests).toEqual([{ lessonId: 27, mode: 'grammar' }]);
      expect(await page.locator('.bubble-translation').count()).toBe(0);
      await page.getByRole('button', { name: '看中文', exact: true }).click();
      expect(await page.locator('.bubble-translation').isVisible()).toBe(true);
      await page.getByRole('button', { name: '收起中文', exact: true }).click();
      expect(await page.locator('.bubble-translation').count()).toBe(0);
      await page.getByRole('button', { name: '解释这个句型', exact: true }).click();
      expect(await page.locator('#answer-draft').inputValue()).toContain(lesson.grammar[0].title);
      expect(turns).toHaveLength(0);
      expect(await page.getByRole('button', { name: '给我一个例子', exact: true }).isDisabled()).toBe(true);
      await page.locator('#answer-draft').fill('我想问自己的问题，先别覆盖。');
      expect(await page.getByRole('button', { name: '陪我练一句', exact: true }).isDisabled()).toBe(true);
      expect(await page.locator('#answer-draft').inputValue()).toBe('我想问自己的问题，先别覆盖。');
    } finally { await context.close(); }
  });

  it('sends selected grammar scope, accepts Chinese questions, and separates Japanese replay from Chinese explanation speech', async () => {
    const { page, context, requests, turns } = await setup();
    try {
      const grammar = lesson.grammar[1];
      await page.getByLabel('这次想聊什么？').selectOption(grammar.id);
      await page.getByRole('button', { name: '开始语法自由聊', exact: true }).click();
      await page.getByRole('button', { name: '给我一个例子', exact: true }).click();
      expect(requests).toEqual([{ lessonId: 27, mode: 'grammar', grammarId: grammar.id }]);
      expect(await page.locator('#answer-draft').inputValue()).toContain(grammar.title);
      await page.locator('#answer-draft').fill('这两个词有什么区别？');
      await page.getByRole('button', { name: '确认并发送', exact: true }).click();
      await page.getByText('已聊 1 句', { exact: true }).waitFor();
      expect(turns[0].text).toBe('这两个词有什么区别？');
      expect(await page.locator('.bubble-translation').count()).toBe(0);
      expect(await page.evaluate(() => JSON.parse(localStorage.getItem('conversation-draft-grammar-session')!).usedHint)).toBe(false);
      await page.getByRole('button', { name: '听讲解', exact: true }).click();
      expect(await page.locator('.bubble-translation').count()).toBe(0);
      expect(await page.evaluate(() => JSON.parse(localStorage.getItem('conversation-draft-grammar-session')!).usedHint)).toBe(true);
      await page.getByRole('button', { name: '再听一次', exact: true }).click();
      await page.getByRole('button', { name: '慢一点', exact: true }).click();
      const calls = await page.evaluate(() => (window as unknown as { speechCalls: unknown[][] }).speechCalls);
      expect(calls).toEqual([['这里表示自然进入视野。\n这句话的意思是：从窗户能看到海。', 'zh-CN'], ['窓から海が見えます。'], ['窓から海が見えます。', 'ja-JP', .65]]);
      await page.getByRole('button', { name: '看中文', exact: true }).click();
      expect(await page.locator('.bubble-translation').last().isVisible()).toBe(true);
      await page.getByRole('button', { name: '收起中文', exact: true }).click();
      expect(await page.locator('.bubble-translation').count()).toBe(0);
      await page.getByRole('button', { name: '看中文', exact: true }).click();
      await page.locator('#answer-draft').fill('窓から山が見えます。');
      await page.getByRole('button', { name: '确认并发送', exact: true }).click();
      await page.getByText('已聊 2 句', { exact: true }).waitFor();
      expect(turns[1].usedHint).toBe(true);
      expect(await page.locator('.bubble-translation').count()).toBe(0);
    } finally { await context.close(); }
  });

  it('continues a resumed grammar chat beyond six turns and keeps its unsent draft when visiting practice choices', async () => {
    const { page, context, finished, turns } = await setup({ ...makeSession(), turnCount: 6 });
    try {
      await page.getByText('已聊 6 句', { exact: true }).waitFor();
      await page.locator('#answer-draft').fill('窓から山が見えます。');
      await page.getByRole('button', { name: '返回练习选择', exact: true }).click();
      await page.getByRole('button', { name: '继续刚才的对话', exact: true }).click();
      expect(await page.locator('#answer-draft').inputValue()).toBe('窓から山が見えます。');
      expect(finished).toHaveLength(0);
      await page.getByRole('button', { name: '确认并发送', exact: true }).click();
      await page.getByText('已聊 7 句', { exact: true }).waitFor();
      expect(turns).toHaveLength(1);
      expect(await page.getByRole('button', { name: '结束这轮', exact: true }).isVisible()).toBe(true);
      await page.getByRole('button', { name: '看中文', exact: true }).click();
      expect(await page.locator('.bubble-translation').last().isVisible()).toBe(true);
      await page.locator('#answer-draft').fill('刷新后还在的问题');
      await page.reload();
      await expect.poll(() => page.locator('#answer-draft').inputValue()).toBe('刷新后还在的问题');
      expect(await page.locator('.bubble-translation').count()).toBe(0);
    } finally { await context.close(); }
  });

  it('lets an active authored scene return to choices and start grammar chat without finishing or discarding its draft', async () => {
    const { page, context, requests, finished } = await setup(makeSession('scenario'));
    try {
      await page.getByText('0 / 6 轮', { exact: true }).waitFor();
      expect(await page.getByRole('button', { name: '看中文', exact: true }).isVisible()).toBe(true);
      await page.locator('#answer-draft').fill('こちらの部屋がいいです。');
      await page.getByRole('button', { name: '返回练习选择', exact: true }).click();
      await page.getByRole('button', { name: '继续刚才的对话', exact: true }).click();
      expect(await page.locator('#answer-draft').inputValue()).toBe('こちらの部屋がいいです。');
      await page.getByRole('button', { name: '返回练习选择', exact: true }).click();
      await page.getByRole('button', { name: '开始语法自由聊', exact: true }).click();
      await page.getByText('已聊 0 句', { exact: true }).waitFor();
      expect(finished).toHaveLength(0);
      expect(requests).toEqual([{ lessonId: 27, mode: 'grammar' }]);
      expect(await page.locator('#answer-draft').inputValue()).toBe('');
      const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('conversation-draft-scenario-session')!));
      expect(saved.draft).toBe('こちらの部屋がいいです。');
    } finally { await context.close(); }
  });

  it('keeps both scene entry payloads unchanged and remains readable at 200% zoom with keyboard access', async () => {
    const { page, context, requests } = await setup();
    try {
      await page.getByRole('heading', { name: '语法自由聊', exact: true }).waitFor();
      await page.evaluate(() => { document.documentElement.style.zoom = '2'; });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
      await page.getByLabel('这次想聊什么？').focus();
      await page.keyboard.press('Tab');
      expect(await page.getByRole('button', { name: '开始语法自由聊', exact: true }).evaluate(element => element === document.activeElement)).toBe(true);
      const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
      expect(results.violations.map(item => item.id)).toEqual([]);
      await page.locator('.scenario-card').first().click();
      await page.getByText('0 / 6 轮', { exact: true }).waitFor();
      expect(requests).toEqual([{ lessonId: 27, scenarioId: lesson.scenarios[0].id }]);
      await page.getByRole('button', { name: '返回练习选择', exact: true }).click();
      await page.locator('.scenario-card').nth(1).click();
      await page.getByText('0 / 6 轮', { exact: true }).waitFor();
      expect(requests[1]).toEqual({ lessonId: 27, scenarioId: lesson.scenarios[1].id });
    } finally { await context.close(); }
  });

  it('keeps finished grammar feedback visible when refresh reveals an older active scene, until explicitly resuming it', async () => {
    const current: Session = { ...makeSession(), turnCount: 1, feedback: [{ goal: '说明能看到海', original: '海を見えます。', corrected: { jp: '海が見えます。', kana: 'うみがみえます。', zh: '能看到海。' }, explanation: '这里用が标记自然看到的对象。', grammarId: lesson.grammar[0].id }] };
    const { page, context, finished } = await setup(current, makeSession('scenario'));
    try {
      await page.getByRole('button', { name: '结束这轮', exact: true }).click();
      await page.getByRole('heading', { name: '这次自由聊，先到这里。', exact: true }).waitFor();
      expect(finished).toHaveLength(1);
      expect(await page.getByRole('button', { name: '加入复习', exact: true }).isVisible()).toBe(true);
      expect(await page.locator('#answer-draft').count()).toBe(0);
      await page.getByRole('button', { name: '返回练习选择', exact: true }).click();
      await page.getByRole('button', { name: '继续刚才的对话', exact: true }).click();
      await page.getByText('0 / 6 轮', { exact: true }).waitFor();
      expect(await page.getByRole('button', { name: '看中文', exact: true }).isVisible()).toBe(true);
    } finally { await context.close(); }
  });
});
