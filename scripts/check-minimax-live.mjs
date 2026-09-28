import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';

// Deliberate, small real-service check. Normal automated tests never run this.
if (!process.argv.includes('--allow-paid')) throw new Error('This check can consume MiniMax credit. Pass --allow-paid to opt in.');
const base = 'http://127.0.0.1:4317';
const settings = await fetch(base + '/api/voice/settings').then(response => response.json());
assert.equal(settings.provider, 'minimax');
assert.equal(settings.hasApiKey, true);
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
page.setDefaultTimeout(40000);
await page.addInitScript(() => {
  window.__voiceEvents = [];
  const NativeAudio = window.Audio;
  window.Audio = function (source) {
    const audio = new NativeAudio(source);
    for (const name of ['playing', 'ended', 'error']) audio.addEventListener(name, () => window.__voiceEvents.push({ name, duration: audio.duration }));
    return audio;
  };
  window.Audio.prototype = NativeAudio.prototype;
});
const clips = [];
const errors = [];
page.on('pageerror', error => errors.push(error.message));
page.on('response', response => {
  if (response.url().endsWith('/voice/synthesize')) clips.push({ status: response.status(), cache: response.headers()['x-voice-cache'], input: response.request().postDataJSON() });
});
try {
  await page.goto(base + '/#settings');
  const card = page.locator('.voice-settings');
  await card.getByText('MiniMax 密钥已配置 · 试听可确认是否可用', { exact: true }).waitFor();
  await card.getByRole('button', { name: '保存并试听', exact: true }).click();
  await page.waitForFunction(() => window.__voiceEvents.filter(event => event.name === 'ended').length >= 1);
  await card.getByRole('button', { name: '保存并试听', exact: true }).click();
  await page.waitForFunction(() => window.__voiceEvents.filter(event => event.name === 'ended').length >= 2);
  assert.equal(clips[1].cache, 'hit', 'Replay should use the same generated clip without another paid synthesis.');
  await card.getByRole('button', { name: '试听短对话', exact: true }).click();
  await page.waitForFunction(() => window.__voiceEvents.filter(event => event.name === 'ended').length >= 4);
  assert.equal(clips[2].input.speaker, 'primary');
  assert.equal(clips[3].input.speaker, 'secondary');
  const slowResult = await page.evaluate(async () => {
    const response = await fetch('/api/voice/synthesize', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'こんにちは。駅はどこですか。', rate: .65, speaker: 'primary' }) });
    if (!response.ok) throw new Error((await response.json()).error);
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    try {
      const clip = new Audio(url);
      await new Promise((resolve, reject) => { clip.onended = resolve; clip.onerror = reject; clip.play().catch(reject); });
      return { bytes: blob.size, duration: clip.duration, cache: response.headers.get('x-voice-cache') };
    } finally { URL.revokeObjectURL(url); }
  });
  const events = await page.evaluate(() => window.__voiceEvents);
  assert.ok(clips.every(clip => clip.status === 200));
  assert.equal(events.some(event => event.name === 'error'), false);
  assert.deepEqual(errors, []);
  const result = { model: settings.model, primaryVoice: settings.voice, secondaryVoice: settings.secondaryVoice, clips, slowResult, events, errors, note: 'Real MiniMax generation and browser playback events; no human listening-quality score.' };
  await mkdir('test-results', { recursive: true });
  await writeFile('test-results/minimax-live-check.json', JSON.stringify(result, null, 2));
  await page.locator('.voice-settings').screenshot({ path: 'test-results/voice-settings.png' });
  console.log(JSON.stringify(result, null, 2));
} finally { await browser.close(); }
