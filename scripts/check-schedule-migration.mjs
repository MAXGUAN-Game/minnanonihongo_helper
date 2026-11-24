import assert from 'node:assert/strict';
import { mkdtemp, readFile, copyFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from '@playwright/test';
import fastifyStatic from '@fastify/static';
import { buildApp } from '../src/server/app.ts';

const filename = process.argv[2];
if (!filename) throw new Error('Expected a private schedule envelope path.');
const expected = JSON.parse(await readFile(filename, 'utf8'));
const temporary = await mkdtemp(path.join(tmpdir(), 'nihongo-migration-check-'));
await copyFile(filename, path.join(temporary, 'weekly-schedule.json'));
const app = buildApp({ dataDir: temporary });
let browser;
try {
  await app.register(fastifyStatic, { root: path.resolve('dist') });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  browser = await chromium.launch({ headless: true, ...(process.platform === 'win32' ? { channel: 'msedge' } : {}) });
  const context = await browser.newContext();
  await context.route('**/api/bootstrap', async route => { const response = await route.fetch(); const value = await response.json(); value.deployment = 'web'; await route.fulfill({ json: value }); });
  const page = await context.newPage();
  await page.goto(origin + '/#schedule');
  await page.getByText('已保存到服务器', { exact: true }).waitFor();
  const after = await (await fetch(origin + '/api/schedule')).json();
  assert.deepEqual(after.state, expected.state);
  assert.equal(after.revision, expected.revision);
  console.log(`PASS actual migration roundtrip: ${after.state.events.length} stable events, ${Object.keys(after.state.legacyWeeks ?? {}).length} legacy week; titles, notes, IDs and times unchanged`);
  await context.close();
} finally { await browser?.close(); await app.close(); await rm(temporary, { recursive: true, force: true }); }
