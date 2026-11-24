import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from '@playwright/test';
import fastifyStatic from '@fastify/static';
import { buildApp } from '../src/server/app.ts';

// Compare standalone time geometry and interactions with the native calendar
// using identical artificial plans. No user data is read.
const dataDir = await mkdtemp(path.join(tmpdir(), 'nihongo-schedule-parity-'));
const app = buildApp({ dataDir, deployment: { mode: 'local', host: '127.0.0.1' } });
const source = await readFile('weekly-plan.html', 'utf8');
const key = 'weekly-rhythm-planner-v1';
const fixture = { version: 2, activeWeek: '2026-11-16', events: [
  { id: 'a', day: 0, start: 520, end: 540, category: 'japanese', title: '时间坐标 A', notes: '' },
  { id: 'b', day: 0, start: 600, end: 620, category: 'jp', title: '时间坐标 B', notes: '' },
], view: { filter: 'all', showRoutines: false, foldRoutines: false } };
let browser;
const errors = [];
async function context(viewport) {
  const result = await browser.newContext({ viewport });
  await result.addInitScript(({ key, fixture }) => {
    if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify(fixture));
  }, { key, fixture });
  return result;
}
async function pageFor(context, url) {
  const page = await context.newPage();
  page.setDefaultTimeout(7000);
  page.on('pageerror', error => errors.push(error.message));
  page.on('dialog', dialog => dialog.accept());
  await page.goto(url);
  return page;
}
const read = ui => ui.doc.evaluate(key => JSON.parse(localStorage.getItem(key)), key);
async function translatePoint(ui, point) { return point; }
async function reveal(ui, minute) {
  if (ui.native) {
    await ui.doc.locator('.day-list').first().evaluate((list, minute) => {
      const segment=JSON.parse(list.dataset.segments).find(part=>minute>=part.start&&minute<part.end);
      const y=segment.top+(minute-segment.start)*Number(list.dataset.minuteHeight);
      window.scrollTo(0,window.scrollY+list.getBoundingClientRect().top+y-180);
    }, minute);
  } else {
    await ui.doc.locator('#board-scroll').scrollIntoViewIfNeeded();
    await ui.doc.locator('#board-scroll').evaluate((element, minute) => {
      element.scrollTop = minute * 2 - 60;
      element.scrollLeft = 0;
    }, minute);
  }
  await ui.page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
}
async function point(ui, day, minute, offset = 1) {
  return translatePoint(ui, await ui.doc.locator(`.day[data-day="${day}"] .day-list`).evaluate((list, { minute, offset }) => {
    const segment = JSON.parse(list.dataset.segments).find(part => minute >= part.start && minute < part.end);
    if (!segment) throw new Error('Time is folded');
    const bounds = list.getBoundingClientRect();
    return { x: bounds.left + bounds.width / 2, y: bounds.top + segment.top + (minute - segment.start) * Number(list.dataset.minuteHeight) + offset };
  }, { minute, offset }));
}
async function metrics(ui) {
  return ui.doc.locator('#board').evaluate(board => {
    const day = board.querySelector('.day');
    const head = day.querySelector('.day-head');
    const add = head.querySelector('.day-add');
    const list = day.querySelector('.day-list');
    const event = list.querySelector('.event');
    const rect = node => node.getBoundingClientRect();
    return {
      headHeight: rect(head).height,
      axisHeight: rect(board.querySelector('.time-axis-head')).height,
      addInsideHeader: rect(add).bottom <= rect(head).bottom + 1,
      addFont: getComputedStyle(add).fontSize,
      dayFont: getComputedStyle(head.querySelector('.day-name')).fontSize,
      eventFont: getComputedStyle(event.querySelector('.event-title')).fontSize,
      eventHeight: rect(event).height,
      eventTop: rect(event).top - rect(list).top,
      minuteHeight: list.dataset.minuteHeight,
      timelineHeight: rect(list).height,
    };
  });
}
async function reset(ui) {
  await ui.doc.locator('#import-file').setInputFiles({ name: 'fixture.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(fixture)) });
  await ui.page.waitForFunction(() => !(document.querySelector('.schedule-native')?.shadowRoot?.querySelector('#import-file') ?? document.querySelector('#import-file'))?.value);
}
async function runInteractions(ui) {
  await reveal(ui, 495);
  let p = await point(ui, 1, 495);
  await ui.page.mouse.click(p.x, p.y);
  await ui.doc.locator('#event-dialog').waitFor();
  assert.equal(await ui.doc.locator('#event-start').inputValue(), '08:15');
  await ui.doc.locator('#cancel-dialog').click();

  await reveal(ui, 520);
  p = await point(ui, 0, 520, 10);
  await ui.page.mouse.move(p.x, p.y);
  await ui.page.mouse.down();
  await ui.page.waitForTimeout(550);
  p = await point(ui, 1, 550, 10);
  await ui.page.mouse.move(p.x, p.y, { steps: 6 });
  await ui.page.mouse.up();
  let item = (await read(ui)).events.find(item => item.id === 'a');
  assert.equal(item.day, 1);
  assert.equal(item.start, 550);
  assert.equal(item.end, 570);
  await ui.doc.locator('#undo-btn').click();
  assert.equal((await read(ui)).events.find(item => item.id === 'a').start, 520);

  // The marquee clips against the sticky header. This used to be calculated
  // using 112px while the integration rendered a 132px, wrapping header.
  await reveal(ui, 510);
  const start = await point(ui, 0, 510);
  const end = await point(ui, 1, 635);
  await ui.page.keyboard.down('Shift');
  await ui.page.mouse.move(start.x - 65, start.y);
  await ui.page.mouse.down();
  await ui.page.mouse.move(end.x, end.y, { steps: 8 });
  await ui.page.mouse.up();
  await ui.page.keyboard.up('Shift');
  assert.equal(await ui.doc.locator('.event.is-selected').count(), 2);
  await ui.doc.locator('#selection-clear').click();

  await ui.doc.locator('.event[data-event-id="a"]').click({ button: 'right' });
  await ui.doc.locator('#context-copy').click();
  p = await point(ui, 2, 555);
  await ui.page.mouse.click(p.x, p.y, { button: 'right' });
  await ui.doc.locator('#context-paste').click();
  item = (await read(ui)).events.find(item => item.id !== 'a' && item.id !== 'b');
  assert.equal(item.day, 2);
  assert.equal(item.start, 555);
  assert.equal(item.end, 575);
  await ui.doc.locator('#undo-btn').click();

  await ui.doc.locator('#fold-routines').check();
  if (ui.native) await reveal(ui,495);
  else { await ui.doc.locator('#board-scroll').evaluate(element => { element.scrollTop = 0; }); await ui.doc.locator('#board-scroll').scrollIntoViewIfNeeded(); }
  p = await point(ui, 1, 495);
  await ui.page.mouse.click(p.x, p.y);
  assert.equal(await ui.doc.locator('#event-start').inputValue(), '08:15');
  await ui.doc.locator('#cancel-dialog').click();
  await ui.doc.locator('#fold-routines').uncheck();

  // Native dragging scrolls the page at its visible bottom edge.
  await reveal(ui, 520);
  p = await point(ui, 0, 520, 10);
  const beforeScroll = await ui.doc.locator('#board-scroll').evaluate((node,native) => native ? window.scrollY : node.scrollTop, ui.native);
  await ui.page.mouse.move(p.x, p.y);
  await ui.page.mouse.down();
  await ui.page.waitForTimeout(550);
  const edge = await translatePoint(ui, await ui.doc.locator('#board-scroll').evaluate(node => {
    const rect = node.getBoundingClientRect();
    return { x: rect.left + 140, y: Math.min(rect.bottom, innerHeight - 8) - 5 };
  }));
  await ui.page.mouse.move(edge.x, edge.y, { steps: 6 });
  await ui.page.waitForTimeout(250);
  assert.ok(await ui.doc.locator('#board-scroll').evaluate((node,native) => native ? window.scrollY : node.scrollTop, ui.native) > beforeScroll);
  await ui.page.keyboard.press('Escape');
  await ui.page.mouse.up();
  await reset(ui);
}
try {
  app.get('/__planner-source', (_request, reply) => reply.type('text/html').send(source));
  await app.register(fastifyStatic, { root: path.resolve('dist') });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  browser = await chromium.launch({ headless: true, ...(process.platform === 'win32' ? { channel: 'msedge' } : {}) });
  await mkdir('test-results', { recursive: true });
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 2196, height: 1027 }, { width: 390, height: 844 }]) {
    const page = await pageFor(await context(viewport), origin + '/#schedule');
    await page.locator('.schedule-native .day').first().waitFor();
    const doc = page;
    const size = viewport;
    const original = await pageFor(await context(size), origin + '/__planner-source');
    await original.locator('.day').first().waitFor();
    const integratedUI = { page, doc, native: true };
    const originalUI = { page: original, doc: original, native: false };
    const actual = await metrics(integratedUI), baseline = await metrics(originalUI);
    for (const key of ['addFont', 'dayFont', 'eventFont']) assert.equal(parseFloat(actual[key]), parseFloat(baseline[key]) * 1.5);
    for (const key of ['eventHeight', 'eventTop', 'minuteHeight', 'timelineHeight']) assert.equal(actual[key], baseline[key]);
    assert.ok(actual.headHeight >= baseline.headHeight);
    assert.equal(actual.headHeight, actual.axisHeight);
    assert.equal(actual.addInsideHeader, true);
    assert.equal(await page.locator('iframe').count(),0);
    assert.equal(await doc.locator('#board-scroll').evaluate(node=>node.scrollHeight<=node.clientHeight+1),true);
    console.log(`PASS ${viewport.width}px: fonts are 150%, header fits, time scale and event coordinates match standalone`);
    if (viewport.width > 1000) {
      await runInteractions(originalUI);
      await runInteractions(integratedUI);
      console.log(`PASS ${viewport.width}px: original and integrated blank click, exact-time drag, marquee, copy/paste, folding and edge auto-scroll`);
    }
    // Capture the actual calendar rather than the summary area.
    await reveal(integratedUI,520);
    await page.screenshot({ path: `test-results/schedule-parity-${viewport.width}.png` });
    await original.close();
    await page.close();
  }
  assert.deepEqual(errors, []);
  console.log('PASS no browser errors');
} finally {
  await browser?.close();
  await app.close();
  await rm(dataDir, { recursive: true, force: true });
}
