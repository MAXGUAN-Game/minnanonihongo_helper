import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { createServer, type ViteDevServer } from 'vite';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

// Exercise the real playback hook and controls with deterministic local audio.
// No actual voice provider, microphone, or remote media is contacted.
let vite: ViteDevServer;
let browser: Browser;
let origin: string;
let cacheDir: string;
type ShortcutClip = {
  src: string; currentTime: number; duration: number; paused: boolean; plays: number;
  metadata: (duration?: number) => void; finish: () => void; fire: (name: string) => void;
};
type ShortcutMock = { clips: ShortcutClip[]; metadataReady: boolean; systemPauses: number; systemResumes: number };
declare global { interface Window { __shortcutMock: ShortcutMock } }

const harness = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { useSpeech } from '/src/client/speech.ts';
import { AudioControls } from '/src/client/AudioControls.tsx';
import '/src/client/style.css';
function Harness() {
  const [notice,setNotice]=React.useState('');
  const [micClicks,setMicClicks]=React.useState(0);
  const speech=useSpeech(setNotice);
  const legacy=new URLSearchParams(location.search).has('legacy');
  return <main style={{padding:20,maxWidth:520}}>
    <h1>音频快捷键</h1>
    <button data-audio-source="audio" onClick={()=>speech.playUrl('/sample.mp3','教材原声','audio')}><span>Direct audio</span></button>
    <button data-audio-source="system" onClick={()=>speech.say('请再说一遍。','zh-CN',1,'system')}>System speech</button>
    <button onClick={speech.stop}>Stop playback</button>
    <div data-testid="audio"><AudioControls speech={speech} sourceId="audio"/></div>
    <div data-testid="system"><AudioControls speech={speech} sourceId="system"/></div>
    {legacy&&<div data-testid="legacy"><AudioControls sourceId="legacy" speech={{...speech,sourceId:'legacy',label:'旧版播放器',canSeek:undefined,seekBy:undefined,seekUnavailableReason:undefined}}/></div>}
    <output aria-label="Phase">{speech.status}</output>
    <output aria-label="Source">{speech.sourceId}</output>
    <p role="alert">{notice}</p>
    <div id="neutral" tabIndex={0}>阅读区域</div>
    <label>输入框<input id="input"/></label>
    <label>多行输入<textarea id="textarea"/></label>
    <label>选择<select id="select"><option>第一项</option><option>第二项</option></select></label>
    <div id="editable" contentEditable suppressContentEditableWarning role="textbox" aria-label="可编辑内容"><span id="editable-child">编辑内容</span></div>
    <button id="native-button">普通按钮</button>
    <a id="native-link" href="#neutral">普通链接</a>
    <details><summary id="native-summary">查看说明</summary><p>说明内容</p></details>
    <div id="role-button" role="button" tabIndex={0}><span>自定义按钮</span></div>
    <button id="mic" onClick={()=>setMicClicks(value=>value+1)}>麦克风</button>
    <output aria-label="Microphone clicks">{micClicks}</output>
    <div style={{height:1400}}/>
  </main>;
}
createRoot(document.getElementById('root')).render(<Harness/>);
`;

beforeAll(async () => {
  cacheDir = await mkdtemp(join(tmpdir(), 'language-master-audio-shortcuts-'));
  vite = await createServer({ configFile: false, root: process.cwd(), cacheDir,
    optimizeDeps: { include: ['react', 'react-dom/client', 'react/jsx-runtime', 'react/jsx-dev-runtime', 'lucide-react'], noDiscovery: true },
    server: { host: '127.0.0.1', port: 0 }, plugins: [{ name: 'isolated-audio-shortcuts',
      resolveId(id) { if (id === '/__audio-shortcuts.tsx') return id; },
      load(id) { if (id === '/__audio-shortcuts.tsx') return harness; },
    }] });
  await vite.listen();
  const address = vite.httpServer!.address();
  if (!address || typeof address === 'string') throw new Error('Missing test server port');
  origin = `http://127.0.0.1:${address.port}`;
  browser = await chromium.launch({ headless: true, ...(process.platform === 'win32' ? { channel: 'msedge' } : {}) });
}, 30000);

afterAll(async () => {
  await browser?.close(); await vite?.close();
  if (cacheDir && dirname(resolve(cacheDir)) === resolve(tmpdir()) && basename(cacheDir).startsWith('language-master-audio-shortcuts-')) {
    await rm(cacheDir, { recursive: true, force: true });
  }
});

async function setup(options: { metadataReady?: boolean; legacy?: boolean } = {}): Promise<{ page: Page; context: BrowserContext }> {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await context.addInitScript(({ metadataReady }) => {
    const state: ShortcutMock = { clips: [], metadataReady, systemPauses: 0, systemResumes: 0 };
    window.__shortcutMock = state;
    class ControlledAudio extends EventTarget {
      src: string;
      paused = true;
      plays = 0;
      ended = false;
      duration = state.metadataReady ? 12 : Number.NaN;
      readyState = state.metadataReady ? 4 : 0;
      networkState = 1;
      playbackRate = 1;
      preload = '';
      private position = 0;
      onended: ((event: Event) => void) | null = null;
      onerror: ((event: Event) => void) | null = null;
      onloadedmetadata: ((event: Event) => void) | null = null;
      ondurationchange: ((event: Event) => void) | null = null;
      ontimeupdate: ((event: Event) => void) | null = null;
      constructor(src = '') {
        super(); this.src = src; state.clips.push(this);
        if (state.metadataReady) queueMicrotask(() => this.metadata());
      }
      get currentTime() { return this.position; }
      set currentTime(value: number) { this.position = value; this.ended = false; this.fire('timeupdate'); }
      get seekable() { return { length: this.readyState ? 1 : 0, start: () => 0, end: () => this.duration }; }
      get buffered() { return this.seekable; }
      play() { this.plays++; this.paused = false; this.ended = false; this.fire('playing'); return Promise.resolve(); }
      pause() { this.paused = true; this.fire('pause'); }
      load() {}
      removeAttribute(name: string) { if (name === 'src') this.src = ''; }
      metadata(duration = 12) { this.duration = duration; this.readyState = 4; this.fire('loadedmetadata'); this.fire('durationchange'); this.fire('progress'); }
      fire(name: string) {
        const event = new Event(name); this.dispatchEvent(event);
        const callback = (this as unknown as Record<string, unknown>)[`on${name}`];
        if (typeof callback === 'function') callback.call(this, event);
      }
      finish() { this.ended = true; this.paused = true; this.position = this.duration; this.fire('ended'); }
    }
    Object.defineProperty(window, 'Audio', { configurable: true, value: ControlledAudio });
    class ControlledUtterance extends EventTarget { constructor(public text: string) { super(); } }
    Object.defineProperty(window, 'SpeechSynthesisUtterance', { configurable: true, value: ControlledUtterance });
    const synthesis = new EventTarget();
    Object.assign(synthesis, {
      getVoices: () => [{ name: 'Local Chinese', lang: 'zh-CN', localService: true, default: true, voiceURI: 'local-zh' }],
      speak() {}, cancel() {},
      pause() { state.systemPauses++; }, resume() { state.systemResumes++; },
    });
    Object.defineProperty(window, 'speechSynthesis', { configurable: true, value: synthesis });
  }, { metadataReady: options.metadataReady ?? true });
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin !== origin || url.pathname.startsWith('/api/')) await route.abort('blockedbyclient');
    else await route.fallback();
  });
  const page = await context.newPage(); page.setDefaultTimeout(5000);
  await page.route('**/__audio-shortcuts-test*', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html lang="zh-CN"><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>音频测试</title></head><body><div id="root"></div><script type="module" src="/__audio-shortcuts.tsx"></script></body></html>' }));
  await page.goto(`${origin}/__audio-shortcuts-test${options.legacy ? '?legacy=1' : ''}`);
  await page.getByRole('button', { name: 'Direct audio', exact: true }).waitFor();
  return { page, context };
}

const phase = (page: Page) => page.getByLabel('Phase', { exact: true }).textContent();
const position = (page: Page) => page.evaluate(() => window.__shortcutMock.clips.at(-1)!.currentTime);
const startAudio = async (page: Page) => {
  await page.getByRole('button', { name: 'Direct audio', exact: true }).click();
  await expect.poll(() => phase(page)).toBe('playing');
};
type SpaceOptions = Pick<KeyboardEventInit, 'repeat' | 'isComposing' | 'keyCode' | 'ctrlKey' | 'altKey' | 'metaKey' | 'shiftKey'>;
const dispatchSpace = (page: Page, selector = '#neutral', init: SpaceOptions = {}) => page.evaluate(({ selector, init }) => {
  const target = document.querySelector(selector)!;
  const event = new KeyboardEvent('keydown', { key: ' ', code: 'Space', bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  target.dispatchEvent(new KeyboardEvent('keyup', { key: ' ', code: 'Space', bubbles: true, cancelable: true, ...init }));
  return event.defaultPrevented;
}, { selector, init });

describe('audio seeking and keyboard controls', () => {
  it('seeks by two seconds, clamps to the clip bounds, and preserves paused or playing status', async () => {
    const { page, context } = await setup();
    try {
      await startAudio(page);
      const controls = page.getByTestId('audio');
      const backward = controls.getByRole('button', { name: '快退 2 秒', exact: true });
      const forward = controls.getByRole('button', { name: '快进 2 秒', exact: true });
      await expect.poll(() => forward.isEnabled()).toBe(true);
      await page.evaluate(() => { window.__shortcutMock.clips.at(-1)!.currentTime = 5; });
      await mkdir(resolve('test-results'), { recursive: true });
      await controls.locator('.audio-controls').screenshot({ path: resolve('test-results/audio-controls-seek-mobile.png') });
      await page.setViewportSize({ width: 1100, height: 844 });
      await controls.locator('.audio-controls').screenshot({ path: resolve('test-results/audio-controls-seek-desktop.png') });
      await page.setViewportSize({ width: 390, height: 844 });
      await backward.click(); expect(await position(page)).toBe(3);
      expect(await phase(page)).toBe('playing');
      await forward.click(); expect(await position(page)).toBe(5);
      await controls.getByRole('button', { name: '暂停', exact: true }).click();
      await forward.click(); expect(await position(page)).toBe(7);
      expect(await phase(page)).toBe('paused');
      expect(await page.evaluate(() => window.__shortcutMock.clips.at(-1)!.paused)).toBe(true);
      await page.evaluate(() => { window.__shortcutMock.clips.at(-1)!.currentTime = .5; });
      await backward.click(); expect(await position(page)).toBe(0);
      await page.evaluate(() => { window.__shortcutMock.clips.at(-1)!.currentTime = 11; });
      await forward.click(); expect(await position(page)).toBe(12);
      expect(await phase(page)).toBe('paused');
      expect(await page.getByRole('timer', { name: '播放进度' }).textContent()).toBe('0:12 / 0:12');
      expect(await controls.locator('.audio-controls').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    } finally { await context.close(); }
  });

  it('explains unavailable seeking until metadata arrives and for system speech', async () => {
    const { page, context } = await setup({ metadataReady: false });
    try {
      await page.getByRole('button', { name: 'Direct audio', exact: true }).click();
      await expect.poll(() => phase(page)).toBe('buffering');
      const forward = page.getByTestId('audio').getByRole('button', { name: '快进 2 秒', exact: true });
      expect(await forward.isDisabled()).toBe(true);
      const reasonId = await forward.getAttribute('aria-describedby');
      expect(reasonId).toBeTruthy();
      expect(await page.evaluate(id => document.getElementById(id!)?.textContent, reasonId)).toBeTruthy();
      await page.evaluate(() => window.__shortcutMock.clips.at(-1)!.metadata());
      await expect.poll(() => forward.isEnabled()).toBe(true);
      expect(await forward.getAttribute('aria-describedby')).toBeNull();
      await page.getByRole('button', { name: 'System speech', exact: true }).click();
      const system = page.getByTestId('system');
      expect(await system.getByRole('button', { name: '快退 2 秒', exact: true }).isDisabled()).toBe(true);
      expect(await system.getByRole('button', { name: '快进 2 秒', exact: true }).isDisabled()).toBe(true);
      expect(await system.locator('.audio-seek-note').textContent()).toMatch(/系统|本机/);
      expect(await page.getByTestId('audio').getByRole('region').count()).toBe(0);
    } finally { await context.close(); }
  });

  it('keeps legacy speech mocks usable with disabled seeking and an accessible explanation', async () => {
    const { page, context } = await setup({ legacy: true });
    try {
      const legacy = page.getByTestId('legacy');
      expect(await legacy.getByRole('button', { name: '快退 2 秒', exact: true }).isDisabled()).toBe(true);
      expect(await legacy.getByRole('button', { name: '快进 2 秒', exact: true }).isDisabled()).toBe(true);
      expect(await legacy.locator('.audio-seek-note').textContent()).toBe('当前音频暂不支持快退或快进。');
    } finally { await context.close(); }
  });

  it('uses Space to pause, resume, and replay completed audio while preventing page scrolling', async () => {
    const { page, context } = await setup();
    try {
      expect(await dispatchSpace(page)).toBe(false);
      await startAudio(page);
      await page.locator('#neutral').focus();
      const initialScroll = await page.evaluate(() => window.scrollY);
      await page.keyboard.press('Space');
      expect(await phase(page)).toBe('paused');
      expect(await page.evaluate(() => window.scrollY)).toBe(initialScroll);
      expect(await dispatchSpace(page)).toBe(true);
      await expect.poll(() => phase(page)).toBe('playing');
      await page.evaluate(() => window.__shortcutMock.clips.at(-1)!.finish());
      await expect.poll(() => phase(page)).toBe('idle');
      expect(await dispatchSpace(page)).toBe(true);
      await expect.poll(() => phase(page)).toBe('playing');
      expect(await position(page)).toBe(0);
      await page.getByRole('button', { name: 'Stop playback', exact: true }).click();
      expect(await dispatchSpace(page)).toBe(false);
      expect(await phase(page)).toBe('idle');
    } finally { await context.close(); }
  });

  it('does not repeat-toggle held Space, act during IME composition, or consume modified Space', async () => {
    const { page, context } = await setup();
    try {
      await startAudio(page);
      for (const init of [{ repeat: true }, { isComposing: true }, { keyCode: 229 }, { ctrlKey: true }, { altKey: true }, { metaKey: true }, { shiftKey: true }]) {
        await dispatchSpace(page, '#neutral', init);
        expect(await phase(page)).toBe('playing');
      }
      await page.locator('#neutral').focus();
      await page.keyboard.down('Space');
      expect(await phase(page)).toBe('paused');
      await page.keyboard.down('Space');
      expect(await phase(page)).toBe('paused');
      await page.keyboard.up('Space');
    } finally { await context.close(); }
  });

  it('leaves input and native interactive Space behavior alone, including the microphone', async () => {
    const { page, context } = await setup();
    try {
      await startAudio(page);
      for (const selector of ['#input', '#textarea', '#select', '#editable', '#editable-child', '#native-button', '#native-link', '#native-summary', '#role-button', '#role-button span', '#mic']) {
        expect(await dispatchSpace(page, selector)).toBe(false);
        expect(await phase(page)).toBe('playing');
      }
      await page.locator('#input').focus();
      await page.keyboard.press('Space');
      expect(await page.locator('#input').inputValue()).toBe(' ');
      await page.locator('#native-summary').focus();
      await page.keyboard.press('Space');
      expect(await page.locator('details').getAttribute('open')).not.toBeNull();
      await page.locator('#mic').focus();
      await page.keyboard.press('Space');
      expect(await page.getByLabel('Microphone clicks').textContent()).toBe('1');
      expect(await phase(page)).toBe('playing');
    } finally { await context.close(); }
  });

  it('toggles once with Space on playback controls without triggering a seek or losing primary-button focus', async () => {
    const { page, context } = await setup();
    try {
      await startAudio(page);
      const controls = page.getByTestId('audio');
      await page.evaluate(() => { window.__shortcutMock.clips.at(-1)!.currentTime = 5; });
      const forward = controls.getByRole('button', { name: '快进 2 秒', exact: true });
      await expect.poll(() => forward.isEnabled()).toBe(true);
      await forward.focus(); await page.keyboard.press('Space');
      expect(await phase(page)).toBe('paused');
      expect(await position(page)).toBe(5);
      await forward.press('Space');
      await expect.poll(() => phase(page)).toBe('playing');
      expect(await position(page)).toBe(5);
      const primary = controls.locator('.audio-toggle');
      await primary.focus(); await page.keyboard.press('Space');
      expect(await phase(page)).toBe('paused');
      expect(await primary.evaluate(element => element === document.activeElement)).toBe(true);
      expect(await primary.textContent()).toBe('继续播放');
      await page.keyboard.press('Space');
      await expect.poll(() => phase(page)).toBe('playing');
      expect(await primary.evaluate(element => element === document.activeElement)).toBe(true);
    } finally { await context.close(); }
  });

  it('pauses immediately from the focused audio trigger while other audio triggers keep native Space activation', async () => {
    const { page, context } = await setup();
    try {
      await startAudio(page);
      const direct = page.getByRole('button', { name: 'Direct audio', exact: true });
      expect(await direct.evaluate(element => element === document.activeElement)).toBe(true);
      await page.evaluate(() => { window.__shortcutMock.clips.at(-1)!.currentTime = 5; });
      await page.keyboard.press('Space');
      expect(await phase(page)).toBe('paused');
      expect(await position(page)).toBe(5);
      expect(await page.evaluate(() => window.__shortcutMock.clips.length)).toBe(1);
      await page.keyboard.press('Space');
      await expect.poll(() => phase(page)).toBe('playing');
      expect(await position(page)).toBe(5);
      expect(await page.evaluate(() => window.__shortcutMock.clips.length)).toBe(1);
      expect(await dispatchSpace(page, '[data-audio-source="audio"] span')).toBe(true);
      expect(await phase(page)).toBe('paused');

      const system = page.getByRole('button', { name: 'System speech', exact: true });
      expect(await dispatchSpace(page, '[data-audio-source="system"]')).toBe(false);
      expect(await page.getByLabel('Source', { exact: true }).textContent()).toBe('audio');
      await system.focus(); await page.keyboard.press('Space');
      expect(await page.getByLabel('Source', { exact: true }).textContent()).toBe('system');
      expect(await page.getByTestId('system').getByRole('region').count()).toBe(1);
      await direct.focus(); await page.keyboard.press('Space');
      await expect.poll(() => phase(page)).toBe('playing');
      expect(await page.getByLabel('Source', { exact: true }).textContent()).toBe('audio');
      expect(await page.evaluate(() => window.__shortcutMock.clips.length)).toBe(2);
      expect(await position(page)).toBe(0);
    } finally { await context.close(); }
  });

  it('distinguishes buffering and failed playback from completion and offers retry', async () => {
    const { page, context } = await setup();
    try {
      await startAudio(page);
      const controls = page.getByTestId('audio');
      await page.evaluate(() => window.__shortcutMock.clips.at(-1)!.fire('waiting'));
      await expect.poll(() => controls.getByRole('status').textContent()).toContain('正在缓冲');
      await page.evaluate(() => window.__shortcutMock.clips.at(-1)!.fire('playing'));
      await expect.poll(() => phase(page)).toBe('playing');
      await page.evaluate(() => { const audio = window.__shortcutMock.clips.at(-1)!; audio.currentTime = 4; audio.fire('error'); });
      await expect.poll(() => phase(page)).toBe('error');
      expect(await controls.getByRole('status').textContent()).toContain('播放失败');
      expect(await controls.getByRole('status').textContent()).not.toContain('播放结束');
      expect(await controls.getByRole('button', { name: '从头播放', exact: true }).count()).toBe(0);
      await controls.getByRole('button', { name: '重试播放', exact: true }).click();
      await expect.poll(() => phase(page)).toBe('playing');
      expect(await position(page)).toBe(4);
    } finally { await context.close(); }
  });
});
