import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Route } from '@playwright/test';
import { createServer, type ViteDevServer } from 'vite';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { lessons } from '../src/content';

let browser: Browser, vite: ViteDevServer, origin: string, cacheDir: string;
const examples = [
  { lessonId: 26, score: 0, tier: 'locked', label: '未解锁' },
  { lessonId: 27, score: 1, tier: 'bronze', label: '铜卡' },
  { lessonId: 28, score: 29.9, tier: 'bronze', label: '铜卡' },
  { lessonId: 29, score: 30, tier: 'silver', label: '银卡' },
  { lessonId: 30, score: 69.9, tier: 'silver', label: '银卡' },
  { lessonId: 31, score: 70, tier: 'gold', label: '金卡' },
  { lessonId: 32, score: 99.8, tier: 'gold', label: '金卡' },
  { lessonId: 33, score: 100, tier: 'diamond', label: '钻石卡' },
];
const progress = lessons.map(lesson => ({ lessonId: lesson.id, score: examples.find(item => item.lessonId === lesson.id)?.score ?? 0 }));
const harness = `
import React, {useState} from 'react'; import {createRoot} from 'react-dom/client';
import {CourseMap} from '/src/client/CourseMap.tsx'; import '/src/client/style.css';
function Harness(){
  const [currentLessonId,setCurrentLessonId]=useState(31);
  const [chosen,setChosen]=useState(null);
  return <main className="page-content" style={{maxWidth:1200,margin:'auto'}}>
    <CourseMap lessons={window.testLessons} bootstrap={{settings:{currentLessonId,largeText:true},progress:[]}}
      choose={async id=>{setChosen(id);setCurrentLessonId(id);}}/>
    <output aria-label="已选择单元">{chosen??''}</output>
  </main>;
}
createRoot(document.getElementById('root')).render(<Harness/>);`;

beforeAll(async () => {
  cacheDir = await mkdtemp(join(tmpdir(), 'nihongo-course-map-ui-'));
  vite = await createServer({ configFile: false, root: process.cwd(), cacheDir,
    optimizeDeps: { include: ['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime', 'react/jsx-dev-runtime', 'lucide-react'], noDiscovery: true },
    server: { host: '127.0.0.1', port: 0 }, plugins: [{ name: 'course-map-test', resolveId(id) { if (id === '/__course-map-test.tsx') return id; }, load(id) { if (id === '/__course-map-test.tsx') return harness; } }] });
  await vite.listen(); const address = vite.httpServer!.address(); if (!address || typeof address === 'string') throw new Error('No test port');
  origin = `http://127.0.0.1:${address.port}`;
  browser = await chromium.launch({ headless: true, ...(process.platform === 'win32' ? { channel: 'msedge' } : {}) });
  await mkdir(resolve('test-results'), { recursive: true });
}, 30000);

afterAll(async () => {
  await browser?.close(); await vite?.close();
  if (dirname(resolve(cacheDir)) === resolve(tmpdir()) && basename(cacheDir).startsWith('nihongo-course-map-ui-')) await rm(cacheDir, { recursive: true, force: true });
});

async function setup(options: { mobile?: boolean; intercept?: (route: Route, requestNumber: number) => Promise<void> } = {}) {
  const context = await browser.newContext({ viewport: options.mobile ? { width: 390, height: 844 } : { width: 1360, height: 1000 } });
  await context.addInitScript(value => { Object.assign(window, { testLessons: value }); }, lessons);
  await context.route('**/*', route => new URL(route.request().url()).origin !== origin ? route.abort('blockedbyclient') : route.fallback());
  const page = await context.newPage(); page.setDefaultTimeout(6000);
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  let requests = 0;
  await page.route('**/__course-map-test', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html lang="zh-CN" class="large-text"><head><title>课程地图</title></head><body><div id="root"></div><script type="module" src="/__course-map-test.tsx"></script></body></html>' }));
  await page.route('**/api/course-progress', async route => {
    requests++;
    if (options.intercept) await options.intercept(route, requests);
    else await route.fulfill({ json: progress });
  });
  await page.goto(origin + '/__course-map-test'); await page.locator('.course-card').first().waitFor();
  return { context, page, errors, requests: () => requests };
}

describe('course map progress cards', () => {
  it('shows numeric progress and distinct tiers at each boundary while preserving the selected card tier', async () => {
    const { page, context, errors, requests } = await setup();
    try {
      await page.locator('.course-card[data-lesson-id="31"][data-tier="gold"]').waitFor();
      for (const item of examples) {
        const card = page.locator(`.course-card[data-lesson-id="${item.lessonId}"]`);
        expect(await card.getAttribute('data-tier')).toBe(item.tier);
        const badge = card.getByRole('img', { name: item.label, exact: true });
        expect(await badge.getAttribute('title')).toBe(item.label);
        expect(await badge.innerText()).toBe('');
        expect(await card.locator('.course-progress').innerText()).toContain(`${item.score}%`);
        expect(await card.getByRole('progressbar').getAttribute('aria-valuenow')).toBe(String(item.score));
      }
      const selected = page.locator('.course-card[data-lesson-id="31"]');
      expect(await selected.getAttribute('class')).toContain('current');
      expect(await selected.innerText()).toContain('当前选择');
      const goldSurfaces = await page.locator('.course-card[data-tier="gold"]').evaluateAll(cards => cards.map(card => {
        const style = getComputedStyle(card); return `${style.backgroundColor} ${style.backgroundImage}`;
      }));
      expect(new Set(goldSurfaces).size).toBe(1);
      const surfaces = await page.locator('.course-card').evaluateAll(cards => ['locked', 'bronze', 'silver', 'gold', 'diamond'].map(tier => {
        const card = cards.find(element => element.getAttribute('data-tier') === tier)!;
        const style = getComputedStyle(card); return `${style.backgroundColor} ${style.backgroundImage} ${style.borderColor}`;
      }));
      expect(new Set(surfaces).size).toBe(5);
      expect(requests()).toBe(1);
      expect(errors).toEqual([]);
      await page.screenshot({ path: 'test-results/course-map-desktop.png', fullPage: true });
    } finally { await context.close(); }
  });

  it('keeps zero-progress courses enterable and keeps progress through search and volume changes', async () => {
    const { page, context, requests } = await setup();
    try {
      const zero = page.locator('.course-card[data-lesson-id="26"]');
      await zero.getByRole('img', { name: '未解锁', exact: true }).waitFor();
      expect(await zero.isEnabled()).toBe(true);
      await zero.click();
      expect(await page.getByLabel('已选择单元').innerText()).toBe('26');
      const search = page.getByRole('textbox', { name: '查找课程' });
      await search.fill('31');
      expect(await page.locator('.course-card').count()).toBe(1);
      expect(await page.locator('.course-card').getAttribute('data-tier')).toBe('gold');
      await search.clear();
      await page.getByRole('button', { name: '初级 Ⅰ · 1–25', exact: true }).click();
      expect(await page.locator('.course-card').count()).toBe(25);
      expect(await page.locator('.course-card[data-lesson-id="1"]').getAttribute('data-tier')).toBe('locked');
      await page.getByRole('button', { name: '初级 Ⅱ · 26–50', exact: true }).click();
      expect(await page.locator('.course-card[data-lesson-id="31"]').getAttribute('data-tier')).toBe('gold');
      expect(requests()).toBe(1);
    } finally { await context.close(); }
  });

  it('does not show failed or pending progress as zero and allows a failed request to retry', async () => {
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const { page, context, requests } = await setup({ intercept: async (route, requestNumber) => {
      if (requestNumber === 1) { await pending; await route.fulfill({ status: 503, json: { error: '进度暂时无法读取' } }); }
      else await route.fulfill({ json: progress });
    } });
    try {
      expect(await page.locator('.course-card[data-tier="locked"]').count()).toBe(0);
      expect(await page.locator('.course-progress').getByText('0%', { exact: true }).count()).toBe(0);
      release();
      await page.getByRole('alert').waitFor();
      expect(await page.locator('.course-card[data-tier="locked"]').count()).toBe(0);
      await page.getByRole('button', { name: '重试', exact: true }).click();
      await page.locator('.course-card[data-lesson-id="31"][data-tier="gold"]').waitFor();
      expect(await page.getByRole('alert').count()).toBe(0);
      expect(requests()).toBe(2);
    } finally { release(); await context.close(); }
  });

  it('keeps progress labels and cards inside the viewport with large text on mobile', async () => {
    const { page, context, errors } = await setup({ mobile: true });
    try {
      await page.locator('.course-card[data-lesson-id="31"][data-tier="gold"]').waitFor();
      const bounds = await page.locator('.course-card, .course-progress, .course-tier').evaluateAll(elements => elements.map(element => {
        const rect = element.getBoundingClientRect(); return { left: rect.left, right: rect.right, width: rect.width, scrollWidth: element.scrollWidth, clientWidth: element.clientWidth };
      }));
      expect(bounds.every(bound => bound.left >= 0 && bound.right <= 391)).toBe(true);
      expect(bounds.every(bound => bound.scrollWidth <= bound.clientWidth + 1)).toBe(true);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
      expect(errors).toEqual([]);
      await page.screenshot({ path: 'test-results/course-map-mobile.png', fullPage: true });
      await page.screenshot({ path: 'test-results/course-map-mobile-viewport.png' });
    } finally { await context.close(); }
  });
});
