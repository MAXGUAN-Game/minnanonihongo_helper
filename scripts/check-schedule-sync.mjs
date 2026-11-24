import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from '@playwright/test';
import fastifyStatic from '@fastify/static';
import { buildApp } from '../src/server/app.ts';

const temporary = await mkdtemp(path.join(tmpdir(), 'nihongo-schedule-sync-'));
const app = buildApp({ dataDir: temporary });
const state = { version: 2, activeWeek: '2026-11-16', events: [{ id: 'remote-stable', day: 0, start: 600, end: 630, category: 'jp', title: '服务器安排', notes: '' }], legacyWeeks: {}, view: { filter: 'all', showRoutines: false, foldRoutines: false } };
let browser;
try {
  await app.register(fastifyStatic, { root: path.resolve('dist') });
  await app.inject({ method: 'PUT', url: '/api/schedule', headers: { host: '127.0.0.1' }, payload: { revision: null, state } });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  browser = await chromium.launch({ headless: true, ...(process.platform === 'win32' ? { channel: 'msedge' } : {}) });
  async function device() {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    await context.addInitScript(() => localStorage.setItem('weekly-rhythm-planner-v1', JSON.stringify({ broken: 'stale local data must not replace server data' })));
    await context.route('**/api/bootstrap', async route => { const response = await route.fetch(); const value = await response.json(); value.deployment = 'web'; await route.fulfill({ json: value }); });
    const page = await context.newPage(); page.setDefaultTimeout(7000);
    await page.goto(origin + '/#schedule');
    await page.locator('.event[data-event-id="remote-stable"]').waitFor();
    await page.getByText('已保存到服务器', { exact: true }).waitFor();
    return { context, page };
  }
  const one = await device(), two = await device();
  async function add(page, title) {
    await page.locator('#add-event').click(); await page.locator('#event-title').fill(title);
    await page.locator('#event-day').selectOption('2');
    await page.locator('#event-start').fill('15:00'); await page.locator('#event-end').fill('15:30');
    await page.locator('#event-form button[type=submit]').click();
  }
  await add(one.page, '设备一的更新'); await one.page.getByText('已保存到服务器', { exact: true }).waitFor();
  const canonical = await (await fetch(origin + '/api/schedule')).json();
  assert.ok(canonical.state.events.some(item => item.title === '设备一的更新'));
  await add(two.page, '旧设备的改动');
  await two.page.locator('#storage-notice').filter({ hasText: '其他设备已更新' }).waitFor();
  const afterConflict = await (await fetch(origin + '/api/schedule')).json();
  assert.equal(afterConflict.revision, canonical.revision);
  assert.ok(await two.page.evaluate(() => localStorage.getItem('weekly-rhythm-planner-unsynced-v1').includes('旧设备的改动')));
  await two.page.reload(); await two.page.getByText('已保存到服务器', { exact: true }).waitFor();
  assert.ok(await two.page.locator('.event-title').filter({ hasText: '设备一的更新' }).count());
  assert.equal(await two.page.locator('.event-title').filter({ hasText: '旧设备的改动' }).count(), 0);
  console.log('PASS remote authority, cross-device save/reload, stale-write rejection and local recovery copy');
  await one.context.close(); await two.context.close();
} finally { await browser?.close(); await app.close(); await rm(temporary, { recursive: true, force: true }); }
