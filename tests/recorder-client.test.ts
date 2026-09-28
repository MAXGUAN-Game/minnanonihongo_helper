import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Page, type Route } from '@playwright/test';
import { createServer, type ViteDevServer } from 'vite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

// Real React hook and WAV encoder; microphone, decode and network boundaries
// are deterministic browser mocks. No microphone, provider or paid API is used.
let vite: ViteDevServer; let browser: Browser; let origin: string; let cacheDir: string;
type CaptureMock = { created: string[]; revoked: string[]; starts: number; stops: number; releases: number; playing: number; changed: number; decodedDuration: number; frames: number; holdPermission: boolean; allow: (() => void) | null };
declare global { interface Window { __captureMock: CaptureMock } }
const harness = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { useRecorder, useSpeech } from '/src/client/speech.ts';
function Harness() {
  const [item, setItem] = React.useState('speak-1');
  const [text, setText] = React.useState('');
  const [notices, setNotices] = React.useState([]);
  const [calls, setCalls] = React.useState([]);
  const notice = message => setNotices(previous => [...previous, message]);
  const speech = useSpeech(notice);
  const recorder = useRecorder((text, ms, id) => { setText(text); setCalls(previous => [...previous, {text,ms,id}]); }, notice, {lessonId: 1, context:'speak', itemId:item});
  return <>
    <button onClick={() => { setText(''); recorder.start(); }}>Start</button>
    <button onClick={recorder.stop}>Stop capture</button>
    <button onClick={recorder.cancel}>Cancel</button>
    <button onClick={recorder.retrySave}>Retry save</button>
    <button onClick={recorder.retryTranscribe}>Retry transcription</button>
    <button onClick={() => setItem('speak-2')}>Change task</button>
    <button onClick={() => recorder.clip && speech.playUrl(recorder.clip.url, '我的录音')}>Preview</button>
    <button onClick={speech.pause}>Pause preview</button>
    <button onClick={speech.resume}>Resume preview</button>
    <output aria-label="Capture status">{recorder.status}</output>
    <output aria-label="Clip">{JSON.stringify(recorder.clip)}</output>
    <output aria-label="Text">{text}</output>
    <output aria-label="Calls">{JSON.stringify(calls)}</output>
    <output aria-label="Save error">{recorder.saveError}</output>
    <output aria-label="Transcription error">{recorder.transcribeError}</output>
    <output aria-label="Playback">{speech.status}</output>
    <p role="alert">{notices.join(' / ')}</p>
  </>;
}
createRoot(document.getElementById('root')).render(<Harness/>);
`;
beforeAll(async () => {
  cacheDir = await mkdtemp(join(tmpdir(), 'language-master-recorder-test-'));
  vite = await createServer({ configFile: false, root: process.cwd(), cacheDir,
    optimizeDeps: { include: ['react', 'react-dom/client', 'react/jsx-runtime', 'react/jsx-dev-runtime'], noDiscovery: true },
    server: { host: '127.0.0.1', port: 0 }, plugins: [{
      name: 'isolated-recorder-test',
      resolveId(id) { if (id === '/__recorder-harness.tsx') return id; },
      load(id) { if (id === '/__recorder-harness.tsx') return harness; },
    }],
  });
  await vite.listen(); const address = vite.httpServer!.address();
  if (!address || typeof address === 'string') throw new Error('Missing test port');
  origin = `http://127.0.0.1:${address.port}`;
  browser = await chromium.launch({ headless: true, ...(process.platform === 'win32' ? { channel: 'msedge' } : {}) });
}, 30000);
afterAll(async () => {
  await browser?.close(); await vite?.close();
  if (cacheDir && dirname(resolve(cacheDir)) === resolve(tmpdir()) && basename(cacheDir).startsWith('language-master-recorder-test-')) await rm(cacheDir, { recursive: true, force: true });
});
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
async function pageFor(options: { save?: (route: Route) => Promise<void>; transcribe?: (route: Route) => Promise<void> } = {}): Promise<{ page: Page; context: BrowserContext; uploads: URL[]; patches: unknown[]; transcriptions: string[] }> {
  const context = await browser.newContext(); const uploads: URL[] = []; const patches: unknown[] = []; const transcriptions: string[] = [];
  await context.addInitScript(() => {
    const state: CaptureMock = { created: [], revoked: [], starts: 0, stops: 0, releases: 0, playing: 0, changed: 0, decodedDuration: .5, frames: 0, holdPermission: false, allow: null };
    window.__captureMock = state;
    window.addEventListener('nihongo-recordings-changed', () => { state.changed++; });
    const fakeStream = () => ({ getTracks: () => [{ stop: () => { state.releases++; } }] });
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: {
      getUserMedia: () => state.holdPermission ? new Promise(resolve => { state.allow = () => resolve(fakeStream()); }) : Promise.resolve(fakeStream()),
    } });
    class Capture {
      static isTypeSupported(mime: string) { return mime === 'audio/mp4'; }
      state = 'inactive'; mimeType: string;
      onstop: (() => void) | null = null;
      ondataavailable: ((event: { data: Blob }) => void) | null = null;
      constructor(_stream: unknown, options?: { mimeType: string }) { this.mimeType = options?.mimeType || ''; }
      start() { state.starts++; this.state = 'recording'; }
      stop() { state.stops++; this.state = 'inactive'; queueMicrotask(() => { this.ondataavailable?.({ data: new Blob(['mock captured audio'], { type: this.mimeType }) }); this.onstop?.(); }); }
    }
    Object.defineProperty(window, 'MediaRecorder', { configurable: true, value: Capture });
    Object.defineProperty(window, 'AudioContext', { configurable: true, value: class {
      decodeAudioData() { return Promise.resolve({ duration: state.decodedDuration }); }
      close() { return Promise.resolve(); }
    } });
    Object.defineProperty(window, 'OfflineAudioContext', { configurable: true, value: class {
      destination = {};
      frames: number;
      constructor(_channels: number, frames: number) { this.frames = frames; state.frames = frames; }
      createBufferSource() { return { connect() {}, start() {}, buffer: null }; }
      startRendering() { return Promise.resolve({ getChannelData: () => new Float32Array(this.frames).fill(.1) }); }
    } });
    Object.defineProperty(window, 'Audio', { configurable: true, value: class {
      src: string; onended = null; onerror = null;
      constructor(url: string) { this.src = url; }
      play() { state.playing++; return Promise.resolve(); }
      pause() {} load() {} removeAttribute() {}
    } });
    const create = URL.createObjectURL.bind(URL); const revoke = URL.revokeObjectURL.bind(URL);
    URL.createObjectURL = blob => { const url = create(blob); state.created.push(url); return url; };
    URL.revokeObjectURL = url => { state.revoked.push(url); revoke(url); };
  });
  await context.route('**/*', async route => { if (new URL(route.request().url()).origin !== origin) await route.abort('blockedbyclient'); else await route.fallback(); });
  const page = await context.newPage(); page.setDefaultTimeout(5000);
  await page.route('**/__recorder-test', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body><div id="root"></div><script type="module" src="/__recorder-harness.tsx"></script></body></html>' }));
  await page.route('**/api/recordings**', async route => {
    if (route.request().method() === 'PATCH') { patches.push(route.request().postDataJSON()); await route.fulfill({ json: {} }); return; }
    const url = new URL(route.request().url()); uploads.push(url);
    expect(route.request().headers()['content-type']).toBe('audio/wav');
    expect(route.request().postDataBuffer()?.subarray(0, 4).toString()).toBe('RIFF');
    if (options.save) await options.save(route);
    else await route.fulfill({ json: { id: url.searchParams.get('clientRecordingId'), durationMs: 500 } });
  });
  await page.route('**/api/speech/transcribe', async route => {
    transcriptions.push(route.request().method());
    if (options.transcribe) await options.transcribe(route);
    else await route.fulfill({ json: { text: '日本語を練習します。', durationMs: 1234 } });
  });
  await page.goto(`${origin}/__recorder-test`); await page.getByRole('button', { name: 'Start', exact: true }).waitFor();
  return { page, context, uploads, patches, transcriptions };
}
const capture = async (page: Page) => {
  await page.getByRole('button', { name: 'Start', exact: true }).click();
  await expect.poll(() => page.getByLabel('Capture status').textContent()).toBe('recording');
  await page.getByRole('button', { name: 'Stop capture', exact: true }).click();
};
const clip = async (page: Page) => JSON.parse(await page.getByLabel('Clip').textContent() || 'null') as { url: string; saved: boolean; recordingId?: string; durationMs: number } | null;

describe('recording capture, local replay and independent persistence', () => {
  it('caps a slightly late recording timer at exactly 30 seconds for the server WAV', async () => {
    let uploadedBytes = 0;
    const { page, context } = await pageFor({ save: route => {
      uploadedBytes = route.request().postDataBuffer()!.length;
      return route.fulfill({ json: { id: new URL(route.request().url()).searchParams.get('clientRecordingId'), durationMs: 30000 } });
    } });
    try {
      await page.evaluate(() => { window.__captureMock.decodedDuration = 30.04; });
      await capture(page);
      await expect.poll(async () => (await clip(page))?.saved).toBe(true);
      expect(await page.evaluate(() => window.__captureMock.frames)).toBe(480000);
      expect(uploadedBytes).toBe(960044);
      expect((await clip(page))!.durationMs).toBe(30000);
    } finally { await context.close(); }
  });

  it('keeps a playable preview when saving fails, then retries the same UUID without repeating transcription', async () => {
    let saves = 0;
    const { page, context, uploads, patches, transcriptions } = await pageFor({ save: route => ++saves === 1
      ? route.fulfill({ status: 503, json: { error: '保存暂时失败' } })
      : route.fulfill({ json: { id: new URL(route.request().url()).searchParams.get('clientRecordingId'), durationMs: 500 } }) });
    try {
      await capture(page);
      await expect.poll(() => page.getByLabel('Text').textContent()).toBe('日本語を練習します。');
      await expect.poll(() => page.getByLabel('Save error').textContent()).toContain('保存暂时失败');
      const preview = (await clip(page))!.url;
      expect((await clip(page))!).toMatchObject({ saved: false, durationMs: 500 });
      await page.getByRole('button', { name: 'Preview', exact: true }).click();
      await expect.poll(() => page.getByLabel('Playback').textContent()).toBe('playing');
      await page.getByRole('button', { name: 'Pause preview', exact: true }).click();
      expect(await page.getByLabel('Playback').textContent()).toBe('paused');
      await page.getByRole('button', { name: 'Resume preview', exact: true }).click();
      await page.getByRole('button', { name: 'Retry save', exact: true }).click();
      await expect.poll(async () => (await clip(page))!.saved).toBe(true);
      await expect.poll(() => patches).toContainEqual({ transcript: '日本語を練習します。' });
      await expect.poll(() => page.evaluate(() => window.__captureMock.changed)).toBeGreaterThanOrEqual(2);
      expect((await clip(page))!.url).toBe(preview);
      expect(uploads).toHaveLength(2);
      expect(uploads[0]!.searchParams.get('clientRecordingId')).toBe(uploads[1]!.searchParams.get('clientRecordingId'));
      expect(uploads[0]!.searchParams.get('context')).toBe('speak');
      expect(uploads[0]!.searchParams.get('itemId')).toBe('speak-1');
      expect(transcriptions).toHaveLength(1);
      expect(JSON.parse(await page.getByLabel('Calls').textContent() || '[]')).toHaveLength(1);
    } finally { await context.close(); }
  });

  it('keeps a saved recording after transcription failure and retries recognition independently', async () => {
    let attempts = 0;
    const { page, context, uploads, transcriptions } = await pageFor({ transcribe: route => ++attempts === 1
      ? route.fulfill({ status: 503, json: { error: '模型尚未准备好' } })
      : route.fulfill({ json: { text: 'もう一度。', durationMs: 2345 } }) });
    try {
      await capture(page);
      await expect.poll(async () => (await clip(page))?.saved).toBe(true);
      await expect.poll(() => page.getByLabel('Transcription error').textContent()).toBe('模型尚未准备好');
      expect(await page.getByLabel('Capture status').textContent()).toBe('idle');
      await page.getByRole('button', { name: 'Retry transcription', exact: true }).click();
      await expect.poll(() => page.getByLabel('Text').textContent()).toBe('もう一度。');
      expect(JSON.parse(await page.getByLabel('Calls').textContent() || '[]')).toEqual([{ text: 'もう一度。', ms: 2345, id: (await clip(page))!.recordingId }]);
      expect(uploads).toHaveLength(1); expect(transcriptions).toHaveLength(2);
    } finally { await context.close(); }
  });

  it('cancel discards recording without uploading, and releasing during the permission prompt never starts capture', async () => {
    const { page, context, uploads, transcriptions } = await pageFor();
    try {
      await page.getByRole('button', { name: 'Start', exact: true }).click();
      await expect.poll(() => page.getByLabel('Capture status').textContent()).toBe('recording');
      await page.getByRole('button', { name: 'Cancel', exact: true }).click();
      expect(await clip(page)).toBeNull();
      await page.evaluate(() => { window.__captureMock.holdPermission = true; });
      await page.getByRole('button', { name: 'Start', exact: true }).click();
      expect(await page.getByLabel('Capture status').textContent()).toBe('asking');
      await page.getByRole('button', { name: 'Stop capture', exact: true }).click();
      await page.evaluate(() => window.__captureMock.allow?.());
      await expect.poll(() => page.getByLabel('Capture status').textContent()).toBe('idle');
      expect(await page.evaluate(() => window.__captureMock.starts)).toBe(1);
      expect(await page.evaluate(() => window.__captureMock.releases)).toBe(2);
      expect(uploads).toEqual([]); expect(transcriptions).toEqual([]);
    } finally { await context.close(); }
  });

  it('changing task aborts old work, releases its preview and ignores a late transcript', async () => {
    const held = deferred(); const release = deferred(); const handled = deferred();
    const { page, context } = await pageFor({ transcribe: async route => {
      held.resolve(); await release.promise;
      try { await route.fulfill({ json: { text: '旧任务的文字', durationMs: 2000 } }); } catch { /* canceled request */ } finally { handled.resolve(); }
    } });
    try {
      await capture(page); await held.promise;
      const preview = (await clip(page))!.url;
      await page.getByRole('button', { name: 'Change task', exact: true }).click();
      await expect.poll(() => clip(page)).toBeNull();
      expect(await page.evaluate(() => window.__captureMock.revoked)).toContain(preview);
      release.resolve(); await handled.promise;
      expect(await page.getByLabel('Text').textContent()).toBe('');
      expect(await page.getByLabel('Calls').textContent()).toBe('[]');
      expect(await page.getByLabel('Capture status').textContent()).toBe('idle');
    } finally { release.resolve(); await context.close(); }
  });
});
