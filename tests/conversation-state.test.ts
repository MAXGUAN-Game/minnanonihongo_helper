import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Page, type Route } from '@playwright/test';
import { createServer, type ViteDevServer } from 'vite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import type { Session } from '../src/shared/types';

// Real browser interaction with an isolated component; all AI/network responses
// are intercepted. These regressions never use a key or consume API credit.
let vite: ViteDevServer;
let browser: Browser;
let origin: string;
let cacheDir: string;
const session = (id = 'session-one'): Session => ({ id, lessonId: 14, scenarioId: 'l14-scene1', status: 'active', turnCount: 0,
  turns: [{ id: `${id}-opening`, role: 'assistant', source: 'lesson', text: '住所を書いてください。', translation: '请写地址。', createdAt: '2026-01-01T00:00:00Z' }], feedback: [], completedGoals: [], updatedAt: '2026-01-01T00:00:00Z' });
function reply(previous: Session, turn: { clientTurnId: string; text: string }): Session {
  return { ...previous, turnCount: previous.turnCount + 1, turns: [...previous.turns,
    { id: turn.clientTurnId, role: 'user', source: 'user', text: turn.text, createdAt: '2026-01-01T00:01:00Z' },
    { id: `reply-${previous.turnCount}`, role: 'assistant', source: 'deepseek', text: 'はい、ありがとうございます。', translation: '好的，谢谢。', createdAt: '2026-01-01T00:01:00Z' }], updatedAt: '2026-01-01T00:01:00Z' };
}
const harness = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { Conversation } from '/src/client/Conversation.tsx';
import { lessons1 } from '/src/content/lessons-01-25.ts';
const settings = {currentLessonId:14,dailyMinutes:15,largeText:false,furigana:true,autoplay:false,model:'mock',hasApiKey:true,setupComplete:true};
const speech = {stop(){},say(){},speaking:false,getEpoch(){return 0},sayAuto(){},playUrl(){}};
const initial = await fetch('/api/test-session').then(r=>r.json());
function Harness(){
  const [resume,setResume] = React.useState(initial);
  const [visible,setVisible] = React.useState(true);
  const [message,setMessage] = React.useState('');
  const swap = () => setResume({...initial,id:resume.id==='session-one'?'session-two':'session-one'});
  return <><button onClick={swap}>测试切换会话</button><button onClick={()=>setVisible(v=>!v)}>测试切换挂载</button><p role="alert">{message}</p>{visible&&<Conversation lesson={lessons1[13]} resume={resume} settings={settings} speech={speech} notice={setMessage} refresh={async()=>{if(new URLSearchParams(location.search).has('refresh-fails'))throw new Error('模拟进度刷新失败');}} addCorrection={async()=>{}}/>}</>;
}
createRoot(document.getElementById('root')).render(<Harness/>);
`;
beforeAll(async () => {
  cacheDir = await mkdtemp(join(tmpdir(), 'language-master-conversation-test-'));
  vite = await createServer({ configFile: false, root: process.cwd(), cacheDir,
    optimizeDeps: { include: ['react', 'react-dom/client', 'react/jsx-runtime', 'react/jsx-dev-runtime', 'lucide-react'], noDiscovery: true },
    server: { host: '127.0.0.1', port: 0 }, plugins: [{
    name: 'isolated-conversation-test', resolveId(id) { if (id === '/__conversation-harness.tsx') return id; },
    load(id) { if (id === '/__conversation-harness.tsx') return harness; },
  }] });
  await vite.listen();
  const address = vite.httpServer!.address();
  if (!address || typeof address === 'string') throw new Error('Missing test server port');
  origin = `http://127.0.0.1:${address.port}`;
  browser = await chromium.launch({ headless: true, ...(process.platform === 'win32' ? { channel: 'msedge' } : {}) });
}, 30000);
afterAll(async () => {
  await browser?.close(); await vite?.close();
  if (cacheDir && dirname(resolve(cacheDir)) === resolve(tmpdir()) && basename(cacheDir).startsWith('language-master-conversation-test-')) {
    await rm(cacheDir, { recursive: true, force: true });
  }
});

async function pageFor(getSession: () => Session, onTurn: (route: Route) => Promise<void>): Promise<{ page: Page; context: BrowserContext }> {
  const context = await browser.newContext();
  await context.route('**/*', async route => {
    if (new URL(route.request().url()).origin !== origin) await route.abort('blockedbyclient');
    else await route.fallback();
  });
  const page = await context.newPage();
  page.setDefaultTimeout(5000);
  await page.route('**/__conversation-test*', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body><div id="root"></div><script type="module" src="/__conversation-harness.tsx"></script></body></html>' }));
  await page.route('**/api/test-session', route => route.fulfill({ json: getSession() }));
  await page.route('**/api/sessions/*/turn', onTurn);
  return { page, context };
}

describe('conversation recovery in the browser', () => {
  it('treats an uncoded server failure as uncertain and retries the same hinted request after reload, preserving edits', async () => {
    let current = session();
    const requests: Array<{ text: string; clientTurnId: string; usedHint: boolean }> = [];
    const { page, context } = await pageFor(() => current, async route => {
      const input = route.request().postDataJSON(); requests.push(input);
      if (requests.length === 1) await route.fulfill({ status: 503, json: { error: '模拟网关错误，无法确认结果' } });
      else { current = reply(current, input); await route.fulfill({ json: current }); }
    });
    try {
      await page.goto(`${origin}/__conversation-test`);
      await page.locator('#answer-draft').fill('もう一度お願いします。');
      await page.getByRole('button', { name: '看中文', exact: true }).click();
      await page.getByRole('button', { name: '确认并发送', exact: true }).click();
      await page.getByRole('button', { name: '重试上一句', exact: true }).waitFor();
      expect(await page.locator('.answer-zone').getByRole('alert').isVisible()).toBe(true);
      expect(await page.locator('.answer-zone').getByRole('alert').textContent()).toContain('无法确认');
      expect(requests[0]!.usedHint).toBe(true);
      await page.reload();
      await expect.poll(() => page.locator('#answer-draft').inputValue()).toBe('もう一度お願いします。');
      await page.locator('#answer-draft').fill('ゆっくりお願いします。');
      expect(await page.locator('.pending-turn [lang="ja"]').textContent()).toBe('もう一度お願いします。');
      expect(await page.locator('.pending-turn').textContent()).toContain('修改后的文字保留');
      await page.getByRole('button', { name: '重试上一句', exact: true }).click();
      await page.getByRole('button', { name: '确认并发送', exact: true }).waitFor();
      expect(requests[1]).toEqual(requests[0]);
      expect(await page.locator('#answer-draft').inputValue()).toBe('ゆっくりお願いします。');
      await page.getByRole('button', { name: '确认并发送', exact: true }).click();
      await expect.poll(() => page.locator('#answer-draft').inputValue()).toBe('');
      expect(requests[2]!.clientTurnId).not.toBe(requests[0]!.clientTurnId);
      expect(requests[2]!.text).toBe('ゆっくりお願いします。');
    } finally { await context.close(); }
  });

  it('releases repeated AI_INVALID_RESPONSE rejections so edited drafts send as new hinted requests', async () => {
    let current = session();
    const requests: Array<{ text: string; clientTurnId: string; usedHint: boolean }> = [];
    const { page, context } = await pageFor(() => current, async route => {
      const input = route.request().postDataJSON(); requests.push(input);
      if (requests.length <= 2) await route.fulfill({ status: 502, json: { code: 'AI_INVALID_RESPONSE', error: '对话服务返回的内容不完整。这轮没有计入，请重新发送。' } });
      else { current = reply(current, input); await route.fulfill({ json: current }); }
    });
    try {
      await page.goto(`${origin}/__conversation-test`);
      await page.locator('#answer-draft').fill('住所ですね。');
      await page.getByRole('button', { name: '给提示', exact: true }).click();
      for (const text of ['住所ですね。', 'もう一度お願いします。']) {
        await page.locator('#answer-draft').fill(text);
        await page.getByRole('button', { name: '确认并发送', exact: true }).click();
        await page.locator('.answer-zone').getByRole('alert').waitFor();
        expect(await page.locator('.answer-zone').getByRole('alert').textContent()).toContain('你的回答已保留');
        expect(await page.locator('#answer-draft').inputValue()).toBe(text);
        expect(await page.getByRole('button', { name: '重试上一句', exact: true }).count()).toBe(0);
        const cached = await page.evaluate(() => JSON.parse(localStorage.getItem('conversation-draft-session-one')!));
        expect(cached).toMatchObject({ draft: text, usedHint: true, pendingRequest: null });
      }
      await page.reload();
      await expect.poll(() => page.locator('#answer-draft').inputValue()).toBe('もう一度お願いします。');
      await page.locator('#answer-draft').fill('ゆっくりお願いします。');
      await page.getByRole('button', { name: '确认并发送', exact: true }).click();
      await expect.poll(() => page.locator('#answer-draft').inputValue()).toBe('');
      expect(requests.map(value => value.text)).toEqual(['住所ですね。', 'もう一度お願いします。', 'ゆっくりお願いします。']);
      expect(new Set(requests.map(value => value.clientTurnId)).size).toBe(3);
      expect(requests.every(value => value.usedHint)).toBe(true);
      expect(current.turnCount).toBe(1);
      expect(await page.locator('.answer-zone').getByRole('alert').count()).toBe(0);
    } finally { await context.close(); }
  });

  it('allows finishing after a definite rejection while keeping the unsent draft', async () => {
    let current = session(); let finishes = 0;
    const { page, context } = await pageFor(() => current, route => route.fulfill({ status: 502, json: { code: 'AI_INVALID_RESPONSE', error: '本轮没有计入，请重新发送。' } }));
    await page.route('**/api/sessions/*/finish', async route => {
      finishes++; current = { ...current, status: 'complete' }; await route.fulfill({ json: current });
    });
    try {
      await page.goto(`${origin}/__conversation-test`);
      await page.locator('#answer-draft').fill('住所ですね。');
      await page.getByRole('button', { name: '确认并发送', exact: true }).click();
      await page.locator('.answer-zone').getByRole('alert').waitFor();
      await page.getByRole('button', { name: '结束这轮', exact: true }).click();
      await page.getByText('本轮已结束', { exact: true }).waitFor();
      expect(finishes).toBe(1);
      expect(current.turnCount).toBe(0);
      const cached = await page.evaluate(() => JSON.parse(localStorage.getItem('conversation-draft-session-one')!));
      expect(cached).toMatchObject({ draft: '住所ですね。', pendingRequest: null });
    } finally { await context.close(); }
  });

  it('keeps the latest edited draft when an old uncertain request is later definitely rejected', async () => {
    const requests: Array<{ text: string; clientTurnId: string; usedHint: boolean }> = [];
    const { page, context } = await pageFor(() => session(), async route => {
      const input = route.request().postDataJSON(); requests.push(input);
      if (requests.length === 1) await route.abort('failed');
      else if (requests.length === 2) await route.fulfill({ status: 502, json: { code: 'AI_INVALID_RESPONSE', error: '对话服务连续返回空白内容。这轮没有计入，请重新发送。' } });
      else await route.fulfill({ json: reply(session(), input) });
    });
    try {
      await page.goto(`${origin}/__conversation-test`);
      await page.locator('#answer-draft').fill('住所ですね。');
      await page.getByRole('button', { name: '确认并发送', exact: true }).click();
      await page.getByRole('button', { name: '重试上一句', exact: true }).waitFor();
      await page.reload();
      await page.locator('#answer-draft').fill('もう一度お願いします。');
      await page.getByRole('button', { name: '给提示', exact: true }).click();
      await page.getByRole('button', { name: '重试上一句', exact: true }).click();
      await page.getByRole('button', { name: '确认并发送', exact: true }).waitFor();
      expect(requests[1]).toEqual(requests[0]);
      expect(await page.locator('#answer-draft').inputValue()).toBe('もう一度お願いします。');
      expect(await page.locator('.answer-zone').getByRole('alert').textContent()).toContain('连续返回空白');
      const cached = await page.evaluate(() => JSON.parse(localStorage.getItem('conversation-draft-session-one')!));
      expect(cached).toMatchObject({ draft: 'もう一度お願いします。', usedHint: true, pendingRequest: null });
      await page.getByRole('button', { name: '确认并发送', exact: true }).click();
      await expect.poll(() => page.locator('#answer-draft').inputValue()).toBe('');
      expect(requests[2]).toMatchObject({ text: 'もう一度お願いします。', usedHint: true });
      expect(requests[2]!.clientTurnId).not.toBe(requests[0]!.clientTurnId);
    } finally { await context.close(); }
  });

  it('retries a committed turn after a lost response without duplicating it or changing its payload', async () => {
    let current = session(); let commits = 0;
    const requests: Array<{ text: string; clientTurnId: string; usedHint: boolean }> = [];
    const { page, context } = await pageFor(() => current, async route => {
      const input = route.request().postDataJSON(); requests.push(input);
      if (!current.turns.some(turn => turn.id === input.clientTurnId)) { commits++; current = reply(current, input); }
      if (requests.length === 1) await route.abort('failed');
      else await route.fulfill({ json: current });
    });
    try {
      await page.goto(`${origin}/__conversation-test`);
      await page.locator('#answer-draft').fill('はい、わかりました。');
      await page.getByRole('button', { name: '确认并发送', exact: true }).click();
      await page.getByRole('button', { name: '重试上一句', exact: true }).waitFor();
      await page.locator('#answer-draft').fill('もう一度お願いします。');
      await page.getByRole('button', { name: '给提示', exact: true }).click();
      expect(await page.locator('.pending-turn [lang="ja"]').textContent()).toBe('はい、わかりました。');
      await page.getByRole('button', { name: '重试上一句', exact: true }).click();
      await page.getByRole('button', { name: '确认并发送', exact: true }).waitFor();
      expect(requests[1]).toEqual(requests[0]);
      expect(requests[1]!.usedHint).toBe(false);
      expect(commits).toBe(1);
      expect(current.turnCount).toBe(1);
      expect(await page.locator('#answer-draft').inputValue()).toBe('もう一度お願いします。');
      expect(await page.locator('.answer-zone').getByRole('alert').count()).toBe(0);
      const cached = await page.evaluate(() => JSON.parse(localStorage.getItem('conversation-draft-session-one')!));
      expect(cached).toMatchObject({ draft: 'もう一度お願いします。', usedHint: true, pendingRequest: null });
    } finally { await context.close(); }
  });

  it('does not label a committed turn as failed when refreshing the progress overview fails', async () => {
    let current = session(); let calls = 0;
    const { page, context } = await pageFor(() => current, async route => {
      calls++; current = reply(current, route.request().postDataJSON()); await route.fulfill({ json: current });
    });
    try {
      await page.goto(`${origin}/__conversation-test?refresh-fails`);
      await page.locator('#answer-draft').fill('住所ですね。');
      await page.getByRole('button', { name: '确认并发送', exact: true }).click();
      await page.getByText(/本句已发送，回复已保存/).waitFor();
      expect(calls).toBe(1);
      expect(await page.locator('#answer-draft').inputValue()).toBe('');
      expect(await page.locator('.answer-zone').getByRole('alert').count()).toBe(0);
      expect(await page.getByRole('button', { name: '重试上一句', exact: true }).count()).toBe(0);
      const cached = await page.evaluate(() => JSON.parse(localStorage.getItem('conversation-draft-session-one')!));
      expect(cached.pendingRequest).toBeNull();
    } finally { await context.close(); }
  });

  it('recognizes an already committed request on reload without another paid submission', async () => {
    let current = session(); let calls = 0;
    const { page, context } = await pageFor(() => current, async route => {
      calls++; current = reply(current, route.request().postDataJSON()); await route.abort('failed');
    });
    try {
      await page.goto(`${origin}/__conversation-test`);
      await page.locator('#answer-draft').fill('はい、わかりました。');
      await page.getByRole('button', { name: '确认并发送', exact: true }).click();
      await page.getByRole('button', { name: '重试上一句', exact: true }).waitFor();
      await page.reload();
      await page.getByRole('button', { name: '确认并发送', exact: true }).waitFor();
      expect(await page.locator('#answer-draft').inputValue()).toBe('');
      const cached = await page.evaluate(() => JSON.parse(localStorage.getItem('conversation-draft-session-one')!));
      expect(cached.pendingRequest).toBeNull(); expect(calls).toBe(1);
    } finally { await context.close(); }
  });

  it('keeps pending IDs across unmount and isolates drafts when resume changes', async () => {
    const requests: Array<{ text: string; clientTurnId: string; usedHint: boolean }> = [];
    const { page, context } = await pageFor(() => session(), async route => {
      requests.push(route.request().postDataJSON());
      if (requests.length === 1) { await new Promise(resolve => setTimeout(resolve, 300)); await route.abort('failed').catch(() => {}); }
      else await route.fulfill({ json: reply(session(), route.request().postDataJSON()) });
    });
    try {
      await page.goto(`${origin}/__conversation-test`);
      await page.locator('#answer-draft').fill('住所ですね。');
      await page.getByRole('button', { name: '给提示', exact: true }).click();
      await page.getByRole('button', { name: '确认并发送', exact: true }).click();
      await expect.poll(() => requests.length).toBe(1);
      await page.getByRole('button', { name: '测试切换挂载' }).click();
      await page.getByRole('button', { name: '测试切换挂载' }).click();
      await expect.poll(() => page.locator('#answer-draft').inputValue()).toBe('住所ですね。');
      await page.getByRole('button', { name: '测试切换会话' }).click();
      await expect.poll(() => page.locator('#answer-draft').inputValue()).toBe('');
      await page.locator('#answer-draft').fill('第二个会话的草稿');
      await page.getByRole('button', { name: '测试切换会话' }).click();
      await expect.poll(() => page.locator('#answer-draft').inputValue()).toBe('住所ですね。');
      await page.getByRole('button', { name: '重试上一句', exact: true }).click();
      await expect.poll(() => page.locator('#answer-draft').inputValue()).toBe('');
      expect(requests[1]).toEqual(requests[0]);
      const other = await page.evaluate(() => JSON.parse(localStorage.getItem('conversation-draft-session-two')!));
      expect(other.draft).toBe('第二个会话的草稿');
    } finally { await context.close(); }
  });
});
