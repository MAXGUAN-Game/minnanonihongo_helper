import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import fastifyStatic from '@fastify/static';
import { buildApp } from '../src/server/app.ts';
import { getSpeechStatus, registerSpeechRoutes } from '../src/server/speech.ts';

// Uses a synthesized Japanese WAV as a virtual microphone; never records a person.
// Runs the real browser recorder, normalization and installed local Whisper engine.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixture = path.join(root, 'test-results', 'japanese-speech-sample.wav');
assert.ok(existsSync(fixture), 'Run scripts/check-speech.ps1 first to create the synthetic WAV.');
const speechData = path.join(root, 'data');
assert.ok(getSpeechStatus(speechData).ready, 'Install local speech first.');
const temporary = await mkdtemp(path.join(tmpdir(), 'nihongo-speech-browser-'));
let paidCalls = 0;
const app = buildApp({ dataDir: temporary, speechStatus: () => getSpeechStatus(speechData), aiFetch: async () => { paidCalls++; throw new Error('Paid AI calls are forbidden in this check.'); } });
registerSpeechRoutes(app, speechData);
await app.register(fastifyStatic, { root: path.join(root, 'dist') });
await app.listen({ host: '127.0.0.1', port: 0 });
const base = `http://127.0.0.1:${app.server.address().port}`;
const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', `--use-file-for-fake-audio-capture=${fixture}`] });
try {
  const page = await browser.newPage();
  page.setDefaultTimeout(20000);
  let sentTurns = 0;
  page.on('request', request => { if (request.url().endsWith('/turn')) sentTurns++; });
  await page.goto(`${base}/#study/14`);
  await page.locator('.stage-tabs').getByRole('button', { name: '用起来' }).click();
  await page.locator('.scenario-card').first().click();
  await page.getByRole('button', { name: '或点击开始录音' }).click();
  await page.getByRole('button', { name: '点击结束录音' }).waitFor();
  // Deliberate recording duration to capture the synthetic sentence.
  await page.waitForTimeout(6500);
  const responsePromise = page.waitForResponse(response => response.url().endsWith('/speech/transcribe'), { timeout: 120000 });
  await page.getByRole('button', { name: '点击结束录音' }).click();
  const response = await responsePromise;
  const recognized = await response.json();
  assert.equal(response.status(), 200, JSON.stringify(recognized));
  await page.waitForFunction(() => document.querySelector('#answer-draft')?.value.length > 0);
  assert.match(recognized.text, /駅|こんにちは|お願いします/);
  assert.equal(await page.locator('#answer-draft').inputValue(), recognized.text);
  assert.equal(sentTurns, 0, 'Transcription must never send to AI before confirmation.');
  await page.locator('#answer-draft').fill('もう一度お願いします。');
  assert.equal(await page.locator('#answer-draft').inputValue(), 'もう一度お願いします。');
  assert.equal(sentTurns, 0);
  assert.equal(paidCalls, 0);
  const result = { source: 'synthetic WAV through virtual microphone, not physical microphone', ...recognized, confirmedEditable: true, sentTurns, paidCalls };
  await writeFile(path.join(root, 'test-results', 'speech-browser-check.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} finally {
  await browser.close(); await app.close();
  assert.ok(temporary.startsWith(path.join(tmpdir(), 'nihongo-speech-browser-')));
  await rm(temporary, { recursive: true, force: true });
}
