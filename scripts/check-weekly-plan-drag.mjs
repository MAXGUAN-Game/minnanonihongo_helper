import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from '@playwright/test';

// Isolated browser contexts and fixture plans never touch the user's browser data.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const url = pathToFileURL(path.join(root, 'weekly-plan.html')).href;
const storageKey = 'weekly-rhythm-planner-v1';
const week = '2026-09-21';
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const passed = [], failures = [], browserErrors = [];
const event = (id, day, start, end, category = 'game') => ({ id, day, start, end, category, title: id, notes: 'Drag acceptance fixture' });
const stateFor = events => ({ version: 1, activeWeek: week, weeks: { [week]: { events } }, view: { filter: 'all', showRoutines: false } });
const readState = page => page.evaluate(key => JSON.parse(localStorage.getItem(key)), storageKey);
const readEvent = async (page, id) => (await readState(page)).weeks[week].events.find(item => item.id === id);
const card = (page, id) => page.locator(`.event[data-event-id="${id}"]`);

async function check(name, events, run, options = {}) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, ...options });
  try {
    await context.addInitScript(({ key, state }) => {
      if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify(state));
    }, { key: storageKey, state: stateFor(events) });
    const page = await context.newPage();
    page.setDefaultTimeout(5000);
    page.on('pageerror', error => browserErrors.push({ check: name, error: error.message }));
    await page.goto(url);
    await page.locator('.day-list[data-minute-height]').first().waitFor();
    await run(page, context);
    passed.push(name); console.log('PASS ' + name);
  } catch (error) {
    failures.push({ check: name, error: error.stack }); console.error('FAIL ' + name + ': ' + error.message);
  } finally { await context.close(); }
}

async function reveal(page, minute, day = 0) {
  await page.locator('.board-scroll').scrollIntoViewIfNeeded();
  await page.evaluate(({ minute, day }) => {
    const scroll = document.querySelector('.board-scroll');
    const column = document.querySelector(`.day[data-day="${day}"]`);
    const list = column.querySelector('.day-list');
    const scale = Number(list.dataset.minuteHeight);
    scroll.scrollTop = Math.max(0, minute * scale - 120);
    const scrollRect = scroll.getBoundingClientRect(), columnRect = column.getBoundingClientRect();
    scroll.scrollLeft += columnRect.left + columnRect.width / 2 - scrollRect.left - scroll.clientWidth / 2;
  }, { minute, day });
  await page.waitForTimeout(40);
}

async function handle(page, id) {
  const rect = await card(page, id).boundingBox();
  assert.ok(rect, 'Source event must have a bounding box');
  return { x: rect.x + rect.width / 2, y: rect.y + Math.min(12, rect.height / 2) };
}

async function targetPoint(page, day, minute, offset = 12) {
  return page.locator(`.day[data-day="${day}"] .day-list`).evaluate((list, { minute, offset }) => {
    const rect = list.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + minute * Number(list.dataset.minuteHeight) + offset };
  }, { minute, offset });
}

async function startMouseDrag(page, id) {
  const before = await readEvent(page, id);
  await reveal(page, before.start, before.day);
  const source = await handle(page, id);
  await page.mouse.move(source.x, source.y);
  await page.mouse.down();
  await page.waitForTimeout(550);
  assert.equal(await card(page, id).evaluate(node => node.classList.contains('is-dragging')), true, 'Long press must enter drag mode');
  return { before, source };
}

async function mouseDrag(page, id, day, minute, { revealTarget = false } = {}) {
  const current = await startMouseDrag(page, id);
  if (revealTarget) await reveal(page, minute, day);
  const point = await targetPoint(page, day, minute);
  await page.mouse.move(point.x, point.y, { steps: 5 });
  assert.equal(await page.locator('.drag-preview').count(), 1);
  assert.equal(await page.locator('#drag-label').isVisible(), true);
  await page.mouse.up();
  await page.waitForTimeout(80);
  assert.equal(await page.locator('.is-dragging, .drag-preview').count(), 0);
  assert.equal(await page.locator('#event-dialog').isVisible(), false, 'Dropping must not open the editor');
  return current.before;
}

async function assertSideBySide(page, ids, columns) {
  const rectangles = [];
  for (const id of ids) {
    assert.equal(Number(await card(page, id).getAttribute('data-columns')), columns);
    rectangles.push(await card(page, id).boundingBox());
  }
  for (let index = 0; index < rectangles.length; index++) {
    for (let other = index + 1; other < rectangles.length; other++) {
      const a = rectangles[index], b = rectangles[other];
      assert.ok(a.x + a.width <= b.x + 1 || b.x + b.width <= a.x + 1, `Overlapping events cover each other: ${JSON.stringify({ a, b })}`);
    }
  }
}

try {
  await check('mouse long press moves within day and snaps to five minutes', [event('source', 0, 540, 570)], async page => {
    await mouseDrag(page, 'source', 0, 602);
    const moved = await readEvent(page, 'source');
    assert.equal(moved.start, 600); assert.equal(moved.end, 630); assert.equal(moved.day, 0);
    await page.reload();
    assert.deepEqual(await readEvent(page, 'source'), moved);
  });

  await check('cross-day drag preserves duration, metadata and undo', [event('source', 0, 540, 585, 'japanese')], async page => {
    const original = await mouseDrag(page, 'source', 1, 570);
    const moved = await readEvent(page, 'source');
    assert.deepEqual(moved, { ...original, day: 1, start: 570, end: 615 });
    await page.locator('#undo-btn').click();
    assert.deepEqual(await readEvent(page, 'source'), original);
    await page.reload(); assert.deepEqual(await readEvent(page, 'source'), original);
  });

  await check('dropping onto an existing task produces two visible columns', [event('source', 0, 540, 570), event('destination', 1, 570, 615, 'fitness')], async page => {
    await mouseDrag(page, 'source', 1, 585);
    await assertSideBySide(page, ['source', 'destination'], 2);
    assert.equal((await readEvent(page, 'destination')).start, 570);
    await page.reload(); await assertSideBySide(page, ['source', 'destination'], 2);
  });

  await check('consecutive tasks use full width and three simultaneous tasks get three columns', [
    event('first', 0, 540, 570), event('next', 0, 570, 600),
    event('triple-a', 1, 540, 600), event('triple-b', 1, 550, 590), event('triple-c', 1, 560, 580),
  ], async page => {
    assert.equal(await card(page, 'first').getAttribute('data-columns'), '1');
    assert.equal(await card(page, 'next').getAttribute('data-columns'), '1');
    await assertSideBySide(page, ['triple-a', 'triple-b', 'triple-c'], 3);
  });

  await check('moving before long press cancels drag and does not edit', [event('source', 0, 540, 570)], async page => {
    const before = await readState(page); await reveal(page, 540);
    const point = await handle(page, 'source');
    await page.mouse.move(point.x, point.y); await page.mouse.down();
    await page.waitForTimeout(70); await page.mouse.move(point.x + 35, point.y + 30);
    await page.waitForTimeout(600); await page.mouse.up();
    assert.deepEqual(await readState(page), before);
    assert.equal(await page.locator('.is-dragging, .drag-preview').count(), 0);
    assert.equal(await page.locator('#event-dialog').isVisible(), false);
  });

  await check('holding still at the scroll edge keeps the task fixed; moving enables auto-scroll', [event('source', 0, 540, 570)], async page => {
    const before = await readState(page);
    await reveal(page, 540);
    await page.evaluate(() => {
      const scroll = document.querySelector('.board-scroll');
      const source = document.querySelector('.event[data-event-id="source"]');
      const bottom = Math.min(scroll.getBoundingClientRect().bottom, innerHeight - 8);
      scroll.scrollTop += source.getBoundingClientRect().top + 12 - (bottom - 14);
    });
    await page.waitForTimeout(40);
    const point = await handle(page, 'source');
    const initialScroll = await page.locator('.board-scroll').evaluate(node => node.scrollTop);
    await page.mouse.move(point.x, point.y); await page.mouse.down();
    await page.waitForTimeout(850);
    assert.equal(await card(page, 'source').evaluate(node => node.classList.contains('is-dragging')), true);
    assert.equal(await page.locator('.board-scroll').evaluate(node => node.scrollTop), initialScroll, 'Holding still must not start edge scrolling');
    await page.mouse.up();
    assert.deepEqual(await readState(page), before);
    assert.equal(await page.locator('#event-dialog').isVisible(), false);

    await page.mouse.down(); await page.waitForTimeout(550);
    await page.mouse.move(point.x + 8, point.y);
    await page.waitForTimeout(250);
    const scrolled = await page.locator('.board-scroll').evaluate(node => node.scrollTop);
    assert.ok(scrolled > initialScroll + 20, `Moving near the edge should scroll: ${initialScroll} -> ${scrolled}`);
    await page.keyboard.press('Escape'); await page.mouse.up();
    assert.deepEqual(await readState(page), before);
    assert.equal(await page.locator('.is-dragging, .drag-preview').count(), 0);
  });

  for (const cancellation of ['Escape', 'pointercancel', 'outside']) {
    await check(`${cancellation} cancels an active drag without changes`, [event('source', 0, 540, 570)], async page => {
      const before = await readState(page);
      await startMouseDrag(page, 'source');
      const point = await targetPoint(page, 1, 575);
      await page.mouse.move(point.x, point.y, { steps: 3 });
      if (cancellation === 'Escape') await page.keyboard.press('Escape');
      if (cancellation === 'pointercancel') {
        await card(page, 'source').dispatchEvent('pointercancel', { pointerId: 1, pointerType: 'mouse', bubbles: true });
      }
      if (cancellation === 'outside') await page.mouse.move(-15, -15);
      await page.mouse.up(); await page.waitForTimeout(80);
      assert.deepEqual(await readState(page), before);
      assert.equal(await page.locator('.is-dragging, .drag-preview').count(), 0);
      assert.equal(await page.locator('#event-dialog').isVisible(), false);
    });
  }

  await check('drag at midnight clamps the start and preserves duration', [event('source', 0, 1380, 1425)], async page => {
    await mouseDrag(page, 'source', 0, 1430);
    const moved = await readEvent(page, 'source');
    assert.equal(moved.start, 1395); assert.equal(moved.end, 1440);
    assert.equal(moved.end - moved.start, 45);
  });

  await check('a short click still opens the task editor', [event('source', 0, 540, 570)], async page => {
    await card(page, 'source').click();
    assert.equal(await page.locator('#event-dialog').isVisible(), true);
    assert.equal(await page.locator('#event-title').inputValue(), 'source');
  });

  await check('touch long press moves task and suppresses the following click', [event('source', 0, 540, 570)], async (page, context) => {
    await reveal(page, 540);
    const source = await handle(page, 'source');
    const destination = await targetPoint(page, 0, 600);
    const cdp = await context.newCDPSession(page);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...source, id: 1 }] });
    await page.waitForTimeout(550);
    assert.equal(await card(page, 'source').evaluate(node => node.classList.contains('is-dragging')), true);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ ...destination, id: 1 }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await page.waitForTimeout(150);
    const moved = await readEvent(page, 'source');
    assert.equal(moved.start, 600); assert.equal(moved.end, 630);
    assert.equal(await page.locator('#event-dialog').isVisible(), false);
    assert.equal(await page.locator('.is-dragging, .drag-preview').count(), 0);
  }, { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

  await check('touch swipe beginning on a card scrolls without changing tasks', [event('source', 0, 540, 630)], async (page, context) => {
    await reveal(page, 540);
    const before = await readState(page), source = await handle(page, 'source');
    const topBefore = await page.locator('.board-scroll').evaluate(node => node.scrollTop);
    const cdp = await context.newCDPSession(page);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...source, id: 1 }] });
    for (let step = 1; step <= 5; step++) {
      await page.waitForTimeout(30);
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: source.x, y: source.y - step * 18, id: 1 }] });
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await page.waitForTimeout(500);
    const topAfter = await page.locator('.board-scroll').evaluate(node => node.scrollTop);
    assert.ok(topAfter > topBefore + 30, `Card swipe failed to scroll: ${topBefore} -> ${topAfter}`);
    assert.deepEqual(await readState(page), before);
    assert.equal(await page.locator('.is-dragging, .drag-preview').count(), 0);
    assert.equal(await page.locator('#event-dialog').isVisible(), false);
  }, { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
} finally { await browser.close(); }

if (browserErrors.length) failures.push({ check: 'browser runtime errors', error: browserErrors });
console.log(JSON.stringify({ passed: passed.length, checks: passed, failures, browserErrors }, null, 2));
if (failures.length) process.exitCode = 1;
