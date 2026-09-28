import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from '@playwright/test';

// Every check uses a fresh profile and fixtures, never the user's saved plan.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const url = pathToFileURL(path.join(root, 'weekly-plan.html')).href;
const storageKey = 'weekly-rhythm-planner-v1';
const week = '2026-09-21', nextWeek = '2026-09-28';
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const passed = [], failures = [], browserErrors = [];
const event = (id, day, start, end, category = 'game') => ({ id, day, start, end, category, title: id, notes: 'Copied notes: 原始任务 <safe>' });
const fixture = (items, view = {}) => ({ version: 1, activeWeek: week, weeks: { [week]: { events: items }, [nextWeek]: { events: [] } }, view: { filter: 'all', showRoutines: false, ...view } });
const readState = page => page.evaluate(key => JSON.parse(localStorage.getItem(key)), storageKey);
const readEvents = async (page, key = week) => (await readState(page)).weeks[key].events;
const card = (page, id) => page.locator(`.event[data-event-id="${id}"]`);
const menu = page => page.locator('#context-menu');

async function check(name, items, run, view = {}) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  try {
    await context.addInitScript(({ key, state }) => {
      if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify(state));
    }, { key: storageKey, state: fixture(items, view) });
    const page = await context.newPage();
    page.setDefaultTimeout(5000);
    page.on('pageerror', error => browserErrors.push({ check: name, error: error.message }));
    await page.goto(url);
    await page.locator('.day-list[data-minute-height]').first().waitFor();
    await run(page);
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
    scroll.scrollTop = Math.max(0, minute * Number(column.querySelector('.day-list').dataset.minuteHeight) - 120);
    const bounds = scroll.getBoundingClientRect(), columnBounds = column.getBoundingClientRect();
    scroll.scrollLeft += columnBounds.left + columnBounds.width / 2 - bounds.left - scroll.clientWidth / 2;
  }, { minute, day });
  await page.waitForTimeout(40);
}

async function targetPoint(page, day, minute, offset = 0) {
  return page.locator(`.day[data-day="${day}"] .day-list`).evaluate((list, { minute, offset }) => {
    const bounds = list.getBoundingClientRect();
    return { x: bounds.left + bounds.width / 2, y: bounds.top + minute * Number(list.dataset.minuteHeight) + offset };
  }, { minute, offset });
}

async function rightClickTime(page, day, minute) {
  await reveal(page, minute, day);
  const point = await targetPoint(page, day, minute);
  await page.mouse.click(point.x, point.y, { button: 'right' });
  await menu(page).waitFor({ state: 'visible' });
  assert.equal(await menu(page).getAttribute('role'), 'menu');
  assert.equal(await page.locator('#event-dialog').isVisible(), false);
}

async function copyCard(page, id, key = week) {
  const source = (await readEvents(page, key)).find(item => item.id === id);
  assert.ok(source);
  await reveal(page, source.start, source.day);
  await card(page, id).click({ button: 'right', position: { x: 20, y: 12 } });
  await menu(page).waitFor({ state: 'visible' });
  assert.equal(await page.locator('#context-copy').isVisible(), true);
  assert.equal(await page.locator('#context-copy').isEnabled(), true);
  assert.equal(await page.locator('#event-dialog').isVisible(), false);
  await page.locator('#context-copy').click();
  await menu(page).waitFor({ state: 'hidden' });
  return source;
}

async function pasteAt(page, day, minute, key = week) {
  const beforeIds = new Set((await readEvents(page, key)).map(item => item.id));
  await rightClickTime(page, day, minute);
  assert.equal(await page.locator('#context-paste').isEnabled(), true);
  await page.locator('#context-paste').click();
  await menu(page).waitFor({ state: 'hidden' });
  assert.equal(await page.locator('#event-dialog').isVisible(), false);
  const added = (await readEvents(page, key)).filter(item => !beforeIds.has(item.id));
  assert.equal(added.length, 1);
  return added[0];
}

async function assertColumns(page, ids, count) {
  const rectangles = [];
  for (const id of ids) {
    assert.equal(Number(await card(page, id).getAttribute('data-columns')), count);
    rectangles.push(await card(page, id).boundingBox());
  }
  for (let a = 0; a < rectangles.length; a++) for (let b = a + 1; b < rectangles.length; b++) {
    const one = rectangles[a], two = rectangles[b];
    assert.ok(one.x + one.width <= two.x + 1 || two.x + two.width <= one.x + 1, 'Concurrent cards must not cover one another');
  }
}

async function mouseDrag(page, id, day, minute) {
  const source = (await readEvents(page)).find(item => item.id === id);
  await reveal(page, source.start, source.day);
  const bounds = await card(page, id).boundingBox();
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + 12);
  await page.mouse.down(); await page.waitForTimeout(550);
  assert.equal(await card(page, id).evaluate(node => node.classList.contains('is-dragging')), true);
  const target = await targetPoint(page, day, minute, 12);
  await page.mouse.move(target.x, target.y, { steps: 5 });
  assert.equal(await page.locator('.drag-preview').count(), 1);
  await page.mouse.up(); await page.waitForTimeout(80);
  assert.equal(await page.locator('.drag-preview, .is-dragging').count(), 0);
  assert.equal(await page.locator('#event-dialog').isVisible(), false);
  return source;
}

try {
  await check('empty clipboard disables paste on the actual clicked calendar time', [], async page => {
    const before = await readState(page);
    await rightClickTime(page, 1, 602);
    assert.equal(await page.locator('#context-copy').isVisible(), false);
    assert.equal(await page.locator('#context-paste').isDisabled(), true);
    assert.match(await page.locator('#context-time').innerText(), /周二.*10:00/);
    assert.ok((await page.locator('#context-hint').innerText()).trim().length > 0);
    assert.deepEqual(await readState(page), before);
  });

  await check('copy alone leaves data and undo unchanged; later source edits do not mutate its snapshot', [event('source', 0, 540, 585, 'japanese')], async page => {
    const before = await readState(page), source = await copyCard(page, 'source');
    assert.deepEqual(await readState(page), before);
    assert.equal(await page.locator('#undo-btn').isDisabled(), true);
    await card(page, 'source').click();
    await page.locator('#event-title').fill('Changed after copy');
    await page.locator('#event-category').selectOption('fitness');
    await page.locator('#event-notes').fill('Different notes');
    await page.locator('#event-end').fill('10:15');
    await page.locator('#event-form button[type="submit"]').click();
    const pasted = await pasteAt(page, 2, 723);
    assert.notEqual(pasted.id, source.id);
    assert.deepEqual(pasted, { ...source, id: pasted.id, day: 2, start: 725, end: 770 });
    assert.equal((await readEvents(page)).find(item => item.id === source.id).title, 'Changed after copy');
  });

  await check('repeat and cross-week paste get independent IDs and retain clipboard through undo', [event('source', 0, 540, 585)], async page => {
    const source = await copyCard(page, 'source');
    const first = await pasteAt(page, 1, 602), second = await pasteAt(page, 3, 723);
    assert.deepEqual(first, { ...source, id: first.id, day: 1, start: 600, end: 645 });
    assert.deepEqual(second, { ...source, id: second.id, day: 3, start: 725, end: 770 });
    assert.equal(new Set([source.id, first.id, second.id]).size, 3);
    await page.locator('#next-week').click();
    const third = await pasteAt(page, 2, 632, nextWeek);
    assert.deepEqual(third, { ...source, id: third.id, day: 2, start: 630, end: 675 });
    assert.equal(new Set([source.id, first.id, second.id, third.id]).size, 4);
    await page.locator('#undo-btn').click();
    assert.deepEqual(await readEvents(page, nextWeek), []);
    assert.equal((await readEvents(page)).length, 3);
    const fourth = await pasteAt(page, 4, 780, nextWeek);
    assert.notEqual(fourth.id, third.id);
    const saved = await readState(page);
    await page.reload();
    assert.deepEqual(await readState(page), saved);
    assert.equal(await card(page, fourth.id).count(), 1);
    await rightClickTime(page, 5, 780);
    assert.equal(await page.locator('#context-paste').isDisabled(), true, 'A reload clears the in-memory clipboard');
  });

  await check('pasting onto a card uses the pointer time and creates concurrent columns', [event('source', 0, 540, 570), event('destination', 1, 570, 630, 'fitness')], async page => {
    const source = await copyCard(page, 'source');
    await rightClickTime(page, 1, 587);
    assert.equal(await page.locator('#context-copy').isVisible(), true);
    assert.match(await page.locator('#context-time').innerText(), /周二.*09:45/);
    await page.locator('#context-paste').click();
    const pasted = (await readEvents(page)).find(item => !['source', 'destination'].includes(item.id));
    assert.deepEqual(pasted, { ...source, id: pasted.id, day: 1, start: 585, end: 615 });
    await assertColumns(page, [pasted.id, 'destination'], 2);
    await page.reload();
    await assertColumns(page, [pasted.id, 'destination'], 2);
  });

  await check('midnight overflow is disabled without shifting the target; an exact midnight finish succeeds', [event('source', 0, 540, 585)], async page => {
    await copyCard(page, 'source');
    const before = await readState(page);
    await rightClickTime(page, 6, 1437);
    assert.match(await page.locator('#context-time').innerText(), /23:55/);
    assert.equal(await page.locator('#context-paste').isDisabled(), true);
    assert.ok((await page.locator('#context-hint').innerText()).trim().length > 0);
    assert.deepEqual(await readState(page), before);
    await page.keyboard.press('Escape');
    const pasted = await pasteAt(page, 6, 1395);
    assert.equal(pasted.start, 1395); assert.equal(pasted.end, 1440);
  });

  for (const dismissal of ['Escape', 'outside pointer', 'calendar scroll', 'week navigation']) {
    await check(`${dismissal} closes the context menu`, [event('source', 0, 540, 570)], async page => {
      await copyCard(page, 'source');
      await rightClickTime(page, 1, 600);
      if (dismissal === 'Escape') await page.keyboard.press('Escape');
      if (dismissal === 'outside pointer') await page.mouse.click(10, 10);
      if (dismissal === 'calendar scroll') await page.locator('.board-scroll').evaluate(node => { node.scrollTop += 80; });
      if (dismissal === 'week navigation') await page.locator('#next-week').click();
      await menu(page).waitFor({ state: 'hidden' });
      assert.equal((await readEvents(page)).length, 1);
      assert.deepEqual(await readEvents(page, nextWeek), []);
    });
  }

  await check('right-clicking the custom menu suppresses the native menu and keeps data unchanged', [], async page => {
    await rightClickTime(page, 1, 600);
    const before = await readState(page);
    await page.evaluate(() => {
      window.contextPrevented = null;
      document.querySelector('#context-menu').addEventListener('contextmenu', e => { window.contextPrevented = e.defaultPrevented; }, { once: true });
    });
    await page.locator('#context-time').click({ button: 'right' });
    assert.equal(await page.evaluate(() => window.contextPrevented), true);
    assert.equal(await menu(page).isVisible(), true);
    assert.deepEqual(await readState(page), before);
  });

  for (const showRoutines of [false, true]) {
    await check(`real drag overlapping a routine preserves the ${showRoutines ? 'ON' : 'OFF'} switch after reload`, [event('source', 0, 540, 570), event('routine', 1, 570, 630, 'routine')], async page => {
      await mouseDrag(page, 'source', 1, 585);
      const saved = await readState(page);
      const moved = saved.weeks[week].events.find(item => item.id === 'source');
      assert.equal(moved.day, 1); assert.equal(moved.start, 585); assert.equal(moved.end, 615);
      assert.equal(saved.view.showRoutines, showRoutines);
      assert.equal(await page.locator('#show-routines').isChecked(), showRoutines);
      assert.equal(await card(page, 'routine').count(), showRoutines ? 1 : 0);
      await assertColumns(page, showRoutines ? ['source', 'routine'] : ['source'], showRoutines ? 2 : 1);
      await page.reload();
      assert.deepEqual(await readState(page), saved);
      assert.equal(await page.locator('#show-routines').isChecked(), showRoutines);
      assert.equal(await card(page, 'routine').count(), showRoutines ? 1 : 0);
      await assertColumns(page, showRoutines ? ['source', 'routine'] : ['source'], showRoutines ? 2 : 1);
    }, { showRoutines });
  }
} finally { await browser.close(); }

if (browserErrors.length) failures.push({ check: 'browser runtime errors', error: browserErrors });
console.log(JSON.stringify({ passed: passed.length, checks: passed, failures, browserErrors }, null, 2));
if (failures.length) process.exitCode = 1;
