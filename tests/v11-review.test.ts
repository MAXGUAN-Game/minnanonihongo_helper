import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from '@playwright/test';
import { createServer, type ViteDevServer } from 'vite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

// Component-level recording association regressions. The recorder is controlled
// explicitly; these checks use neither microphone access nor a paid provider.
let browser: Browser, vite: ViteDevServer, origin: string, cacheDir: string;
const recordId = 'b3d733a0-9b24-4bdd-aaf1-463b5da33cd1';
const session = { id: 'review-session', lessonId: 14, scenarioId: 'l14-scene1', status: 'active', turnCount: 0,
  turns: [{ id: 'opening', role: 'assistant', source: 'lesson', text: '住所を書いてください。', translation: '请写地址。', createdAt: '2026-01-01T00:00:00Z' }], feedback: [], completedGoals: [], updatedAt: '2026-01-01T00:00:00Z' };
const recorderModule = `
import {useState,useEffect} from 'react';
export function useRecorder(){
  const [clip,setClip]=useState(null);
  useEffect(()=>{window.reviewSetClip=setClip;return()=>{delete window.reviewSetClip}},[]);
  return {status:'idle',clip,saving:false,saveError:'',transcribeError:'',start(){},stop(){},cancel(){setClip(null)},clear(){setClip(null)},retrySave(){},retryTranscribe(){}};
}`;
const harness = `
import React from 'react';
import {createRoot} from 'react-dom/client';
import {SpeakingPractice} from '/src/client/SpeakingPractice.tsx';
import {Conversation} from '/src/client/Conversation.tsx';
import {lessons1} from '/src/content/lessons-01-25.ts';
window.reviewRatings=[];
const speech={stop(){},say(){},speaking:false,getEpoch(){return 0},sayAuto(){},playUrl(){}};
const settings={currentLessonId:14,dailyMinutes:15,largeText:false,furigana:false,autoplay:false,model:'mock',hasApiKey:true,setupComplete:true};
const lesson=lessons1[13];
createRoot(document.getElementById('root')).render(new URLSearchParams(location.search).has('conversation')
  ? <Conversation lesson={lesson} resume={${JSON.stringify(session)}} settings={settings} speech={speech} notice={()=>{}} refresh={async()=>{}} addCorrection={async()=>{}}/>
  : <SpeakingPractice lessonId={14} task={lesson.speaking[0]} speech={speech} notice={()=>{}} busy={false} usedHint={false} furigana={false} onHint={()=>{}} onRate={async(result,answer)=>window.reviewRatings.push({result,...answer})}/>);
`;

beforeAll(async () => {
  cacheDir = await mkdtemp(join(tmpdir(), 'nihongo-v11-review-'));
  vite = await createServer({ configFile: false, root: process.cwd(), cacheDir,
    optimizeDeps: { include: ['react', 'react-dom/client', 'react/jsx-runtime', 'react/jsx-dev-runtime', 'lucide-react'], noDiscovery: true },
    server: { host: '127.0.0.1', port: 0 }, plugins: [{ name: 'review-recorder-control', enforce: 'pre',
      resolveId(source, importer) {
        if (source === '/__v11-review.tsx') return source;
        if (source === './speech' && /[\\/](Conversation|SpeakingPractice)\.tsx$/.test(importer || '')) return '\0review-recorder';
      },
      load(id) { if (id === '/__v11-review.tsx') return harness; if (id === '\0review-recorder') return recorderModule; },
    }] });
  await vite.listen(); const address = vite.httpServer!.address();
  if (!address || typeof address === 'string') throw new Error('No review fixture port');
  origin = `http://127.0.0.1:${address.port}`;
  browser = await chromium.launch({ headless: true, ...(process.platform === 'win32' ? { channel: 'msedge' } : {}) });
}, 30000);
afterAll(async () => {
  await browser?.close(); await vite?.close();
  if (cacheDir && dirname(resolve(cacheDir)) === resolve(tmpdir()) && basename(cacheDir).startsWith('nihongo-v11-review-')) await rm(cacheDir, { recursive: true, force: true });
});
async function setup() {
  const context = await browser.newContext();
  await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.fallback() : route.abort());
  const page = await context.newPage(); page.setDefaultTimeout(5000);
  await page.route('**/__review*', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body><div id="root"></div><script type="module" src="/__v11-review.tsx"></script></body></html>' }));
  return { page, context };
}
async function setRecording(page: Page, recordingId?: string) {
  await page.evaluate(value => {
    const control = window as unknown as { reviewSetClip: (clip: unknown) => void };
    control.reviewSetClip({ url: 'blob:review-recording', durationMs: 1000, saved: Boolean(value), recordingId: value });
  }, recordingId);
}

describe('v1.1 recording association recovery', () => {
  it('does not attach a previous text-only score after a failed recording save is retried successfully', async () => {
    const { page, context } = await setup();
    await page.route('**/api/speaking/assess', route => {
      const input = route.request().postDataJSON();
      return route.fulfill({ json: { id: input.clientAssessmentId, lessonId: 14, itemId: input.itemId, text: input.text, recordingId: input.recordingId, createdAt: new Date().toISOString(), source: 'deepseek', kind: 'expression', taskScore: 45, grammarScore: 28, vocabularyScore: 19, totalScore: 92, summaryZh: '意思表达清楚了。', corrections: [], reference: { jp: '少し待ってください。', kana: 'すこしまってください。', zh: '请稍等。' } } });
    });
    try {
      await page.goto(`${origin}/__review`);
      await page.locator('#speaking-answer').fill('少し待ってください。');
      await setRecording(page); // The independent upload has failed; transcription was usable.
      await page.getByRole('button', { name: '确认并评分', exact: true }).click();
      await page.locator('.expression-result').waitFor();
      await setRecording(page, recordId); // Same clip is now saved after retry.
      await page.getByRole('button', { name: '独立说出来了', exact: true }).click();
      const ratings = await page.evaluate(() => (window as unknown as { reviewRatings: Array<{ recordingId?: string; assessmentId?: string }> }).reviewRatings);
      expect(ratings).toHaveLength(1);
      expect(ratings[0]!.recordingId).toBe(recordId);
      expect(ratings[0]!.assessmentId).toBeUndefined();
    } finally { await context.close(); }
  });

  it.each(['RECORDING_NOT_FOUND', 'RECORDING_MISMATCH'])('releases %s and permits text-only resend without discarding the draft', async code => {
    const { page, context } = await setup();
    const turns: Array<{ text: string; clientTurnId: string; recordingId?: string }> = [];
    await page.addInitScript(({ id, recordingId }) => localStorage.setItem(`conversation-draft-${id}`, JSON.stringify({ sessionId: id, draft: '住所ですね。', usedHint: false, pendingRequest: null, recordingId })), { id: session.id, recordingId: recordId });
    await page.route('**/api/sessions/*/turn', route => {
      const input = route.request().postDataJSON(); turns.push(input);
      if (turns.length === 1) return route.fulfill({ status: code === 'RECORDING_NOT_FOUND' ? 404 : 400, json: { code, error: '这段录音不能关联到当前回答。' } });
      return route.fulfill({ json: { ...session, turnCount: 1, turns: [...session.turns,
        { id: input.clientTurnId, role: 'user', source: 'user', text: input.text, createdAt: '2026-01-01T00:01:00Z' },
        { id: 'reply', role: 'assistant', source: 'deepseek', text: 'はい、お願いします。', translation: '好的，请。', createdAt: '2026-01-01T00:01:00Z' }] } });
    });
    try {
      await page.goto(`${origin}/__review?conversation`);
      await page.getByRole('button', { name: '确认并发送', exact: true }).click();
      await page.locator('.answer-zone').getByRole('alert').waitFor();
      expect(turns[0]!.recordingId).toBe(recordId);
      expect(await page.locator('#answer-draft').inputValue()).toBe('住所ですね。');
      expect(await page.getByRole('button', { name: '重试上一句', exact: true }).count()).toBe(0);
      await page.getByRole('button', { name: '确认并发送', exact: true }).click();
      await expect.poll(() => page.locator('#answer-draft').inputValue()).toBe('');
      expect(turns[1]!.recordingId).toBeUndefined();
      expect(turns[1]!.clientTurnId).not.toBe(turns[0]!.clientTurnId);
    } finally { await context.close(); }
  });
});
