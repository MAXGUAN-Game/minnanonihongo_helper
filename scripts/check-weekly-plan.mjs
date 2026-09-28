import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from '@playwright/test';

// Each check uses a fresh browser context; no user profile or schedule is touched.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const url = pathToFileURL(path.join(root, 'weekly-plan.html')).href;
const storageKey = 'weekly-rhythm-planner-v1';
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const passed = [], failures = [], browserErrors = [];

async function fixture(options = {}, init) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true, ...options });
  if (init) await context.addInitScript(init);
  const page = await context.newPage();
  page.setDefaultTimeout(5000);
  page.on('pageerror', error => browserErrors.push(error.message));
  page.on('dialog', dialog => dialog.accept());
  await page.goto(url);
  await page.locator('.day').first().waitFor();
  return { context, page };
}
async function check(name, run, options, init) {
  let context;
  try {
    const current = await fixture(options, init); context = current.context;
    await run(current.page); passed.push(name); console.log('PASS ' + name);
  } catch (error) {
    failures.push({ check: name, error: error.stack }); console.error('FAIL ' + name + ': ' + error.message);
  } finally { await context?.close(); }
}
const readState = page => page.evaluate(key => JSON.parse(localStorage.getItem(key)), storageKey);
const currentEvents = state => state.weeks[state.activeWeek].events;
const card = (page, title, day) => page.locator(`${day === undefined ? '' : `.day[data-day="${day}"] `}.event`).filter({ has: page.locator('.event-title', { hasText: title }) });
async function fillEvent(page, { title, day = 5, start = '14:00', end = '14:30', category = 'game', notes = '' }) {
  await page.locator('#event-title').fill(title);
  await page.locator('#event-day').selectOption(String(day));
  await page.locator('#event-category').selectOption(category);
  await page.locator('#event-start').fill(start);
  await page.locator('#event-end').fill(end);
  await page.locator('#event-notes').fill(notes);
}
async function save(page) {
  await page.locator('#event-form button[type="submit"]').click();
  await page.locator('#event-dialog').waitFor({ state: 'hidden' });
}
async function add(page, values) { await page.locator('#add-event').click(); await fillEvent(page, values); await save(page); }
async function exportState(page) {
  const downloading = page.waitForEvent('download'); await page.locator('#export-btn').click();
  const download = await downloading; const stream = await download.createReadStream(); const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  assert.match(download.suggestedFilename(), /\.json$/);
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
async function importText(page, text) {
  await page.locator('#import-file').setInputFiles({ name: 'plan.json', mimeType: 'application/json', buffer: Buffer.from(text) });
  await page.waitForFunction(() => document.querySelector('#import-file').value === '');
}

try {
  await check('default weekly totals and weekday rhythm', async page => {
    const state = await readState(page); const events = currentEvents(state);
    const totals = Object.fromEntries(['japanese', 'fitness', 'game'].map(category => [category, events.filter(e => e.category === category).reduce((n, e) => n + e.end - e.start, 0)]));
    assert.deepEqual(totals, { japanese: 520, fitness: 270, game: 210 });
    assert.equal(Object.values(totals).reduce((n, value) => n + value, 0), 1000);
    assert.match(await page.locator('#week-total').innerText(), /16 小时 40 分钟/);
    for (const [category, text] of Object.entries({ japanese: '8 小时 40 分钟', fitness: '4 小时 30 分钟', game: '3 小时 30 分钟' })) {
      assert.equal(await page.locator(`.stat[data-cat="${category}"] .stat-value`).getAttribute('aria-label'), text);
    }
    assert.deepEqual(events.filter(e => e.category === 'fitness').map(e => e.day), [0, 2, 4]);
    assert.equal(events.filter(e => e.day >= 5 && e.category !== 'routine').length, 0);
    assert.equal(await page.locator('.event[data-category="routine"]').count(), 0);
    await page.locator('#show-routines').check();
    assert.ok(await page.locator('.event[data-category="routine"]').count() > 0);
    await page.locator('[data-filter="game"]').click(); await page.locator('#show-routines').uncheck();
    assert.equal(await page.locator('.event').count(), 5);
    assert.equal(await page.locator('.event:not([data-category="game"])').count(), 0);
    await page.reload(); assert.equal(await page.locator('[data-filter="game"]').getAttribute('aria-pressed'), 'true');
  });

  await check('add, edit, reload persistence, delete and undo', async page => {
    const title = '验收：敌人击退';
    await add(page, { title, notes: '保留备注与中文。' });
    let event = currentEvents(await readState(page)).find(e => e.title === title);
    assert.ok(event); assert.equal(event.end - event.start, 30);
    await card(page, title).click();
    await page.locator('#event-end').fill('15:00'); await page.locator('#event-title').fill(title + '改'); await save(page);
    await page.reload();
    event = currentEvents(await readState(page)).find(e => e.title === title + '改');
    assert.equal(event.end - event.start, 60); assert.equal(event.notes, '保留备注与中文。');
    assert.equal(await card(page, title + '改').count(), 1);
    await card(page, title + '改').click(); await page.locator('#delete-event').click();
    assert.equal(await card(page, title + '改').count(), 0);
    await page.locator('#undo-btn').click();
    assert.equal(await card(page, title + '改').count(), 1);
    await page.reload(); assert.ok(currentEvents(await readState(page)).some(e => e.id === event.id));
  });

  await check('copies to multiple days have independent IDs and edits', async page => {
    await page.locator('#add-event').click(); await fillEvent(page, { title: '多日练习', day: 5 });
    await page.locator('#copy-details summary').click();
    assert.equal(await page.locator('input[name="copyDay"][value="5"]').isDisabled(), true);
    await page.locator('input[name="copyDay"][value="6"]').check();
    await page.locator('input[name="copyDay"][value="1"]').check(); await save(page);
    const copies = currentEvents(await readState(page)).filter(e => e.title === '多日练习');
    assert.deepEqual(copies.map(e => e.day).sort(), [1, 5, 6]); assert.equal(new Set(copies.map(e => e.id)).size, 3);
    await card(page, '多日练习', 6).click(); await page.locator('#event-title').fill('只改周日'); await save(page);
    assert.equal(await card(page, '多日练习').count(), 2); assert.equal(await card(page, '只改周日', 6).count(), 1);
    await page.reload(); assert.equal(await card(page, '多日练习', 5).count(), 1);
  });

  await check('week navigation, copy overwrite, isolation and undo', async page => {
    await add(page, { title: '本周任务' }); const original = await readState(page);
    await page.locator('#next-week').click(); assert.equal(await card(page, '本周任务').count(), 0);
    await add(page, { title: '下周旧任务' }); const nextWeek = (await readState(page)).activeWeek;
    await page.locator('#prev-week').click(); assert.equal((await readState(page)).activeWeek, original.activeWeek);
    assert.equal(await card(page, '下周旧任务').count(), 0);
    await page.locator('#copy-week').click();
    let state = await readState(page); assert.equal(state.activeWeek, nextWeek);
    assert.equal(await card(page, '本周任务').count(), 1); assert.equal(await card(page, '下周旧任务').count(), 0);
    const originalIds = new Set(state.weeks[original.activeWeek].events.map(e => e.id));
    assert.ok(currentEvents(state).every(e => !originalIds.has(e.id)));
    await page.locator('#undo-btn').click(); state = await readState(page);
    assert.equal(state.activeWeek, original.activeWeek); assert.ok(state.weeks[nextWeek].events.some(e => e.title === '下周旧任务'));
    await page.locator('#copy-week').click(); await card(page, '本周任务').click();
    await page.locator('#event-title').fill('下周独立修改'); await save(page);
    await page.locator('#this-week').click(); assert.equal(await card(page, '本周任务').count(), 1);
    assert.equal(await card(page, '下周独立修改').count(), 0);
    await page.reload(); await page.locator('#next-week').click(); assert.equal(await card(page, '下周独立修改').count(), 1);
  });

  await check('midnight end, invalid order, equal times and missing input', async page => {
    await add(page, { title: '午夜收尾', start: '23:40', end: '00:00' });
    const event = currentEvents(await readState(page)).find(e => e.title === '午夜收尾');
    assert.equal(event.start, 1420); assert.equal(event.end, 1440);
    assert.match(await card(page, '午夜收尾').innerText(), /24:00/);
    await card(page, '午夜收尾').click(); assert.equal(await page.locator('#event-end').inputValue(), '00:00');
    await page.locator('#cancel-dialog').click();
    const before = await readState(page);
    await page.locator('#add-event').click(); await fillEvent(page, { title: '不能保存', start: '20:00', end: '19:00' });
    await page.locator('#event-form button[type="submit"]').click(); assert.equal(await page.locator('#form-error').isVisible(), true);
    await page.locator('#event-end').fill('20:00'); await page.locator('#event-form button[type="submit"]').click();
    assert.equal(await page.locator('#form-error').isVisible(), true);
    await page.locator('#event-start').fill(''); await page.locator('#event-form button[type="submit"]').click();
    assert.equal(await page.locator('#event-start').evaluate(node => node.validity.valueMissing), true);
    await page.locator('#event-start').fill('19:00'); await page.locator('#event-title').fill('   ');
    await page.locator('#event-form button[type="submit"]').click(); assert.match(await page.locator('#form-error').innerText(), /名称/);
    assert.deepEqual(await readState(page), before); await page.locator('#cancel-dialog').click();
  });

  await check('JSON round trip, invalid import preservation and import undo', async page => {
    await add(page, { title: '备份测试', notes: '<script>window.bad = true</script>' });
    const backup = await exportState(page); assert.deepEqual(backup, await readState(page));
    await importText(page, '{broken json'); assert.deepEqual(await readState(page), backup);
    assert.match(await page.locator('#toast').innerText(), /JSON/);
    const bad = structuredClone(backup); currentEvents(bad)[0].end = -1;
    await importText(page, JSON.stringify(bad)); assert.deepEqual(await readState(page), backup);
    assert.match(await page.locator('#toast').innerText(), /不合法/);
    const duplicate = structuredClone(backup); currentEvents(duplicate).push(currentEvents(duplicate)[0]);
    await importText(page, JSON.stringify(duplicate)); assert.deepEqual(await readState(page), backup);
    const invalidCategory = structuredClone(backup); currentEvents(invalidCategory)[0].category = ['japanese'];
    await importText(page, JSON.stringify(invalidCategory)); assert.deepEqual(await readState(page), backup);
    await add(page, { title: '备份后修改' }); const changed = await readState(page);
    await importText(page, JSON.stringify(backup)); assert.deepEqual(await readState(page), backup);
    assert.equal(await page.evaluate(() => window.bad), undefined);
    await page.locator('#undo-btn').click(); assert.deepEqual(await readState(page), changed);
    await importText(page, JSON.stringify(backup)); await page.reload(); assert.deepEqual(await readState(page), backup);
  });

  await check('saving a different category keeps the edited event visible', async page => {
    await page.locator('[data-filter="japanese"]').click();
    await add(page, { title: '从日语筛选添加开发', category: 'game' });
    assert.equal(await page.locator('[data-filter="game"]').getAttribute('aria-pressed'), 'true');
    assert.equal(await card(page, '从日语筛选添加开发').count(), 1);
    await add(page, { title: '新增日常可见', category: 'routine' });
    assert.equal(await page.locator('#show-routines').isChecked(), true);
    assert.equal(await card(page, '新增日常可见').count(), 1);
  });

  await check('520-week capacity blocks new weeks without losing existing plans', async page => {
    const backup = await readState(page); backup.weeks = {};
    const date = new Date('2010-01-04T12:00:00Z');
    for (let index = 0; index < 520; index++) {
      const key = date.toISOString().slice(0, 10); backup.weeks[key] = { events: [] }; backup.activeWeek = key;
      date.setUTCDate(date.getUTCDate() + 7);
    }
    await importText(page, JSON.stringify(backup)); assert.deepEqual(await readState(page), backup);
    for (const selector of ['#next-week', '#copy-week']) {
      await page.locator(selector).click(); assert.deepEqual(await readState(page), backup);
      assert.match(await page.locator('#toast').innerText(), /520/);
    }
    const overLimit = structuredClone(backup); overLimit.weeks[date.toISOString().slice(0, 10)] = { events: [] };
    await importText(page, JSON.stringify(overLimit)); assert.deepEqual(await readState(page), backup);
    assert.match(await page.locator('#toast').innerText(), /520/);
    await page.locator('#prev-week').click(); assert.notEqual((await readState(page)).activeWeek, backup.activeWeek);
    assert.equal(Object.keys((await readState(page)).weeks).length, 520);
  });

  await check('failed local saving is visible; editing and export remain usable', async page => {
    assert.equal(await page.locator('#storage-notice').isVisible(), true);
    assert.match(await page.locator('#save-status').innerText(), /尚未保存/);
    await add(page, { title: '临时编辑仍可导出' });
    assert.equal(await card(page, '临时编辑仍可导出').count(), 1);
    assert.match(await page.locator('#toast').innerText(), /导出/);
    const exported = await exportState(page); assert.ok(currentEvents(exported).some(e => e.title === '临时编辑仍可导出'));
    assert.equal(await readState(page), null);
  }, {}, () => { Storage.prototype.setItem = () => { throw new DOMException('Simulated quota', 'QuotaExceededError'); }; });

  await check('small-screen dialog fields, save/cancel and focus are reachable', async page => {
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
    await page.locator('#add-event').click(); assert.equal(await page.locator('#event-title').evaluate(node => node === document.activeElement), true);
    const dimensions = await page.locator('#event-dialog').evaluate(node => { const rect = node.getBoundingClientRect(); return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: innerWidth, height: innerHeight }; });
    assert.ok(dimensions.left >= 0 && dimensions.right <= dimensions.width + 1 && dimensions.top >= 0 && dimensions.bottom <= dimensions.height + 1, JSON.stringify(dimensions));
    await fillEvent(page, { title: '手机编辑', notes: '在小屏幕上也能保存。' });
    await page.locator('#copy-details summary').click(); await page.locator('input[name="copyDay"][value="6"]').check(); await save(page);
    assert.equal(await card(page, '手机编辑').count(), 2);
    await page.locator('#add-event').click(); await page.keyboard.press('Escape');
    assert.equal(await page.locator('#event-dialog').isVisible(), false);
    await page.locator('#add-event').click(); await page.locator('#cancel-dialog').click();
    assert.equal(await page.locator('#event-dialog').isVisible(), false);
  }, { viewport: { width: 390, height: 660 }, isMobile: true, hasTouch: true });
} finally { await browser.close(); }

if (browserErrors.length) failures.push({ check: 'browser runtime errors', error: browserErrors });
console.log(JSON.stringify({ passed: passed.length, checks: passed, failures, browserErrors }, null, 2));
if (failures.length) process.exitCode = 1;
