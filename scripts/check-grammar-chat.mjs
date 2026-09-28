import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import AxeBuilder from '@axe-core/playwright';
import fastifyStatic from '@fastify/static';
import { buildApp } from '../src/server/app.ts';

// Full browser + server + SQLite flow. Only this isolated mock provider is used.
const temporary = await mkdtemp(path.join(tmpdir(), 'nihongo-grammar-browser-'));
const requests = [];
let blank = false;
const app = buildApp({ dataDir: temporary, aiFetch: async (_url, init) => {
  const body = JSON.parse(init.body);
  requests.push(body);
  const content = blank ? '   ' : JSON.stringify({ replyJa: '窓から海が見えます。', replyZh: '「見えます」表示自然进入视野。\n这句是：从窗户能看到海。', hintZh: '试着把海换成山。', completedGoals: [], corrections: [], endSession: false });
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { headers: { 'Content-Type': 'application/json' } });
} });
await app.register(fastifyStatic, { root: path.resolve('dist') });
await app.listen({ host: '127.0.0.1', port: 0 });
const base = `http://127.0.0.1:${app.server.address().port}`;
const browser = await chromium.launch({ headless: true, ...(process.platform === 'win32' ? { channel: 'msedge' } : {}) });
const context = await browser.newContext({ viewport: { width: 1280, height: 1000 }, reducedMotion: 'reduce' });
await context.route('**/*', async route => new URL(route.request().url()).origin === base ? route.continue() : route.abort('blockedbyclient'));
const page = await context.newPage();
page.setDefaultTimeout(10000);
const runtimeErrors = [];
page.on('pageerror', error => runtimeErrors.push(error.message));
const passed = [], audits = [];
async function api(route, method = 'GET', payload) {
  const response = await fetch(`${base}/api${route}`, { method, headers: payload ? { 'Content-Type': 'application/json' } : {}, ...(payload ? { body: JSON.stringify(payload) } : {}) });
  assert.ok(response.ok, `API ${route}: ${response.status}`);
  return response.json();
}
async function check(name, task) { await task(); passed.push(name); console.log('PASS ' + name); }
async function audit(label) {
  const violations = (await new AxeBuilder({ page }).analyze()).violations;
  assert.deepEqual(violations.map(item => ({ id: item.id, nodes: item.nodes.length })), [], label);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
  assert.equal(overflow, false, label);
  audits.push({ label, violations: [], overflow });
}
try {
  await api('/settings', 'PATCH', { apiKey: 'mock-grammar-browser-only', currentLessonId: 27, setupComplete: true, largeText: true, autoplay: false });
  await page.goto(base + '/#study/27');
  await page.locator('.stage-tabs').getByRole('button', { name: '用起来' }).click();
  await check('new grammar module keeps both authored scenarios and supports whole-lesson or focused scope', async () => {
    await page.locator('.grammar-chat-card').waitFor();
    assert.equal(await page.locator('.scenario-card').count(), 2);
    assert.equal(await page.locator('#grammar-chat-scope option').count(), 6);
    await audit('picker desktop large text');
    await mkdir('test-results', { recursive: true });
    await page.locator('.scenario-picker').screenshot({ path: 'test-results/grammar-chat-entry.png' });
    await page.locator('#grammar-chat-scope').selectOption('l27-g2');
    await page.getByRole('button', { name: '开始语法自由聊', exact: true }).click();
    await page.locator('#answer-draft').waitFor();
    assert.equal(await page.locator('.bubble-translation').count(), 0);
    const session = (await api('/bootstrap')).activeSession;
    assert.equal(session.mode, 'grammar'); assert.equal(session.grammarId, 'l27-g2');
    assert.equal(requests.length, 0);
  });
  await check('Chinese starters require confirmation, translations appear only on request, and chats continue past six turns', async () => {
    await page.getByRole('button', { name: '给我一个例子', exact: true }).click();
    const draft = page.locator('#answer-draft');
    assert.ok((await draft.inputValue()).includes('見えます'));
    assert.equal(requests.length, 0);
    for (let round = 1; round <= 7; round++) {
      if (round > 1) await draft.fill('窓から海が見えます。');
      await page.getByRole('button', { name: '确认并发送', exact: true }).click();
      await page.getByText(`已聊 ${round} 句`, { exact: true }).waitFor();
      assert.equal(await page.locator('.bubble-translation').count(), 0);
      if (round === 1) {
        await page.getByRole('button', { name: '看中文', exact: true }).click();
        assert.equal(await page.locator('.bubble-translation').last().isVisible(), true);
        await page.getByRole('button', { name: '收起中文', exact: true }).click();
        assert.equal(await page.locator('.bubble-translation').count(), 0);
        await page.getByRole('button', { name: '看中文', exact: true }).click();
      }
    }
    assert.equal((await api('/bootstrap')).activeSession.status, 'active');
    assert.equal(await page.locator('.bubble-translation').count(), 0);
    const session = (await api('/bootstrap')).activeSession;
    const backup = await api('/backup');
    assert.equal(session.turnCount, 7); assert.equal(session.turns.length, 15);
    assert.deepEqual(backup.attempts, []); assert.deepEqual(session.completedGoals, []);
    const modelContext = JSON.parse(requests.at(-1).messages[0].content.split('\n当前练习数据：')[1]);
    assert.equal(modelContext.conversationMode, 'grammar'); assert.deepEqual(modelContext.focusGrammarIds, ['l27-g2']);
  });
  await check('return, resume and page reload preserve unsent Chinese questions and grammar scope', async () => {
    await page.locator('#answer-draft').fill('请再解释一下和可能形的区别。');
    await page.getByRole('button', { name: '返回练习选择', exact: true }).click();
    await page.getByRole('button', { name: '继续刚才的对话', exact: true }).click();
    assert.equal(await page.locator('#answer-draft').inputValue(), '请再解释一下和可能形的区别。');
    await page.getByRole('button', { name: '看中文', exact: true }).click();
    assert.equal(await page.locator('.bubble-translation').last().isVisible(), true);
    await page.reload();
    await page.locator('#answer-draft').waitFor();
    assert.equal(await page.locator('#answer-draft').inputValue(), '请再解释一下和可能形的区别。');
    assert.equal(await page.locator('.bubble-translation').count(), 0);
    await page.getByRole('heading', { name: '見えます・聞こえます', exact: true }).waitFor();
  });
  await check('blank replies keep the draft and recover through normal send without duplicated turns', async () => {
    blank = true; const before = requests.length;
    await page.getByRole('button', { name: '确认并发送', exact: true }).click();
    await page.locator('.conversation-error').waitFor();
    assert.equal(requests.length, before + 2);
    assert.equal((await api('/bootstrap')).activeSession.turnCount, 7);
    assert.equal(await page.getByRole('button', { name: '重试上一句', exact: true }).count(), 0);
    blank = false;
    await page.locator('#answer-draft').fill('今度は聞こえますを練習したいです。');
    await page.getByRole('button', { name: '确认并发送', exact: true }).click();
    await page.getByText('已聊 8 句', { exact: true }).waitFor();
    assert.equal(requests.at(-1).messages.at(-1).content, '今度は聞こえますを練習したいです。');
  });
  await check('grammar chat stays readable at 200 percent zoom and mobile width', async () => {
    await audit('chat desktop large text');
    await page.locator('.conversation').screenshot({ path: 'test-results/grammar-chat-conversation.png' });
    await page.evaluate(() => { document.documentElement.style.zoom = '2'; });
    await audit('chat desktop 200 percent CSS zoom');
    await page.evaluate(() => { document.documentElement.style.zoom = '1'; });
    await page.setViewportSize({ width: 390, height: 844 });
    await audit('chat mobile large text');
    await page.getByRole('button', { name: '返回练习选择', exact: true }).click();
    await audit('picker mobile large text');
    await page.getByRole('button', { name: '继续刚才的对话', exact: true }).click();
  });
  await check('manual finish preserves the transcript and mixed-mode backup restores', async () => {
    const previous = (await api('/bootstrap')).activeSession;
    await page.getByRole('button', { name: '结束这轮', exact: true }).click();
    await page.getByRole('heading', { name: '这次自由聊，先到这里。', exact: true }).waitFor();
    const fixed = await api('/sessions', 'POST', { lessonId: 27, scenarioId: 'l27-scene1' });
    const backup = await api('/backup');
    assert.equal(backup.sessions.find(item => item.id === previous.id).status, 'complete');
    assert.equal(backup.sessions.find(item => item.id === previous.id).turnCount, 8);
    assert.ok(!JSON.stringify(backup).includes('mock-grammar-browser-only'));
    await api('/restore', 'POST', { backup });
    assert.equal((await api('/sessions/' + previous.id)).turns.length, 17);
    assert.equal((await api('/sessions/' + fixed.id)).turnCount, 0);
    assert.deepEqual(runtimeErrors, []);
  });
  await writeFile('test-results/grammar-chat-browser.json', JSON.stringify({ passed, audits, mockProviderCalls: requests.length, paidCalls: 0, runtimeErrors }, null, 2));
  console.log(JSON.stringify({ passed: passed.length, audits: audits.length, paidCalls: 0 }));
} finally {
  await browser.close(); await app.close();
  const resolved = path.resolve(temporary);
  if (path.dirname(resolved) !== path.resolve(tmpdir()) || !path.basename(resolved).startsWith('nihongo-grammar-browser-')) throw new Error('Unexpected test directory');
  await rm(resolved, { recursive: true, force: true });
}
