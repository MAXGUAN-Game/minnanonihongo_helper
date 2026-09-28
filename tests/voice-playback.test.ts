import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Page, type Route } from '@playwright/test';
import { createServer, type ViteDevServer } from 'vite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

// Exercise the real hook in a browser, with local routes and manually completed
// audio. No speech provider, operating-system voice, or paid API is contacted.
let vite: ViteDevServer;
let browser: Browser;
let origin: string;
let cacheDir: string;
const lines = ['こんにちは。', 'お元気ですか。', 'はい、元気です。'];
const replacement = 'もう一度お願いします。';
const cloudSettings = {
  provider: 'minimax', model: 'speech-2.6-hd', hasApiKey: true,
  voice: 'Japanese_SeriousCommander', secondaryVoice: 'Japanese_KindLady', alternateSpeakers: true, speed: 1,
};
type SynthesisRequest = { text: string; rate: number; speaker: 'primary' | 'secondary' };
type Clip = { src: string; plays: number; pauses: number; paused: boolean; currentTime: number; finish: () => void };
type LocalUtterance = { text: string; lang: string; rate: number; voice?: { localService: boolean }; onend?: ((event: Event) => void) | null };
type VoiceMock = {
  clips: Clip[];
  local: LocalUtterance[];
  canceled: number;
  requests: Array<{ path: string; aborted: boolean; settled: boolean }>;
  blobTypes: string[];
  revoked: string[];
  blockNext: boolean;
  systemPauses: number;
  systemResumes: number;
};
declare global { interface Window { __voiceMock: VoiceMock } }

const harness = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { useSpeech } from '/src/client/speech.ts';
import { AudioControls } from '/src/client/AudioControls.tsx';
function Harness() {
  const [notices, setNotices] = React.useState([]);
  const [hiddenSources, setHiddenSources] = React.useState([]);
  const [sequenceSource, setSequenceSource] = React.useState('sequence');
  const hide = sourceId => setHiddenSources(previous => [...previous, sourceId]);
  const notice = React.useCallback(message => setNotices(previous => [...previous, message]), []);
  const speech = useSpeech(notice);
  return <>
    <button onClick={() => speech.say(${JSON.stringify(lines)}, 'ja-JP', .65, 'sequence')}>Sequence</button>
    <button onClick={() => speech.say(${JSON.stringify(replacement)}, 'ja-JP', 1, 'replacement')}>Replay</button>
    <button onClick={() => speech.say('请再说一遍。', 'zh-CN', .8, 'chinese')}>Chinese</button>
    <button onClick={() => speech.say('请再说一遍。', 'zh-CN', .8)}>Legacy</button>
    <button onClick={speech.stop}>Stop</button>
    <button onClick={speech.pause}>Pause</button>
    <button onClick={speech.resume}>Resume</button>
    <button onClick={speech.replay}>Restart</button>
    <button onClick={() => speech.playUrl('/api/recordings/example/audio', '自己的录音', 'recording')}>URL</button>
    <button onClick={() => speech.sayAuto('自动回复', speech.getEpoch(), 'zh-CN', 1, 'automatic')}>Automatic</button>
    <button onClick={() => { const epoch = speech.getEpoch(); speech.stop(); speech.sayAuto('迟到的回复', epoch, 'zh-CN', 1, 'automatic'); }}>Stale auto</button>
    <button onClick={() => { const epoch = speech.getEpoch(); speech.say('新的朗读', 'zh-CN', 1, 'chinese'); speech.sayAuto('迟到的回复', epoch, 'zh-CN', 1, 'automatic'); }}>Stale after switch</button>
    {['sequence', 'replacement', 'recording'].map(sourceId => <button key={sourceId} onClick={() => hide(sourceId)}>Hide {sourceId}</button>)}
    <button onClick={() => { speech.playUrl('/api/recordings/example/audio', '自己的录音', 'recording'); hide('sequence'); }}>Switch and hide</button>
    <button onClick={() => setSequenceSource('retargeted')}>Retarget controller</button>
    <button onClick={() => { speech.say('新的朗读', 'zh-CN', 1, 'retargeted'); setSequenceSource('retargeted'); }}>Switch and retarget</button>
    {['sequence', 'replacement', 'chinese', 'recording', 'automatic'].filter(sourceId => !hiddenSources.includes(sourceId)).map(sourceId => <div key={sourceId} data-testid={sourceId}><AudioControls speech={speech} sourceId={sourceId === 'sequence' ? sequenceSource : sourceId}/></div>)}
    <div data-testid="legacy-mock"><AudioControls speech={{ ...speech, sourceId: undefined, stopSource: undefined }} sourceId="legacy-mock"/></div>
    <output aria-label="Playback">{speech.speaking ? 'playing' : 'idle'}</output>
    <output aria-label="Phase">{speech.status}</output>
    <output aria-label="Source">{speech.sourceId ?? ''}</output>
    <p role="alert">{notices.join('\\n')}</p>
  </>;
}
createRoot(document.getElementById('root')).render(<Harness/>);
`;

beforeAll(async () => {
  // Browser suites run concurrently. Sharing Vite's dependency cache lets one
  // server replace the other's optimized modules while its first page loads.
  cacheDir = await mkdtemp(join(tmpdir(), 'language-master-voice-test-'));
  vite = await createServer({ configFile: false, root: process.cwd(), cacheDir,
    optimizeDeps: { include: ['react', 'react-dom/client', 'react/jsx-runtime', 'react/jsx-dev-runtime', 'lucide-react'], noDiscovery: true },
    server: { host: '127.0.0.1', port: 0 }, plugins: [{
    name: 'isolated-voice-test',
    resolveId(id) { if (id === '/__voice-harness.tsx') return id; },
    load(id) { if (id === '/__voice-harness.tsx') return harness; },
  }] });
  await vite.listen();
  const address = vite.httpServer!.address();
  if (!address || typeof address === 'string') throw new Error('Missing test server port');
  origin = `http://127.0.0.1:${address.port}`;
  browser = await chromium.launch({ headless: true, ...(process.platform === 'win32' ? { channel: 'msedge' } : {}) });
}, 30000);
afterAll(async () => {
  await browser?.close(); await vite?.close();
  if (cacheDir && dirname(resolve(cacheDir)) === resolve(tmpdir()) && basename(cacheDir).startsWith('language-master-voice-test-')) {
    await rm(cacheDir, { recursive: true, force: true });
  }
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

// A valid mono 16-bit PCM WAV containing a short silent sample. Audio itself is
// controlled below, so the regression does not depend on sound hardware/timing.
const wav = Buffer.alloc(364);
wav.write('RIFF', 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(16000, 24); wav.writeUInt32LE(32000, 28); wav.writeUInt16LE(2, 32);
wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(wav.length - 44, 40);
const fulfillAudio = (route: Route) => route.fulfill({ contentType: 'audio/wav', body: wav });

async function pageFor(options: {
  provider?: 'minimax' | 'system';
  speed?: number;
  settings?: (route: Route) => Promise<void>;
  synthesize?: (route: Route) => Promise<void>;
} = {}): Promise<{ page: Page; context: BrowserContext; requests: SynthesisRequest[]; settingsRequests: string[]; externalRequests: string[] }> {
  const context = await browser.newContext();
  const requests: SynthesisRequest[] = [];
  const settingsRequests: string[] = [];
  const externalRequests: string[] = [];
  await context.addInitScript(() => {
    const state: VoiceMock = { clips: [], local: [], canceled: 0, requests: [], blobTypes: [], revoked: [], blockNext: false, systemPauses: 0, systemResumes: 0 };
    window.__voiceMock = state;
    class ControlledAudio extends EventTarget {
      src: string;
      plays = 0;
      pauses = 0;
      paused = true;
      currentTime = 0;
      playbackRate = 1;
      onended: ((event: Event) => void) | null = null;
      onerror: ((event: Event) => void) | null = null;
      constructor(src = '') { super(); this.src = src; state.clips.push(this); }
      play() {
        this.plays++;
        if (state.blockNext) { state.blockNext = false; return Promise.reject(new DOMException('Gesture required', 'NotAllowedError')); }
        this.paused = false; return Promise.resolve();
      }
      pause() { this.pauses++; this.paused = true; }
      load() {}
      removeAttribute(name: string) { if (name === 'src') this.src = ''; }
      finish() {
        this.paused = true;
        const event = new Event('ended');
        this.dispatchEvent(event);
        this.onended?.(event);
      }
    }
    Object.defineProperty(window, 'Audio', { configurable: true, value: ControlledAudio });
    class ControlledUtterance extends EventTarget {
      text: string;
      lang = '';
      rate = 1;
      voice?: { localService: boolean };
      onend: ((event: Event) => void) | null = null;
      constructor(text: string) { super(); this.text = text; }
    }
    Object.defineProperty(window, 'SpeechSynthesisUtterance', { configurable: true, value: ControlledUtterance });
    const synthesis = new EventTarget();
    Object.assign(synthesis, {
      getVoices: () => [
        { name: 'Local Japanese', lang: 'ja-JP', localService: true, default: true, voiceURI: 'local-ja' },
        { name: 'Local Chinese', lang: 'zh-CN', localService: true, default: false, voiceURI: 'local-zh' },
      ],
      speak: (utterance: LocalUtterance) => { state.local.push(utterance); },
      cancel: () => { state.canceled++; },
      pause: () => { state.systemPauses++; },
      resume: () => { state.systemResumes++; },
    });
    Object.defineProperty(window, 'speechSynthesis', { configurable: true, value: synthesis });
    const originalFetch = window.fetch.bind(window);
    window.fetch = (input, init) => {
      const path = new URL(input instanceof Request ? input.url : String(input), location.href).pathname;
      if (!path.startsWith('/api/voice/')) return originalFetch(input, init);
      const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
      const entry = { path, aborted: signal?.aborted ?? false, settled: false };
      state.requests.push(entry);
      signal?.addEventListener('abort', () => { entry.aborted = true; }, { once: true });
      return originalFetch(input, init).finally(() => { entry.settled = true; });
    };
    const createURL = URL.createObjectURL.bind(URL);
    const revokeURL = URL.revokeObjectURL.bind(URL);
    URL.createObjectURL = blob => { state.blobTypes.push(blob instanceof Blob ? blob.type : 'media-source'); return createURL(blob); };
    URL.revokeObjectURL = url => { state.revoked.push(url); revokeURL(url); };
  });
  await context.route('**/*', async route => {
    if (new URL(route.request().url()).origin !== origin) {
      externalRequests.push(route.request().url());
      await route.abort('blockedbyclient');
    } else await route.fallback();
  });
  const page = await context.newPage();
  page.setDefaultTimeout(5000);
  const pageErrors: string[] = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.route('**/__voice-test', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body><div id="root"></div><script type="module" src="/__voice-harness.tsx"></script></body></html>' }));
  await page.route('**/api/voice/settings', async route => {
    settingsRequests.push(route.request().method());
    if (options.settings) await options.settings(route);
    else await route.fulfill({ json: { ...cloudSettings, provider: options.provider ?? 'minimax', speed: options.speed ?? 1 } });
  });
  await page.route('**/api/voice/synthesize', async route => {
    requests.push(route.request().postDataJSON());
    expect(route.request().method()).toBe('POST');
    if (options.synthesize) await options.synthesize(route);
    else await fulfillAudio(route);
  });
  try {
    await page.goto(`${origin}/__voice-test`);
    await page.getByRole('button', { name: 'Sequence', exact: true }).waitFor();
  } catch (error) {
    await context.close();
    throw new Error(`Voice harness did not load: ${pageErrors.join('; ') || 'no browser errors'}`, { cause: error });
  }
  return { page, context, requests, settingsRequests, externalRequests };
}

const clips = (page: Page) => page.evaluate(() => window.__voiceMock.clips.map(({ src, plays, pauses, paused }) => ({ src, plays, pauses, paused })));
const local = (page: Page) => page.evaluate(() => window.__voiceMock.local.map(({ text, lang, rate, voice }) => ({ text, lang, rate, localService: voice?.localService })));
const finish = (page: Page, index: number) => page.evaluate(index => window.__voiceMock.clips[index]!.finish(), index);
const state = (page: Page) => page.getByLabel('Playback').textContent();
// Allow promise continuations and React's queued work to run. MessageChannel
// stays event driven even if a concurrent browser makes this page backgrounded;
// animation frames can pause in that situation.
const drain = (page: Page) => page.evaluate(async () => {
  for (let turn = 0; turn < 2; turn++) {
    await new Promise<void>(resolve => {
      const channel = new MessageChannel();
      channel.port1.onmessage = () => { channel.port1.close(); channel.port2.close(); resolve(); };
      channel.port2.postMessage(null);
    });
  }
});

describe('voice playback in the browser', () => {
  it('stops an unmounted source without letting inactive or superseded controller cleanup stop current audio', async () => {
    const { page, context, requests } = await pageFor();
    try {
      await page.getByRole('button', { name: 'Sequence', exact: true }).click();
      await expect.poll(() => page.getByLabel('Phase').textContent()).toBe('playing');
      await page.getByRole('button', { name: 'Hide replacement', exact: true }).click();
      expect(await page.getByLabel('Source').textContent()).toBe('sequence');
      expect(await page.getByLabel('Phase').textContent()).toBe('playing');
      expect((await clips(page))[0]!.paused).toBe(false);
      await page.getByRole('button', { name: 'Switch and hide', exact: true }).click();
      await expect.poll(() => page.getByLabel('Phase').textContent()).toBe('playing');
      expect(await page.getByLabel('Source').textContent()).toBe('recording');
      expect(await page.getByTestId('sequence').count()).toBe(0);
      expect((await clips(page))[1]!.paused).toBe(false);
      await page.getByRole('button', { name: 'Hide recording', exact: true }).click();
      expect(await page.getByLabel('Source').textContent()).toBe('');
      expect(await page.getByLabel('Phase').textContent()).toBe('idle');
      expect((await clips(page))[1]!.paused).toBe(true);
      await finish(page, 0);
      await drain(page);
      expect(requests).toHaveLength(1);
    } finally { await context.close(); }
  });

  it.each([false, true])('cleans up a changed controller source while preserving newer playback: %s', async switchPlayback => {
    const { page, context } = await pageFor();
    try {
      await page.getByRole('button', { name: 'Sequence', exact: true }).click();
      await expect.poll(() => page.getByLabel('Phase').textContent()).toBe('playing');
      await page.getByRole('button', { name: switchPlayback ? 'Switch and retarget' : 'Retarget controller', exact: true }).click();
      expect(await page.getByLabel('Source').textContent()).toBe(switchPlayback ? 'retargeted' : '');
      expect(await page.getByLabel('Phase').textContent()).toBe(switchPlayback ? 'playing' : 'idle');
      expect(await page.getByTestId('sequence').getByRole('region').count()).toBe(switchPlayback ? 1 : 0);
      expect((await clips(page))[0]!.paused).toBe(true);
      expect((await local(page)).map(utterance => utterance.text)).toEqual(switchPlayback ? ['新的朗读'] : []);
    } finally { await context.close(); }
  });

  it('aborts pending playback when its controller disappears and ignores the late response', async () => {
    const held = deferred(); const release = deferred();
    const { page, context, requests } = await pageFor({ synthesize: async route => {
      held.resolve(); await release.promise;
      try { await fulfillAudio(route); } catch { /* Aborted requests may already be discarded. */ }
    } });
    try {
      await page.getByRole('button', { name: 'Sequence', exact: true }).click();
      await held.promise;
      await page.getByRole('button', { name: 'Hide sequence', exact: true }).click();
      await expect.poll(() => page.evaluate(() => window.__voiceMock.requests.some(request => request.path === '/api/voice/synthesize' && request.aborted))).toBe(true);
      release.resolve(); await drain(page);
      expect(await page.getByLabel('Source').textContent()).toBe('');
      expect(await page.getByLabel('Phase').textContent()).toBe('idle');
      expect(await clips(page)).toEqual([]);
      expect(requests).toHaveLength(1);
      expect(await page.getByRole('alert').textContent()).toBe('');
    } finally { release.resolve(); await context.close(); }
  });

  it('moves inline controls to the current source and keeps them available for completed playback and replay', async () => {
    const { page, context, requests, settingsRequests } = await pageFor();
    try {
      const allControls = page.getByRole('region', { name: '音频控制' });
      expect(await allControls.count()).toBe(0);
      await page.getByRole('button', { name: 'Replay', exact: true }).click();
      await expect.poll(() => page.getByLabel('Phase').textContent()).toBe('playing');
      expect(await page.getByTestId('replacement').getByRole('region').count()).toBe(1);
      expect(await page.getByTestId('legacy-mock').getByRole('region').count()).toBe(0);

      await page.getByRole('button', { name: 'URL', exact: true }).click();
      await expect.poll(() => page.getByLabel('Phase').textContent()).toBe('playing');
      const controls = page.getByTestId('recording').getByRole('region', { name: '音频控制' });
      expect(await page.getByLabel('Source').textContent()).toBe('recording');
      expect(await page.getByTestId('replacement').getByRole('region').count()).toBe(0);
      expect(await allControls.count()).toBe(1);
      await finish(page, 0);
      await drain(page);
      expect(await page.getByLabel('Source').textContent()).toBe('recording');
      expect(await page.getByLabel('Phase').textContent()).toBe('playing');

      await page.evaluate(() => { window.__voiceMock.clips[1]!.currentTime = 6; });
      await controls.getByRole('button', { name: '从头播放', exact: true }).click();
      expect(await page.evaluate(() => window.__voiceMock.clips[1]!.currentTime)).toBe(0);
      expect(await page.getByLabel('Source').textContent()).toBe('recording');
      await finish(page, 1);
      await expect.poll(() => page.getByLabel('Phase').textContent()).toBe('idle');
      expect(await controls.getByRole('status').textContent()).toContain('播放结束');
      await controls.getByRole('button', { name: '从头播放', exact: true }).click();
      await expect.poll(async () => (await clips(page))[2]?.plays).toBe(1);
      expect(await page.getByLabel('Source').textContent()).toBe('recording');
      expect(requests).toHaveLength(1);
      expect(settingsRequests).toEqual(['GET']);

      await controls.getByRole('button', { name: '停止', exact: true }).click();
      expect(await page.getByLabel('Source').textContent()).toBe('');
      expect(await page.getByLabel('Phase').textContent()).toBe('idle');
      expect(await allControls.count()).toBe(0);
    } finally { await context.close(); }
  });

  it('routes automatic replies to their source and rejects stale replies after a switch or stop', async () => {
    const { page, context, requests, settingsRequests } = await pageFor();
    try {
      await page.getByRole('button', { name: 'Automatic', exact: true }).click();
      expect(await page.getByLabel('Source').textContent()).toBe('automatic');
      expect(await page.getByTestId('automatic').getByRole('region').count()).toBe(1);
      await page.getByRole('button', { name: 'Stale after switch', exact: true }).click();
      await drain(page);
      expect(await page.getByLabel('Source').textContent()).toBe('chinese');
      expect(await page.getByTestId('automatic').getByRole('region').count()).toBe(0);
      expect(await page.getByTestId('chinese').getByRole('region').count()).toBe(1);
      expect((await local(page)).map(utterance => utterance.text)).toEqual(['自动回复', '新的朗读']);
      await page.getByRole('button', { name: 'Stale auto', exact: true }).click();
      await drain(page);
      expect(await page.getByLabel('Source').textContent()).toBe('');
      expect(await page.getByRole('region', { name: '音频控制' }).count()).toBe(0);
      expect((await local(page)).map(utterance => utterance.text)).toEqual(['自动回复', '新的朗读']);
      expect(requests).toEqual([]);
      expect(settingsRequests).toEqual([]);
    } finally { await context.close(); }
  });

  it('preserves the speech source when replaying completed speech and supports calls without a source', async () => {
    const { page, context } = await pageFor();
    try {
      await page.getByRole('button', { name: 'Chinese', exact: true }).click();
      await page.evaluate(() => window.__voiceMock.local[0]!.onend?.(new Event('end')));
      await expect.poll(() => page.getByLabel('Phase').textContent()).toBe('idle');
      await page.getByTestId('chinese').getByRole('button', { name: '从头播放', exact: true }).click();
      expect(await page.getByLabel('Source').textContent()).toBe('chinese');
      expect(await local(page)).toHaveLength(2);
      await page.getByRole('button', { name: 'Legacy', exact: true }).click();
      expect(await page.getByLabel('Phase').textContent()).toBe('playing');
      expect(await page.getByLabel('Source').textContent()).toBe('');
      expect(await page.getByRole('region', { name: '音频控制' }).count()).toBe(0);
      expect(await local(page)).toHaveLength(3);
    } finally { await context.close(); }
  });

  it('pauses while a clip is loading and resumes that same clip before advancing the queue', async () => {
    const held = deferred(); const release = deferred();
    const { page, context, requests } = await pageFor({ synthesize: async route => { held.resolve(); await release.promise; await fulfillAudio(route); } });
    try {
      await page.getByRole('button', { name: 'Sequence', exact: true }).click();
      await held.promise;
      const controls = page.getByTestId('sequence').getByRole('region', { name: '音频控制' });
      expect(await page.getByLabel('Source').textContent()).toBe('sequence');
      expect(await page.getByRole('region', { name: '音频控制' }).count()).toBe(1);
      expect(await controls.getByRole('status').textContent()).toContain('正在准备');
      await controls.getByRole('button', { name: '暂停', exact: true }).click();
      release.resolve();
      await expect.poll(async () => (await clips(page)).length).toBe(1);
      expect((await clips(page))[0]!.plays).toBe(0);
      expect(await page.getByLabel('Phase').textContent()).toBe('paused');
      await controls.getByRole('button', { name: '继续播放', exact: true }).click();
      await expect.poll(async () => (await clips(page))[0]!.plays).toBe(1);
      await page.evaluate(() => { window.__voiceMock.clips[0]!.currentTime = 1.25; });
      await page.getByRole('button', { name: 'Pause', exact: true }).click();
      await page.getByRole('button', { name: 'Resume', exact: true }).click();
      expect(await page.getByLabel('Source').textContent()).toBe('sequence');
      expect(await page.evaluate(() => window.__voiceMock.clips[0]!.currentTime)).toBe(1.25);
      expect(requests).toHaveLength(1);
      await finish(page, 0);
      await expect.poll(async () => (await clips(page))[1]?.plays).toBe(1);
      expect(requests).toHaveLength(2);
    } finally { release.resolve(); await context.close(); }
  });

  it('retains an autoplay-blocked clip and retries playback without synthesis or system fallback', async () => {
    const { page, context, requests } = await pageFor();
    try {
      await page.evaluate(() => { window.__voiceMock.blockNext = true; });
      await page.getByRole('button', { name: 'Replay', exact: true }).click();
      await expect.poll(() => page.getByLabel('Phase').textContent()).toBe('blocked');
      const url = (await clips(page))[0]!.src;
      expect(await page.evaluate(() => window.__voiceMock.revoked)).not.toContain(url);
      expect(await local(page)).toEqual([]);
      expect(await page.getByRole('alert').textContent()).toBe('');
      await page.getByRole('button', { name: 'Resume', exact: true }).click();
      await expect.poll(() => page.getByLabel('Phase').textContent()).toBe('playing');
      expect((await clips(page))[0]).toMatchObject({ src: url, plays: 2 });
      expect(requests).toHaveLength(1);
    } finally { await context.close(); }
  });

  it('plays a direct media URL, pauses at its position, and releases it when recording starts', async () => {
    const { page, context, requests, settingsRequests } = await pageFor();
    try {
      await page.getByRole('button', { name: 'URL', exact: true }).click();
      await expect.poll(() => page.getByLabel('Phase').textContent()).toBe('playing');
      await page.evaluate(() => { window.__voiceMock.clips[0]!.currentTime = 6; });
      await page.getByRole('button', { name: 'Pause', exact: true }).click();
      await page.getByRole('button', { name: 'Resume', exact: true }).click();
      expect(await page.evaluate(() => window.__voiceMock.clips[0]!.currentTime)).toBe(6);
      await page.getByRole('button', { name: 'Restart', exact: true }).click();
      expect(await page.evaluate(() => window.__voiceMock.clips[0]!.currentTime)).toBe(0);
      await page.evaluate(() => window.dispatchEvent(new Event('nihongo-recording-start')));
      await expect.poll(() => page.getByLabel('Phase').textContent()).toBe('idle');
      expect((await clips(page))[0]!.paused).toBe(true);
      expect(await page.evaluate(() => window.__voiceMock.revoked)).toEqual([]);
      expect(requests).toEqual([]); expect(settingsRequests).toEqual([]);
    } finally { await context.close(); }
  });

  it('pauses/resumes system speech and does not let stale automatic speech override a manual stop', async () => {
    const { page, context, requests } = await pageFor();
    try {
      await page.getByRole('button', { name: 'Chinese', exact: true }).click();
      await page.getByRole('button', { name: 'Pause', exact: true }).click();
      expect(await page.getByLabel('Phase').textContent()).toBe('paused');
      expect(await page.evaluate(() => window.__voiceMock.systemPauses)).toBe(1);
      await page.getByRole('button', { name: 'Resume', exact: true }).click();
      expect(await page.getByLabel('Phase').textContent()).toBe('playing');
      expect(await page.evaluate(() => window.__voiceMock.systemResumes)).toBeGreaterThan(0);
      await page.getByRole('button', { name: 'Stale auto', exact: true }).click();
      await drain(page);
      expect(await page.getByLabel('Phase').textContent()).toBe('idle');
      expect(requests).toEqual([]);
    } finally { await context.close(); }
  });

  it('plays cloud WAVs sequentially, alternates speakers, and sends the requested slow rate', async () => {
    const { page, context, requests, settingsRequests, externalRequests } = await pageFor();
    try {
      await page.getByRole('button', { name: 'Sequence', exact: true }).click();
      for (let index = 0; index < lines.length; index++) {
        await expect.poll(async () => (await clips(page)).filter(clip => clip.plays === 1).length).toBe(index + 1);
        await drain(page);
        expect(requests).toEqual(lines.slice(0, index + 1).map((text, position) => ({ text, rate: .65, speaker: position % 2 ? 'secondary' : 'primary' })));
        expect((await clips(page)).filter(clip => !clip.paused)).toHaveLength(1);
        expect(await state(page)).toBe('playing');
        await finish(page, index);
      }
      await expect.poll(() => state(page)).toBe('idle');
      expect(settingsRequests).toEqual(['GET']);
      expect(await local(page)).toEqual([]);
      expect(await page.evaluate(() => window.__voiceMock.blobTypes)).toEqual(['audio/wav', 'audio/wav', 'audio/wav']);
      expect(await page.getByRole('alert').textContent()).toBe('');
      expect(externalRequests).toEqual([]);
    } finally { await context.close(); }
  });

  it.each(['settings', 'synthesis'] as const)('aborts pending %s on stop and never starts a late clip or next line', async pending => {
    const release = deferred();
    const requestHeld = deferred();
    const responseHandled = deferred();
    const held = async (route: Route) => {
      requestHeld.resolve();
      await release.promise;
      try {
        if (pending === 'settings') await route.fulfill({ json: cloudSettings });
        else await fulfillAudio(route);
      } catch { /* The browser can discard the intercepted request after abort. */ }
      finally { responseHandled.resolve(); }
    };
    const { page, context, requests } = await pageFor(pending === 'settings' ? { settings: held } : { synthesize: held });
    const path = pending === 'settings' ? '/api/voice/settings' : '/api/voice/synthesize';
    try {
      await page.getByRole('button', { name: 'Sequence', exact: true }).click();
      await requestHeld.promise;
      await expect.poll(() => page.evaluate(path => window.__voiceMock.requests.some(request => request.path === path && !request.settled), path)).toBe(true);
      await page.getByRole('button', { name: 'Stop', exact: true }).click();
      await expect.poll(() => page.evaluate(path => window.__voiceMock.requests.some(request => request.path === path && request.aborted && request.settled), path)).toBe(true);
      release.resolve();
      await responseHandled.promise;
      await drain(page);
      expect(await state(page)).toBe('idle');
      expect(await clips(page)).toEqual([]);
      expect(await local(page)).toEqual([]);
      expect(requests).toHaveLength(pending === 'settings' ? 0 : 1);
      expect(await page.getByRole('alert').textContent()).toBe('');
    } finally { release.resolve(); await context.close(); }
  });

  it('stops an active clip and ignores its late ended event', async () => {
    const { page, context, requests } = await pageFor();
    try {
      await page.getByRole('button', { name: 'Sequence', exact: true }).click();
      await expect.poll(async () => (await clips(page))[0]?.plays).toBe(1);
      const url = (await clips(page))[0]!.src;
      await page.getByRole('button', { name: 'Stop', exact: true }).click();
      expect((await clips(page))[0]).toMatchObject({ paused: true, pauses: 1 });
      expect(await page.evaluate(() => window.__voiceMock.revoked)).toContain(url);
      await finish(page, 0);
      await drain(page);
      expect(requests).toHaveLength(1);
      expect(await state(page)).toBe('idle');
      expect(await local(page)).toEqual([]);
    } finally { await context.close(); }
  });

  it('replay cancels the previous sequence and stale completion cannot stop the new clip', async () => {
    const { page, context, requests } = await pageFor();
    try {
      await page.getByRole('button', { name: 'Sequence', exact: true }).click();
      await expect.poll(async () => (await clips(page))[0]?.plays).toBe(1);
      await page.getByRole('button', { name: 'Replay', exact: true }).click();
      await expect.poll(async () => (await clips(page))[1]?.plays).toBe(1);
      expect((await clips(page))[0]).toMatchObject({ paused: true, pauses: 1 });
      await finish(page, 0);
      await drain(page);
      expect(requests.map(request => request.text)).toEqual([lines[0], replacement]);
      expect((await clips(page))[1]!.paused).toBe(false);
      expect(await state(page)).toBe('playing');
      await finish(page, 1);
      await expect.poll(() => state(page)).toBe('idle');
      expect(await page.getByRole('alert').textContent()).toBe('');
    } finally { await context.close(); }
  });

  it('uses only a local Chinese voice without requesting voice settings or synthesis', async () => {
    const { page, context, requests, settingsRequests } = await pageFor();
    try {
      await page.getByRole('button', { name: 'Chinese', exact: true }).click();
      await expect.poll(() => local(page)).toEqual([{ text: '请再说一遍。', lang: 'zh-CN', rate: .8, localService: true }]);
      expect(settingsRequests).toEqual([]);
      expect(requests).toEqual([]);
      expect(await clips(page)).toEqual([]);
      await page.evaluate(() => window.__voiceMock.local[0]!.onend?.(new Event('end')));
      await expect.poll(() => state(page)).toBe('idle');
    } finally { await context.close(); }
  });

  it('uses the configured system voice and speed without a synthesis request', async () => {
    const { page, context, requests } = await pageFor({ provider: 'system', speed: .8 });
    try {
      await page.getByRole('button', { name: 'Replay', exact: true }).click();
      await expect.poll(() => local(page)).toEqual([{ text: replacement, lang: 'ja-JP', rate: .8, localService: true }]);
      expect(requests).toEqual([]);
      expect(await clips(page)).toEqual([]);
      expect(await page.getByRole('alert').textContent()).toBe('');
      await page.getByRole('button', { name: 'Stop', exact: true }).click();
      expect(await state(page)).toBe('idle');
      expect(await page.evaluate(() => window.__voiceMock.canceled)).toBeGreaterThan(0);
    } finally { await context.close(); }
  });

  it('reports cloud failure in Chinese and explicitly falls back to the local Japanese voice', async () => {
    const { page, context, requests } = await pageFor({ speed: .8, synthesize: route => route.fulfill({ status: 503, json: { error: '云端语音暂时不可用。' } }) });
    try {
      await page.getByRole('button', { name: 'Replay', exact: true }).click();
      await expect.poll(() => local(page)).toEqual([{ text: replacement, lang: 'ja-JP', rate: .8, localService: true }]);
      const notice = await page.getByRole('alert').textContent();
      expect(notice).toMatch(/[\u4e00-\u9fff]/);
      expect(notice).toMatch(/云端|MiniMax/i);
      expect(notice).toMatch(/系统|本机|本地/);
      expect(requests).toHaveLength(1);
      expect(await clips(page)).toEqual([]);
      expect(await state(page)).toBe('playing');
      await page.evaluate(() => window.__voiceMock.local[0]!.onend?.(new Event('end')));
      await expect.poll(() => state(page)).toBe('idle');
    } finally { await context.close(); }
  });
});
