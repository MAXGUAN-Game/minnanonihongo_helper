import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import fastifyStatic from '@fastify/static';
import { buildApp } from '../src/server/app.ts';

// Run after npm run build: node --import tsx scripts/check-cloud-voice.mjs
// The database, test key and audio cache belong to an isolated temporary folder.
// Provider responses are simulated. HTMLAudio playback itself is not mocked.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const prefix = 'nihongo-cloud-voice-browser-';
const temporary = await mkdtemp(path.join(tmpdir(), prefix));
const testKey = 'minimax-browser-test-secret-not-a-real-key';
const calls = [], synthesisRequests = [], synthesisResponses = [];
const checks = [], failures = [], audits = [], runtimeErrors = [];
let forbiddenAiCalls = 0, blockedExternalRequests = 0;

function wav(seconds) {
  const frames = Math.round(seconds * 32000);
  const audio = Buffer.alloc(44 + frames * 2);
  audio.write('RIFF', 0); audio.writeUInt32LE(audio.length - 8, 4); audio.write('WAVEfmt ', 8);
  audio.writeUInt32LE(16, 16); audio.writeUInt16LE(1, 20); audio.writeUInt16LE(1, 22);
  audio.writeUInt32LE(32000, 24); audio.writeUInt32LE(64000, 28);
  audio.writeUInt16LE(2, 32); audio.writeUInt16LE(16, 34);
  audio.write('data', 36); audio.writeUInt32LE(frames * 2, 40);
  for (let index = 0; index < frames; index++) {
    const envelope = Math.min(1, index / 320, (frames - index) / 320);
    audio.writeInt16LE(Math.round(Math.sin(index * 2 * Math.PI * 440 / 32000) * 800 * envelope), 44 + index * 2);
  }
  return audio;
}

const app = buildApp({
  dataDir: temporary,
  aiFetch: async () => { forbiddenAiCalls++; throw new Error('Paid AI requests are prohibited in this acceptance suite.'); },
  voiceFetch: async (url, init) => {
    assert.equal(String(url), 'https://api.minimax.cn/v1/t2a_v2');
    assert.equal(new Headers(init.headers).get('Authorization') === `Bearer ${testKey}`, true, 'expected only the isolated test key');
    const input = JSON.parse(init.body);
    calls.push(input);
    const audio = wav(input.text.includes('もう一度') ? 2.5 : 0.65);
    return new Response(JSON.stringify({ base_resp: { status_code: 0 }, data: { audio: audio.toString('hex'), status: 2 } }), { headers: { 'Content-Type': 'application/json' } });
  },
});
let browser;

async function check(name, run) {
  try { await run(); checks.push(name); console.log('PASS ' + name); }
  catch (error) { failures.push({ check: name, error: error.message }); console.log('FAIL ' + name + '\n' + error.message); }
}

try {
  await app.register(fastifyStatic, { root: path.join(root, 'dist') });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address();
  assert.equal(typeof address, 'object');
  const base = `http://127.0.0.1:${address.port}`;
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
  await context.route('**/*', route => {
    const url = route.request().url();
    if (url.startsWith(base + '/')) return route.continue();
    blockedExternalRequests++;
    return route.abort('blockedbyclient');
  });
  await context.addInitScript(() => {
    window.__cloudVoiceAudio = { events: [], elements: [] };
    const original = HTMLMediaElement.prototype.play;
    const observed = new WeakMap();
    HTMLMediaElement.prototype.play = function (...args) {
      if (this instanceof HTMLAudioElement && this.src.startsWith('blob:')) {
        if (!observed.has(this)) {
          const id = window.__cloudVoiceAudio.elements.length;
          observed.set(this, id);
          window.__cloudVoiceAudio.elements.push(this);
          for (const type of ['playing', 'ended', 'pause', 'error']) {
            // Observe completion before the app's onended handler releases its blob URL.
            this.addEventListener(type, () => window.__cloudVoiceAudio.events.push({ id, type, currentTime: this.currentTime, duration: Number.isFinite(this.duration) ? this.duration : null }), { capture: true });
          }
        }
      }
      return original.apply(this, args);
    };
  });
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  page.on('pageerror', error => runtimeErrors.push(error.message));
  page.on('request', request => {
    if (new URL(request.url()).pathname === '/api/voice/synthesize') synthesisRequests.push(request.postDataJSON());
  });
  page.on('response', response => {
    if (new URL(response.url()).pathname === '/api/voice/synthesize') {
      synthesisResponses.push(response.allHeaders().then(headers => ({ status: response.status(), cache: headers['x-voice-cache'], type: headers['content-type'] })));
    }
  });
  const card = page.locator('.voice-settings');
  async function api(route, method = 'GET', body) {
    const response = await fetch(base + '/api' + route, { method, headers: body === undefined ? {} : { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    assert.equal(response.ok, true, `local ${method} ${route} failed: ${response.status}`);
    return response.json();
  }
  let navigationId = 0;
  async function openSettings() {
    await page.goto(`${base}/?voice-acceptance=${++navigationId}#settings`);
    await card.getByRole('button', { name: '保存声音设置', exact: true }).waitFor();
  }
  async function endedCount() { return page.evaluate(() => window.__cloudVoiceAudio.events.filter(event => event.type === 'ended').length); }
  async function playDialogue() {
    const ended = await endedCount();
    await card.getByRole('button', { name: '试听短对话', exact: true }).click();
    await expect.poll(endedCount).toBe(ended + 2);
    await expect(card.getByRole('button', { name: '停止朗读', exact: true })).toHaveCount(0);
  }

  await check('MiniMax settings save by keyboard and clear the password input', async () => {
    await openSettings();
    await expect(card.getByRole('button', { name: '本机声音 · 离线', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await card.getByRole('button', { name: '云端 AI 声音 · MiniMax', exact: true }).focus();
    await page.keyboard.press('Enter');
    await expect(card.getByText('MiniMax 密钥未配置', { exact: true })).toBeVisible();
    await card.locator('#minimax-speech-key').fill(testKey);
    await card.getByLabel(/^声音质量/).selectOption('speech-2.8-turbo');
    await card.getByLabel(/^日语声音/).selectOption('Japanese_CalmLady');
    const alternate = card.getByRole('checkbox', { name: /对话使用两种声音/ });
    await alternate.uncheck();
    await expect(card.getByLabel(/^对话中第二个人的声音/)).toBeDisabled();
    await alternate.check();
    await card.getByLabel(/^对话中第二个人的声音/).selectOption('Japanese_GentleButler');
    await card.getByRole('button', { name: '慢一点 · 0.8×', exact: true }).click();
    await card.getByRole('button', { name: '保存声音设置', exact: true }).focus();
    await page.keyboard.press('Enter');
    await expect(card.getByText('声音设置已保存。', { exact: true })).toBeVisible();
    await expect(card.locator('#minimax-speech-key')).toHaveValue('');
    await expect(card.getByText('MiniMax 密钥已配置 · 试听可确认是否可用', { exact: true })).toBeVisible();
    assert.deepEqual(await api('/voice/settings'), { provider: 'minimax', model: 'speech-2.8-turbo', voice: 'Japanese_CalmLady', secondaryVoice: 'Japanese_GentleButler', alternateSpeakers: true, speed: .8, hasApiKey: true });
    assert.equal(calls.length, 0, 'saving must not synthesize billable audio');
  });

  await check('reload persists selections and learning backup excludes the voice key', async () => {
    await openSettings();
    await expect(card.getByRole('button', { name: '云端 AI 声音 · MiniMax', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(card.getByLabel(/^声音质量/)).toHaveValue('speech-2.8-turbo');
    await expect(card.getByLabel(/^日语声音/)).toHaveValue('Japanese_CalmLady');
    await expect(card.getByLabel(/^对话中第二个人的声音/)).toHaveValue('Japanese_GentleButler');
    await expect(card.getByRole('button', { name: '慢一点 · 0.8×', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(card.locator('#minimax-speech-key')).toHaveValue('');
    const backup = JSON.stringify(await api('/backup'));
    const settings = JSON.stringify(await api('/voice/settings'));
    assert.equal(backup.includes(testKey) || settings.includes(testKey), false, 'test secret must never be returned');
    assert.equal(backup.includes('"apiKey"') || backup.includes('voice_secrets'), false);
  });

  await check('short dialogue synthesizes two selected voices and plays real HTMLAudio', async () => {
    await playDialogue();
    assert.equal(calls.length, 2);
    assert.deepEqual(calls.map(call => call.voice_setting.voice_id), ['Japanese_CalmLady', 'Japanese_GentleButler']);
    assert.deepEqual(calls.map(call => call.voice_setting.speed), [.8, .8]);
    assert.equal(calls.every(call => call.model === 'speech-2.8-turbo' && call.language_boost === 'Japanese'), true);
    assert.deepEqual(synthesisRequests.map(request => request.speaker), ['primary', 'secondary']);
    assert.deepEqual((await Promise.all(synthesisResponses)).map(response => response.cache), ['miss', 'miss']);
    const events = await page.evaluate(() => window.__cloudVoiceAudio.events);
    assert.equal(events.filter(event => event.type === 'playing').length, 2);
    assert.equal(events.filter(event => event.type === 'ended' && event.currentTime >= .6).length, 2);
    assert.equal(events.some(event => event.type === 'error'), false);
    assert.equal((await api('/voice/settings')).hasApiKey, true, 'blank preview key must preserve the stored key');
  });

  await check('repeated dialogue uses local cached audio without a provider request', async () => {
    await playDialogue();
    assert.equal(calls.length, 2);
    const responses = await Promise.all(synthesisResponses);
    assert.deepEqual(responses.slice(-2).map(response => response.cache), ['hit', 'hit']);
    assert.equal(responses.every(response => response.status === 200 && response.type.startsWith('audio/wav')), true);
    assert.equal((await api('/voice/cache')).clips, 2);
  });

  await check('stop interrupts an actual playing audio element', async () => {
    const previous = await page.evaluate(() => window.__cloudVoiceAudio.elements.length);
    const ended = await endedCount();
    await card.getByRole('button', { name: '保存并试听', exact: true }).click();
    await expect.poll(() => page.evaluate(index => {
      const audio = window.__cloudVoiceAudio.elements[index];
      return Boolean(audio && !audio.paused && audio.currentTime > 0);
    }, previous), { message: 'new HTMLAudio element should advance its playback position' }).toBe(true);
    await card.getByRole('button', { name: '停止朗读', exact: true }).click();
    await expect(card.getByRole('button', { name: '停止朗读', exact: true })).toHaveCount(0);
    // Calling load() after pause() can discard the queued pause event. Inspect the
    // media state instead so this verifies the user-visible stop behavior.
    assert.equal(await page.evaluate(() => window.__cloudVoiceAudio.elements.every(element => element.paused && !element.hasAttribute('src'))), true);
    assert.equal(await endedCount(), ended, 'stopped audio must not run to completion');
    assert.equal(calls.length, 3);
  });

  await check('cache cleanup asks for confirmation, supports cancel, and preserves settings', async () => {
    await card.getByText('管理已生成的声音', { exact: true }).click();
    await expect(card.getByText(/已缓存 3 段/)).toBeVisible();
    const before = await api('/voice/settings');
    await card.getByRole('button', { name: '清理声音缓存', exact: true }).click();
    await expect(card.getByRole('group', { name: '确认清理声音缓存', exact: true })).toBeVisible();
    await card.getByRole('button', { name: '取消', exact: true }).click();
    assert.equal((await api('/voice/cache')).clips, 3);
    await card.getByRole('button', { name: '清理声音缓存', exact: true }).click();
    await card.getByRole('button', { name: '确认清理', exact: true }).click();
    await expect(card.getByText(/已缓存 0 段/)).toBeVisible();
    assert.deepEqual(await api('/voice/cache'), { clips: 0, bytes: 0 });
    assert.deepEqual(await api('/voice/settings'), before);
    await expect(card.getByRole('button', { name: '清理声音缓存', exact: true })).toBeDisabled();
  });

  await check('large text, phone width and 200 percent CSS zoom remain accessible', async () => {
    await api('/settings', 'PATCH', { largeText: true });
    for (const scenario of [{ width: 1280, zoom: 1 }, { width: 390, zoom: 1 }, { width: 1280, zoom: 2 }]) {
      await page.setViewportSize({ width: scenario.width, height: 900 });
      await openSettings();
      await page.evaluate(zoom => { document.documentElement.style.zoom = String(zoom); }, scenario.zoom);
      await card.getByText('没有 MiniMax 密钥？查看 3 步开通方法', { exact: true }).click();
      await card.getByText('管理已生成的声音', { exact: true }).click();
      await expect(card.getByText(/已缓存 0 段/)).toBeVisible();
      const result = await new AxeBuilder({ page }).include('.voice-settings').analyze();
      const layout = await card.evaluate(element => {
        const controls = [...element.querySelectorAll('input, select, button, summary')].filter(control => control.getClientRects().length && !control.disabled);
        return {
          documentOverflow: document.documentElement.scrollWidth > innerWidth + 1,
          cardOverflow: element.scrollWidth > element.clientWidth + 1,
          clipped: [...element.querySelectorAll('h2, p, label, button, summary')].filter(node => node.getClientRects().length && node.clientWidth > 0 && node.scrollWidth > node.clientWidth + 1 && ['hidden', 'clip'].includes(getComputedStyle(node).overflowX)).map(node => node.textContent.trim().slice(0, 80)),
          undersizedControls: controls.filter(control => control.tagName !== 'INPUT' || control.type !== 'checkbox').filter(control => control.getBoundingClientRect().height < 44).map(control => control.tagName),
        };
      });
      audits.push({ ...scenario, ...layout, violations: result.violations.map(violation => ({ id: violation.id, impact: violation.impact, targets: violation.nodes.map(node => node.target) })) });
    }
    assert.equal(audits.some(audit => audit.documentOverflow || audit.cardOverflow || audit.clipped.length || audit.undersizedControls.length), false, 'layout or touch-target issue; inspect audit output');
    assert.equal(audits.some(audit => audit.violations.length), false, 'axe accessibility issue; inspect audit output');
  });

  await check('no browser errors, external browser traffic, or paid AI calls', async () => {
    assert.deepEqual(runtimeErrors, []);
    assert.equal(blockedExternalRequests, 0);
    assert.equal(forbiddenAiCalls, 0);
  });
} finally {
  await browser?.close();
  await app.close();
  const absolute = path.resolve(temporary);
  if (path.dirname(absolute) !== path.resolve(tmpdir()) || !path.basename(absolute).startsWith(prefix)) throw new Error('Unexpected temporary path; refusing cleanup');
  await rm(absolute, { recursive: true, force: true });
}

console.log(JSON.stringify({ passed: checks, failures, audits, runtimeErrors, mockVoiceCalls: calls.length, forbiddenAiCalls, blockedExternalRequests, naturalVoiceQualityTested: false }, null, 2));
if (failures.length) process.exitCode = 1;
