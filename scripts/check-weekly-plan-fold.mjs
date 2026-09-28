import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from '@playwright/test';

// Fresh contexts and fixture plans keep every check away from the user's saved plan.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const url = pathToFileURL(path.join(root, 'weekly-plan.html')).href;
const storageKey = 'weekly-rhythm-planner-v1', week = '2026-09-21';
const foldedSegments = [{ start: 470, end: 600, top: 0, index: 0 }, { start: 720, end: 840, top: 284, index: 1 }, { start: 1080, end: 1410, top: 548, index: 2 }];
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const passed = [], failures = [], browserErrors = [];
const event = (id, day, start, end, category = 'game') => ({ id, day, start, end, category, title: id, notes: 'Fold acceptance fixture' });
const fixture = (events, view = {}) => ({ version: 1, activeWeek: week, weeks: { [week]: { events } }, view: { filter: 'all', showRoutines: false, ...view } });
const readState = page => page.evaluate(key => JSON.parse(localStorage.getItem(key)), storageKey);
const readEvents = async page => (await readState(page)).weeks[week].events;
const readEvent = async (page, id) => (await readEvents(page)).find(item => item.id === id);
const cards = (page, id) => page.locator(`.event[data-event-id="${id}"]`);
const card = (page, id, segment) => segment === undefined ? cards(page, id).first() : page.locator(`.event[data-event-id="${id}"][data-segment-index="${segment}"]`);
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

async function timelineY(page, minute, day = 0) {
  return page.locator(`.day[data-day="${day}"] .day-list`).evaluate((list, minute) => {
    const segment = JSON.parse(list.dataset.segments).find(item => minute >= item.start && minute < item.end);
    if (!segment) throw new Error(`Minute ${minute} is not on the visible axis`);
    return segment.top + (minute - segment.start) * Number(list.dataset.minuteHeight);
  }, minute);
}

async function revealY(page, y, day = 0) {
  await page.locator('.board-scroll').scrollIntoViewIfNeeded();
  await page.evaluate(({ y, day }) => {
    const scroll = document.querySelector('.board-scroll'), column = document.querySelector(`.day[data-day="${day}"]`);
    scroll.scrollTop = Math.max(0, y - 120);
    const bounds = scroll.getBoundingClientRect(), columnBounds = column.getBoundingClientRect();
    scroll.scrollLeft += columnBounds.left + columnBounds.width / 2 - bounds.left - scroll.clientWidth / 2;
  }, { y, day });
  await page.waitForTimeout(40);
}

async function pointAtY(page, day, y) {
  return page.locator(`.day[data-day="${day}"] .day-list`).evaluate((list, y) => {
    const bounds = list.getBoundingClientRect();
    return { x: bounds.left + bounds.width / 2, y: bounds.top + y };
  }, y);
}

async function reveal(page, minute, day = 0) { await revealY(page, await timelineY(page, minute, day), day); }

async function startDrag(page, id, segment, gripPixels = 12) {
  const before = await readEvent(page, id), source = card(page, id, segment);
  const fragmentStart = Number(await source.getAttribute('data-start'));
  await reveal(page, fragmentStart, before.day);
  const bounds = await source.boundingBox();
  assert.ok(bounds);
  const offset = Math.min(gripPixels, bounds.height / 2);
  const point = { x: bounds.x + bounds.width / 2, y: bounds.y + offset };
  await page.mouse.move(point.x, point.y); await page.mouse.down();
  await page.waitForTimeout(550);
  assert.equal(await source.evaluate(node => node.classList.contains('is-dragging')), true);
  return { before, grabMinutes: fragmentStart - before.start + offset / 2 };
}

async function finishAtY(page, day, y) {
  await revealY(page, y, day);
  const point = await pointAtY(page, day, y);
  await page.mouse.move(point.x, point.y, { steps: 5 });
  await page.mouse.up(); await page.waitForTimeout(80);
  assert.equal(await page.locator('.is-dragging, .drag-preview').count(), 0);
  assert.equal(await page.locator('#event-dialog').isVisible(), false);
}

async function dragTo(page, id, day, start, segment) {
  const source = await startDrag(page, id, segment);
  await finishAtY(page, day, await timelineY(page, start + source.grabMinutes, day));
  const moved = await readEvent(page, id);
  assert.deepEqual(moved, { ...source.before, day, start, end: start + source.before.end - source.before.start });
  return source.before;
}

async function rightClickAtY(page, day, y) {
  await revealY(page, y, day);
  const point = await pointAtY(page, day, y);
  await page.mouse.click(point.x, point.y, { button: 'right' });
}

async function copyCard(page, id, segment) {
  const source = card(page, id, segment), original = await readEvent(page, id);
  await reveal(page, Number(await source.getAttribute('data-start')), original.day);
  await source.click({ button: 'right', position: { x: 20, y: 12 } });
  await menu(page).waitFor({ state: 'visible' });
  assert.equal(await page.locator('#context-copy').isEnabled(), true);
  await page.locator('#context-copy').click();
  await menu(page).waitFor({ state: 'hidden' });
  return original;
}

async function pasteAt(page, day, minute) {
  const ids = new Set((await readEvents(page)).map(item => item.id));
  // MouseEvent rounds clientY to integer pixels. Stay inside the requested minute at segment boundaries.
  await rightClickAtY(page, day, await timelineY(page, minute, day) + 1);
  await menu(page).waitFor({ state: 'visible' });
  assert.equal(await page.locator('#context-paste').isEnabled(), true);
  await page.locator('#context-paste').click();
  await menu(page).waitFor({ state: 'hidden' });
  const added = (await readEvents(page)).filter(item => !ids.has(item.id));
  assert.equal(added.length, 1);
  return added[0];
}

async function importState(page, value) {
  page.once('dialog', dialog => dialog.accept());
  await page.locator('#import-file').setInputFiles({ name: 'fixture-plan.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(value)) });
  await page.waitForFunction(({ key, expected }) => JSON.parse(localStorage.getItem(key)).view.foldRoutines === expected,
    { key: storageKey, expected: value.view.foldRoutines === true });
}

try {
  await check('fold switch removes the exact work/sleep intervals without changing tasks or statistics', [
    event('sleep', 0, 0, 470), event('wake-boundary', 0, 460, 480), event('morning-end', 0, 590, 610),
    event('morning-work', 0, 600, 720), event('noon-start', 0, 720, 740), event('noon-end', 0, 830, 850),
    event('afternoon-work', 0, 840, 1080), event('evening-start', 0, 1080, 1100),
    event('bed-boundary', 0, 1400, 1420), event('night', 0, 1410, 1440),
  ], async page => {
    const before = await readEvents(page), stats = await page.locator('#stats').innerText();
    assert.equal(await page.locator('#fold-routines').isChecked(), false, 'Old saved plans default to the full timeline');
    assert.equal(await page.locator('.day-list').first().evaluate(node => node.getBoundingClientRect().height), 2880);
    await page.locator('#fold-routines').check();
    assert.equal(await page.locator('.board-scroll').evaluate(node => node.scrollTop), 0);
    for (let day = 0; day < 7; day++) {
      const list = page.locator(`.day[data-day="${day}"] .day-list`);
      assert.deepEqual(JSON.parse(await list.getAttribute('data-segments')), foldedSegments);
      assert.equal(Number(await list.getAttribute('data-minute-height')), 2);
      assert.equal(await list.evaluate(node => node.getBoundingClientRect().height), 1208);
    }
    for (const id of ['sleep', 'morning-work', 'afternoon-work', 'night']) assert.equal(await cards(page, id).count(), 0);
    for (const [id, segment, start, end] of [
      ['wake-boundary', 0, 470, 480], ['morning-end', 0, 590, 600], ['noon-start', 1, 720, 740],
      ['noon-end', 1, 830, 840], ['evening-start', 2, 1080, 1100], ['bed-boundary', 2, 1400, 1410],
    ]) {
      assert.equal(await cards(page, id).count(), 1);
      assert.equal(Number(await card(page, id, segment).getAttribute('data-start')), start);
      assert.equal(Number(await card(page, id, segment).getAttribute('data-end')), end);
    }
    assert.deepEqual(await readEvents(page), before);
    assert.equal(await page.locator('#stats').innerText(), stats);
    await page.locator('#fold-routines').uncheck();
    assert.equal(await page.locator('.board-scroll').evaluate(node => node.scrollTop), 960, 'The full timeline resumes at its usual 08:00 starting view');
    assert.deepEqual(JSON.parse(await page.locator('.day-list').first().getAttribute('data-segments')), [{ start: 0, end: 1440, top: 0, index: 0 }]);
    for (const original of before) {
      assert.equal(await cards(page, original.id).count(), 1);
      assert.equal(Number(await card(page, original.id).getAttribute('data-start')), original.start);
      assert.equal(Number(await card(page, original.id).getAttribute('data-end')), original.end);
    }
    assert.deepEqual(await readEvents(page), before);
    assert.equal(await page.locator('#stats').innerText(), stats);
  });

  await check('cross-interval tasks render all fragments and hidden-only overlaps do not consume columns', [
    event('long', 0, 590, 1090), event('hidden', 0, 600, 720), event('noon-overlap', 0, 750, 780, 'japanese'),
  ], async page => {
    assert.equal(await cards(page, 'long').count(), 3);
    for (const [index, start, end, columns] of [[0, 590, 600, 1], [1, 720, 840, 2], [2, 1080, 1090, 1]]) {
      const fragment = card(page, 'long', index);
      assert.equal(Number(await fragment.getAttribute('data-start')), start);
      assert.equal(Number(await fragment.getAttribute('data-end')), end);
      assert.equal(Number(await fragment.getAttribute('data-columns')), columns);
    }
    assert.equal(await cards(page, 'hidden').count(), 0);
    const left = await card(page, 'long', 1).boundingBox(), right = await card(page, 'noon-overlap', 1).boundingBox();
    assert.ok(left.x + left.width <= right.x + 1 || right.x + right.width <= left.x + 1);
    await card(page, 'long', 1).click();
    assert.equal(await page.locator('#event-start').inputValue(), '09:50');
    assert.equal(await page.locator('#event-end').inputValue(), '18:10');
  }, { foldRoutines: true });

  await check('fold setting survives reload and backup export/import while older backups stay compatible', [event('source', 0, 480, 510)], async page => {
    await page.locator('#fold-routines').check();
    await page.reload();
    assert.equal(await page.locator('#fold-routines').isChecked(), true);
    assert.deepEqual(JSON.parse(await page.locator('.day-list').first().getAttribute('data-segments')), foldedSegments);
    const downloadPromise = page.waitForEvent('download');
    await page.locator('#export-btn').click();
    const download = await downloadPromise, exported = JSON.parse(await readFile(await download.path(), 'utf8'));
    assert.equal(exported.view.foldRoutines, true);
    assert.deepEqual(exported.weeks[week].events, await readEvents(page));
    await page.locator('#fold-routines').uncheck();
    await importState(page, exported);
    assert.equal(await page.locator('#fold-routines').isChecked(), true);
    const oldBackup = fixture([event('legacy', 2, 600, 720)], { filter: 'japanese', showRoutines: true });
    await importState(page, oldBackup);
    assert.equal(await page.locator('#fold-routines').isChecked(), false);
    assert.equal(await page.locator('#show-routines').isChecked(), true);
    assert.equal((await readState(page)).view.filter, 'japanese');
    assert.deepEqual(await readEvents(page), oldBackup.weeks[week].events);
  });

  await check('real mouse drags map morning, noon, evening and back to real minutes', [event('source', 0, 480, 510)], async page => {
    await dragTo(page, 'source', 1, 735);
    await dragTo(page, 'source', 2, 1095);
    await dragTo(page, 'source', 0, 485);
    const saved = await readState(page);
    await page.reload(); assert.deepEqual(await readState(page), saved);
    assert.equal(await page.locator('#undo-btn').isDisabled(), true);
  }, { foldRoutines: true });

  await check('dragging a second fragment preserves the original duration and temporal grab offset', [event('spanning', 0, 590, 750)], async page => {
    const original = await dragTo(page, 'spanning', 1, 1090, 1);
    assert.equal((await readEvent(page, 'spanning')).end, 1250);
    assert.equal(await cards(page, 'spanning').count(), 1);
    await page.locator('#undo-btn').click();
    assert.deepEqual(await readEvent(page, 'spanning'), original);
    assert.equal(await cards(page, 'spanning').count(), 2);
  }, { foldRoutines: true });

  for (const y of [272, 536]) {
    await check(`dropping into the folded separator at y=${y} leaves the original task unchanged`, [event('source', 0, 480, 510)], async page => {
      const before = await readState(page);
      await startDrag(page, 'source');
      await finishAtY(page, 1, y);
      assert.deepEqual(await readState(page), before);
      assert.equal(await page.locator('#undo-btn').isDisabled(), true);
    }, { foldRoutines: true });
  }

  await check('a visible pointer that snaps the start into hidden work time is rejected', [event('source', 0, 480, 510)], async page => {
    const before = await readState(page);
    await startDrag(page, 'source', undefined, 2);
    await finishAtY(page, 1, await timelineY(page, 599.8, 1));
    assert.deepEqual(await readState(page), before);
  }, { foldRoutines: true });

  await check('second-fragment pointer cannot move the original task start into a hidden interval', [event('spanning', 0, 590, 750)], async page => {
    const before = await readState(page);
    await startDrag(page, 'spanning', 1);
    await finishAtY(page, 1, await timelineY(page, 775, 1));
    assert.deepEqual(await readState(page), before);
  }, { foldRoutines: true });

  await check('long press without movement on a clipped fragment never changes the original task', [event('spanning', 0, 590, 750)], async page => {
    const before = await readState(page);
    await startDrag(page, 'spanning', 1);
    await page.mouse.up(); await page.waitForTimeout(80);
    assert.deepEqual(await readState(page), before);
    assert.equal(await page.locator('.is-dragging, .drag-preview').count(), 0);
    assert.equal(await page.locator('#event-dialog').isVisible(), false);
  }, { foldRoutines: true });

  await check('copying a clipped fragment copies the full task; noon and evening paste use actual clock times', [event('spanning', 0, 590, 850, 'japanese')], async page => {
    const source = await copyCard(page, 'spanning', 1);
    const noon = await pasteAt(page, 1, 733), evening = await pasteAt(page, 2, 1097);
    assert.deepEqual(noon, { ...source, id: noon.id, day: 1, start: 735, end: 995 });
    assert.deepEqual(evening, { ...source, id: evening.id, day: 2, start: 1095, end: 1355 });
    assert.notEqual(noon.id, evening.id);
    assert.equal(await page.locator('#show-routines').isChecked(), false);
    assert.equal(await page.locator('#fold-routines').isChecked(), true);
  }, { foldRoutines: true });

  await check('hidden positions reject paste while a card at a clipped boundary remains copyable', [event('source', 0, 480, 510), event('boundary', 0, 590, 600)], async page => {
    await copyCard(page, 'source');
    const before = await readState(page);
    for (const y of [272, 536, 259.6]) {
      await rightClickAtY(page, 1, y);
      assert.equal(await menu(page).isVisible(), false);
      assert.deepEqual(await readState(page), before);
    }
    await rightClickAtY(page, 0, await timelineY(page, 598, 0));
    await menu(page).waitFor({ state: 'visible' });
    assert.equal(await page.locator('#context-copy').isEnabled(), true);
    assert.equal(await page.locator('#context-paste').isDisabled(), true);
    await page.locator('#context-copy').click();
    await menu(page).waitFor({ state: 'hidden' });
    const pasted = await pasteAt(page, 1, 720);
    assert.equal(pasted.start, 720); assert.equal(pasted.end, 730);
    assert.equal(pasted.title, 'boundary');
  }, { foldRoutines: true });

  for (const showRoutines of [false, true]) {
    await check(`folding preserves routine visibility=${showRoutines}, category filters, and drag preferences`, [
      event('source', 0, 480, 510, 'fitness'), event('routine', 2, 1095, 1135, 'routine'), event('other-category', 1, 735, 775, 'japanese'),
    ], async page => {
      await page.locator('#fold-routines').check();
      assert.equal((await readState(page)).view.filter, 'fitness');
      assert.equal(await page.locator('#show-routines').isChecked(), showRoutines);
      assert.equal(await cards(page, 'routine').count(), showRoutines ? 1 : 0);
      assert.equal(await cards(page, 'other-category').count(), 0);
      await dragTo(page, 'source', 2, 1095);
      assert.equal((await readState(page)).view.filter, 'fitness');
      assert.equal(await page.locator('#show-routines').isChecked(), showRoutines);
      assert.equal(Number(await card(page, 'source').getAttribute('data-columns')), showRoutines ? 2 : 1);
      await page.locator('#fold-routines').uncheck();
      assert.equal((await readState(page)).view.filter, 'fitness');
      assert.equal(await page.locator('#show-routines').isChecked(), showRoutines);
      await page.reload();
      assert.equal(await page.locator('#show-routines').isChecked(), showRoutines);
      assert.equal(await page.locator('#fold-routines').isChecked(), false);
      assert.equal((await readState(page)).view.filter, 'fitness');
    }, { filter: 'fitness', showRoutines });
  }
} finally { await browser.close(); }

if (browserErrors.length) failures.push({ check: 'browser runtime errors', error: browserErrors });
console.log(JSON.stringify({ passed: passed.length, checks: passed, failures, browserErrors }, null, 2));
if (failures.length) process.exitCode = 1;
