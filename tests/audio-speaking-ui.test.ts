import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { createServer, type ViteDevServer } from 'vite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

// Exercise the actual recorder, WAV encoder and UI. Only microphone and HTTP
// boundaries are mocked; every non-local request is blocked, including paid AI.
let browser: Browser, vite: ViteDevServer, origin: string, cacheDir: string;
const settingsHarness = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { AudioAssessmentSettings } from '/src/client/AudioAssessmentSettings.tsx';
import { VoiceSettings } from '/src/client/VoiceSettings.tsx';
import { useSpeech } from '/src/client/speech.ts';
import '/src/client/style.css';
function Harness(){const speech=useSpeech(()=>{});return <main style={{maxWidth:900,margin:'auto',padding:20}}><h1>学习设置</h1><AudioAssessmentSettings/><VoiceSettings speech={speech} notice={()=>{}} deployment="web"/></main>}
createRoot(document.getElementById('root')).render(<Harness/>);`;

beforeAll(async () => {
  cacheDir = await mkdtemp(join(tmpdir(), 'nihongo-audio-speaking-ui-'));
  vite = await createServer({ configFile: false, root: process.cwd(), cacheDir,
    optimizeDeps: { include: ['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime', 'react/jsx-dev-runtime', 'lucide-react'], noDiscovery: true },
    server: { host: '127.0.0.1', port: 0 }, plugins: [{ name: 'audio-speaking-test',
      resolveId(id) { if (id === '/__audio-settings.tsx') return id; },
      load(id) { if (id === '/__audio-settings.tsx') return settingsHarness; },
    }] });
  await vite.listen(); const address = vite.httpServer!.address();
  if (!address || typeof address === 'string') throw new Error('No test port');
  origin = `http://127.0.0.1:${address.port}`;
  browser = await chromium.launch({ headless: true, ...(process.platform === 'win32' ? { channel: 'msedge' } : {}) });
}, 30000);
afterAll(async () => {
  await browser?.close(); await vite?.close();
  if (cacheDir && dirname(resolve(cacheDir)) === resolve(tmpdir()) && basename(cacheDir).startsWith('nihongo-audio-speaking-ui-')) await rm(cacheDir, { recursive: true, force: true });
});

async function setupSettings(hasApiKey: boolean) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await context.route('**/*', route => new URL(route.request().url()).origin !== origin ? route.abort('blockedbyclient') : route.fallback());
  const page = await context.newPage(); page.setDefaultTimeout(6000);
  const assessments: string[] = [];
  await page.route('**/api/**/assess*', route => { assessments.push(route.request().url()); return route.abort('blockedbyclient'); });
  const current = { page, context, assessments };
  const audioPatches: Record<string, unknown>[] = [], voicePatches: Record<string, unknown>[] = [], syntheses: string[] = [];
  let audioSettings = { provider: 'qwen', model: 'qwen3.8-omni-flash', workspaceId: '', hasApiKey };
  const voiceSettings = { provider: 'minimax', model: 'speech-2.8-hd', voice: 'Japanese_KindLady', secondaryVoice: 'Japanese_GentleButler', alternateSpeakers: true, speed: 1, hasApiKey: true };
  await page.route('**/__audio-settings-test', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html lang="zh-CN"><head><title>学习设置</title></head><body><div id="root"></div><script type="module" src="/__audio-settings.tsx"></script></body></html>' }));
  await page.route('**/api/speaking/audio-settings', route => {
    if (route.request().method() === 'PATCH') {
      const patch = route.request().postDataJSON(); audioPatches.push(patch);
      audioSettings = { ...audioSettings, workspaceId: patch.workspaceId, hasApiKey: audioSettings.hasApiKey || Boolean(patch.apiKey) };
    }
    return route.fulfill({ json: audioSettings });
  });
  await page.route('**/api/voice/settings', route => {
    if (route.request().method() === 'PATCH') voicePatches.push(route.request().postDataJSON());
    return route.fulfill({ json: voiceSettings });
  });
  await page.route('**/api/voice/synthesize', route => { syntheses.push(route.request().url()); return route.abort('blockedbyclient'); });
  const open = async () => {
    await page.goto(`${origin}/__audio-settings-test`);
    await page.getByRole('button', { name: '保存声音设置', exact: true }).waitFor();
    await page.getByText(hasApiKey ? '百炼密钥已保存，效果与用时以录音测试为准' : '尚未配置百炼密钥', { exact: true }).waitFor();
  };
  return { ...current, open, audioPatches, voicePatches, syntheses };
}
describe('audio feedback settings are separate from reading voices', () => {
  it('never prefills an existing key and keeps it when only the workspace changes', async () => {
    const { page, context, open, audioPatches, voicePatches, assessments, syntheses } = await setupSettings(true);
    try {
      await open();
      const card = page.getByRole('region', { name: 'AI 听录音', exact: true });
      const key = card.locator('#audio-assessment-key');
      expect(await key.inputValue()).toBe('');
      expect(await key.getAttribute('type')).toBe('password');
      expect(await key.getAttribute('placeholder')).toBe('留空保持原密钥');
      await card.getByText('业务空间设置（可选）', { exact: true }).click();
      await card.getByLabel('业务空间 ID', { exact: true }).fill('  my-learning-space  ');
      await card.getByRole('button', { name: '保存听音设置', exact: true }).click();
      await card.getByRole('status').filter({ hasText: '已保存' }).waitFor();
      expect(audioPatches).toEqual([{ workspaceId: 'my-learning-space' }]);
      expect(await key.inputValue()).toBe(''); expect(voicePatches).toEqual([]);
      expect(await page.locator('#minimax-speech-model').inputValue()).toBe('speech-2.8-hd');
      expect(assessments).toEqual([]); expect(syntheses).toEqual([]);
    } finally { await context.close(); }
  });

  it('clears a newly saved key while preserving the independently edited reading voice settings', async () => {
    const { page, context, open, audioPatches, voicePatches, assessments, syntheses } = await setupSettings(false);
    try {
      await open();
      const card = page.getByRole('region', { name: 'AI 听录音', exact: true });
      expect(await card.getByRole('button', { name: '保存听音设置', exact: true }).isDisabled()).toBe(true);
      await page.locator('#minimax-speech-key').fill('minimax-unsaved-test-key');
      await card.locator('#audio-assessment-key').fill('  sk-audio-test-key  ');
      await card.getByRole('button', { name: '保存听音设置', exact: true }).click();
      await card.getByRole('status').filter({ hasText: '已保存' }).waitFor();
      expect(audioPatches).toEqual([{ workspaceId: '', apiKey: 'sk-audio-test-key' }]);
      expect(await card.locator('#audio-assessment-key').inputValue()).toBe('');
      expect(await card.locator('#audio-assessment-key').getAttribute('placeholder')).toBe('留空保持原密钥');
      expect(await page.locator('#minimax-speech-key').inputValue()).toBe('minimax-unsaved-test-key');
      expect(voicePatches).toEqual([]);
      await page.getByRole('button', { name: '保存声音设置', exact: true }).click();
      await page.getByText('声音设置已保存。', { exact: true }).waitFor();
      expect(voicePatches).toHaveLength(1);
      expect(voicePatches[0].apiKey).toBe('minimax-unsaved-test-key');
      expect(audioPatches).toHaveLength(1); expect(assessments).toEqual([]); expect(syntheses).toEqual([]);
      const audit = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
      expect(audit.violations.map(item => item.id)).toEqual([]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    } finally { await context.close(); }
  });
});
