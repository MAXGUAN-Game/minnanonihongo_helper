import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import AxeBuilder from '@axe-core/playwright';
import fastifyStatic from '@fastify/static';
import { buildApp } from '../src/server/app.ts';
import { registerSpeechRoutes } from '../src/server/speech.ts';

// This acceptance suite owns a temporary database and random loopback port.
// It never changes the user's data directory or calls a paid AI provider.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporary = await mkdtemp(path.join(tmpdir(), 'nihongo-browser-test-'));
let externalCalls = 0;
const app = buildApp({ dataDir: temporary, aiFetch: async () => { externalCalls++; throw new Error('Paid AI requests are prohibited in browser acceptance.'); } });
registerSpeechRoutes(app, temporary);
await app.register(fastifyStatic, { root: path.join(root, 'dist') });
await app.listen({ host: '127.0.0.1', port: 0 });
const address = app.server.address();
const base = `http://127.0.0.1:${address.port}`;
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce', acceptDownloads: true });
const page = await context.newPage();
page.setDefaultTimeout(10000);
const checks = [], failures = [], runtimeErrors = [], audits = [], zoomChecks = [];
const submittedTurns = [];
page.on('pageerror', error => runtimeErrors.push(error.message));
page.on('request', request => { if (request.url().endsWith('/turn')) submittedTurns.push(request.postDataJSON()); });
async function api(route, method = 'GET', body) {
  const response = await fetch(base + '/api' + route, { method, headers: body === undefined ? {} : { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, value: await response.json() };
}
let navigationId = 0;
async function route(hash) { await page.goto(`${base}/?acceptance=${++navigationId}#${hash}`); await page.locator('main.page-content h1').waitFor(); }
async function check(name, run) {
  try { await run(); checks.push(name); console.log('PASS ' + name); }
  catch (error) { failures.push({ check: name, error: error.message }); console.log('FAIL ' + name); }
}
async function clickStage(name) { await page.locator('.stage-tabs').getByRole('button', { name, exact: false }).click(); }
try {
  const lessons = (await api('/lessons')).value;
  await check('all 50 actual lessons and local health identity', async () => {
    assert.deepEqual(lessons.map(lesson => lesson.id), Array.from({ length: 50 }, (_, i) => i + 1));
    const health = (await api('/health')).value; assert.equal(health.app, 'nihongo-small-steps'); assert.equal(health.pid, process.pid);
  });
  await check('choose lesson 14 without an API key', async () => {
    await route('home');
    await page.getByRole('button', { name: '选择我的起点' }).click();
    await page.locator('#welcome-dialog select').selectOption('14');
    await page.locator('#welcome-dialog').getByRole('button', { name: '从这一课开始' }).click();
    await page.locator('.stage-tabs').waitFor();
    const settings = (await api('/settings')).value;
    assert.equal(settings.currentLessonId, 14); assert.equal(settings.setupComplete, true); assert.equal(settings.hasApiKey, false);
    assert.equal(await page.locator('main h1').innerText(), lessons[13].title);
  });
  await check('wrong listening answer followed by correction remains assisted', async () => {
    await route('study/14'); await clickStage('听懂');
    const listening = lessons[13].listening[0];
    const wrong = (listening.answer + 1) % listening.options.length;
    await page.locator('.answer-choices button').nth(wrong).click();
    await page.locator('.answer-feedback').waitFor();
    await page.locator('.answer-choices button').nth(listening.answer).click();
    await page.waitForFunction(() => document.querySelector('.answer-choices .correct'));
    await page.waitForFunction(async id => { const response = await fetch('/api/backup'); const backup = await response.json(); return backup.attempts.filter(item => item.itemId === id).length >= 2; }, listening.id);
    const attempts = (await api('/backup')).value.attempts.filter(item => item.itemId === listening.id);
    assert.equal(attempts.at(-1).result, 'hint'); assert.equal(attempts.at(-1).usedHint, true);
  });
  await check('speaking hints never count as independent and reload restores the cursor', async () => {
    await clickStage('自己说');
    assert.equal(await page.locator('.support-levels button').nth(2).getAttribute('aria-pressed'), 'true');
    await page.getByRole('button', { name: '看范句', exact: false }).click();
    await page.getByRole('button', { name: '自己回答', exact: false }).click();
    await page.getByRole('button', { name: '独立说出来了' }).click();
    await page.getByText('已记录：借助提示完成。下次试着少看一点。', { exact: true }).waitFor();
    const before = (await api('/backup')).value.attempts.filter(item => item.itemId === lessons[13].speaking[0].id);
    assert.equal(before.at(-1).result, 'hint');
    await page.getByRole('button', { name: '下一张' }).click();
    await page.getByRole('button', { name: '独立说出来了' }).click();
    await page.getByText('已记录：这次独立说出来了。', { exact: true }).waitFor();
    await page.reload(); await page.locator('.stage-tabs').waitFor();
    assert.match(await page.locator('.study-top').innerText(), /2 \/ 6/);
    assert.match(await page.locator('.stage-tabs [aria-current="step"]').innerText(), /自己说/);
    const bootstrap = (await api('/bootstrap')).value; assert.equal(bootstrap.totals.independent, 1);
  });
  await check('create one review card and rate a due hinted attempt without promotion', async () => {
    await page.getByRole('button', { name: '加入复习', exact: true }).click();
    await page.getByText('已加入复习。明天先回想，再看答案。', { exact: true }).waitFor();
    let backup = (await api('/backup')).value; assert.equal(backup.reviews.length, 1);
    assert.equal((await api('/reviews?due=1')).value.length, 0);
    backup.reviews[0].dueAt = new Date(Date.now() - 1000).toISOString();
    assert.equal((await api('/restore', 'POST', { backup })).status, 200);
    await route('review');
    await page.getByRole('button', { name: '给我答案提示' }).click();
    await page.getByRole('button', { name: '独立说出来了' }).click();
    await page.getByRole('heading', { name: '今天的卡点，已经练完。' }).waitFor();
    const reviewed = (await api('/reviews')).value[0]; assert.equal(reviewed.intervalIndex, 0);
    assert.equal((await api(`/reviews/${reviewed.id}/rate`, 'POST', { rating: 'good' })).status, 409);
  });
  await check('lesson opening, microphone denial and recoverable missing-key error with persistent draft', async () => {
    await route('study/14'); await clickStage('用起来');
    await page.locator('.scenario-card').first().click(); await page.locator('#answer-draft').waitFor();
    assert.match(await page.locator('.speaker-label').first().innerText(), /范句/);
    await page.evaluate(() => { Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { configurable: true, value: async () => { throw new DOMException('Denied for test', 'NotAllowedError'); } }); });
    await page.getByRole('button', { name: '或点击开始录音' }).click();
    await page.getByText(/麦克风未获允许/).waitFor();
    await page.locator('#answer-draft').fill('お願いします。');
    await page.getByRole('button', { name: /^(确认并发送|重试上一句)$/ }).click();
    await page.locator('.conversation-error').filter({ hasText: '请先在设置中填写 DeepSeek API 密钥' }).waitFor();
    assert.equal(await page.getByRole('button', { name: '重试上一句', exact: true }).count(), 0);
    await page.getByRole('button', { name: '确认并发送', exact: true }).waitFor();
    assert.equal(await page.locator('#answer-draft').inputValue(), 'お願いします。');
    const session = (await api('/bootstrap')).value.activeSession; assert.equal(session.turnCount, 0); assert.equal(session.turns.length, 1);
    await page.reload(); await page.locator('#answer-draft').waitFor();
    assert.equal(await page.locator('#answer-draft').inputValue(), 'お願いします。');
    await page.getByRole('button', { name: /^(确认并发送|重试上一句)$/ }).click();
    await page.locator('.conversation-error').filter({ hasText: '请先在设置中填写 DeepSeek API 密钥' }).waitFor();
    assert.equal(submittedTurns.length, 2); assert.notEqual(submittedTurns[0].clientTurnId, submittedTurns[1].clientTurnId); assert.equal(externalCalls, 0);
  });
  await check('settings backup download and atomic invalid/valid restore through the UI', async () => {
    await route('settings');
    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: '导出记录' }).click();
    const download = await downloadPromise; const exported = path.join(temporary, 'export.json'); await download.saveAs(exported);
    const backup = JSON.parse(await readFile(exported, 'utf8'));
    assert.equal(backup.version, 1); assert.equal('apiKey' in backup.settings, false); assert.equal('hasApiKey' in backup.settings, false);
    const invalid = structuredClone(backup); invalid.settings.currentLessonId = 15; invalid.progress[0].cursor = 999;
    await page.getByLabel('选择学习备份文件').setInputFiles({ name: 'invalid.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(invalid)) });
    await page.getByRole('button', { name: '确认恢复' }).click();
    await page.getByText('学习位置与当前课程不一致。', { exact: true }).waitFor();
    assert.equal((await api('/settings')).value.currentLessonId, 14);
    assert.deepEqual((await api('/backup')).value.progress, backup.progress);
    const valid = structuredClone(backup); valid.settings.currentLessonId = 15;
    await page.getByLabel('选择学习备份文件').setInputFiles({ name: 'valid.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(valid)) });
    await page.getByRole('button', { name: '确认恢复' }).click(); await page.getByText('学习记录已恢复。', { exact: true }).waitFor();
    assert.equal((await api('/settings')).value.currentLessonId, 15); assert.equal((await api('/settings')).value.hasApiKey, false);
  });
  await check('keyboard skip link, stage controls and main navigation', async () => {
    await route('study/14');
    await page.waitForFunction(() => document.activeElement?.tagName === 'H1');
    const hash = new URL(page.url()).hash;
    await page.locator('.skip-link').focus(); await page.keyboard.press('Enter');
    assert.equal(new URL(page.url()).hash, hash, 'skip link must not change the app route');
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'main');
    await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => document.activeElement?.tagName), 'BUTTON');
    assert.match(await page.evaluate(() => document.activeElement?.textContent || ''), /回到课程地图/);
    await page.locator('.stage-tabs button').nth(1).focus(); await page.keyboard.press('Space');
    await page.waitForFunction(() => document.querySelector('.stage-tabs [aria-current="step"]')?.textContent.includes('听懂'));
    await page.locator('.sidebar nav').getByRole('button', { name: '50 课地图' }).focus(); await page.keyboard.press('Enter');
    await page.waitForFunction(() => location.hash === '#lessons');
    await page.locator('.map-toolbar').waitFor();
    await page.locator('.map-toolbar .segmented button').nth(1).focus(); await page.keyboard.press('Space');
    assert.equal(await page.locator('.map-toolbar .segmented button').nth(1).getAttribute('aria-pressed'), 'true');
    assert.match(await page.locator('.course-number').first().innerText(), /^26$/);
  });
  await check('axe and large-text layout at desktop/mobile widths', async () => {
    await api('/settings', 'PATCH', { largeText: true });
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 900 });
      for (const view of ['home', 'lessons', 'study/14', 'review', 'settings']) {
        await route(view);
        const result = await new AxeBuilder({ page }).analyze();
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
        audits.push({ width, view, overflow, violations: result.violations.map(item => ({ id: item.id, impact: item.impact, targets: item.nodes.map(node => node.target) })) });
      }
    }
    assert.equal(audits.some(item => item.overflow), false, 'horizontal overflow found');
    assert.equal(audits.some(item => item.violations.length), false, 'axe violations found');
  });
  await check('200 percent CSS zoom readability in a 1280 px window', async () => {
    await page.setViewportSize({ width: 1280, height: 900 });
    for (const view of ['home', 'lessons', 'study/14', 'review', 'settings']) {
      await route(view);
      await page.evaluate(() => { document.documentElement.style.zoom = '2'; });
      const result = await page.evaluate(() => ({
        overflow: document.documentElement.scrollWidth > innerWidth + 1,
        mainVisible: document.querySelector('main')?.getBoundingClientRect().width > 0,
        clippedText: [...document.querySelectorAll('main h1,main h2,main h3,main p,main label,main button')].filter(element => {
          const style = getComputedStyle(element);
          return element.getClientRects().length && element.clientWidth > 0 && element.scrollWidth > element.clientWidth + 1 && ['hidden', 'clip'].includes(style.overflowX);
        }).map(element => element.textContent.trim().slice(0, 90)),
        zoom: getComputedStyle(document.documentElement).zoom,
      }));
      zoomChecks.push({ view, viewportWidth: 1280, method: 'document.documentElement.style.zoom = "2"', ...result });
    }
    assert.equal(zoomChecks.some(item => item.overflow), false, 'horizontal overflow at 200% CSS zoom');
    assert.equal(zoomChecks.some(item => !item.mainVisible || item.clippedText.length), false, 'hidden or clipped main text at 200% CSS zoom');
  });
  await check('no browser errors or paid API calls', async () => { assert.deepEqual(runtimeErrors, []); assert.equal(externalCalls, 0); });
} finally {
  await browser.close(); await app.close();
  if (!path.resolve(temporary).startsWith(path.resolve(tmpdir(), 'nihongo-browser-test-'))) throw new Error('Unexpected temporary path; refusing cleanup');
  await rm(temporary, { recursive: true, force: true });
}
console.log(JSON.stringify({ passed: checks, failures, audits, zoomChecks, runtimeErrors, paidCalls: externalCalls }, null, 2));
if (failures.length) process.exitCode = 1;
