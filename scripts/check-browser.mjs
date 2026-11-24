import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import fastifyStatic from '@fastify/static';
import { buildApp } from '../src/server/app.ts';

// Production bundle, real API/database, isolated local data. AI HTTP is simulated;
// browser network is restricted to this loopback server. No paid service is used.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporary = await mkdtemp(path.join(tmpdir(), 'nihongo-browser-v140-'));
const sentence = { jp: '私は毎朝駅まで歩きます。', kana: 'わたしはまいあさえきまであるきます。', zh: '我每天早上步行到车站。' };
const speakingReference = { jp: '図書館で本を読みます。', kana: 'としょかんでほんをよみます。', zh: '我在图书馆读书。' };
const wordFixtures = [
  ['バスケットボール', '篮球'], ['コーヒー', '咖啡'], ['テレビ', '电视'], ['サッカー', '足球'], ['パン', '面包'], ['バス', '公交车'], ['タクシー', '出租车'], ['シャツ', '衬衫'], ['チケット', '票'], ['テーブル', '桌子'],
  ['バレーボール', '排球'], ['スープ', '汤'], ['アイスクリーム', '冰淇淋'], ['ラジオ', '收音机'], ['カレー', '咖喱'], ['パソコン', '电脑'], ['カメラ', '相机'], ['セーター', '毛衣'], ['レストラン', '餐馆'], ['ホテル', '酒店'],
].map(([word, meaningZh]) => ({ word, meaningZh }));
let simulatedCalls = 0, assessmentCalls = 0;
const generated = { dictation: 0, speaking: 0 }, wordBatches = [];
const forbidden = async () => { throw new Error('External provider calls prohibited'); };
const app = buildApp({ dataDir: temporary, practiceRandom: () => 0, audioFetch: forbidden, voiceFetch: forbidden,
  aiFetch: async (_url, init) => {
    simulatedCalls++; const input = JSON.parse(JSON.parse(init.body).messages[1].content);
    let value;
    if (input.purpose === 'scope-audit') {
      value = { valid: true, reason: 'Controlled browser fixture' };
    } else if (Array.isArray(input.recent) && !input.kind) {
      wordBatches.push(input.count);
      value = { words: wordFixtures.filter(item => !input.recent.includes(item.word)).slice(0, input.count) };
    } else if (input.kind === 'speaking' || input.kind === 'dictation') {
      const index = generated[input.kind]++;
      const word = input.vocabulary[index % input.vocabulary.length];
      const reference = index === 0 ? input.kind === 'dictation' ? sentence : speakingReference
        : { jp: `${word.word}について${input.kind === 'dictation' ? '話します' : '勉強します'}。`, kana: `${word.reading}について${input.kind === 'dictation' ? 'はなします' : 'べんきょうします'}。`, zh: `关于「${word.meaning}」${input.kind === 'dictation' ? '谈论' : '学习'}。` };
      value = input.kind === 'speaking' ? { kind: 'speaking', goalZh: reference.zh, reference } : { kind: 'dictation', sentence: reference };
    } else {
      assessmentCalls++;
      value = input.goalZh && input.answer ? { meaningScore: 40, grammarScore: 30, targetGrammarUsed: true, summaryZh: '模拟文字表达正确。', grammarFeedbackZh: '目标语法使用正确。', corrections: [], reference: input.reference }
        : { correct: true, feedbackZh: '模拟判定：表达正确。', ...(input.target ? { reference: sentence } : {}) };
    }
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(value) }, finish_reason: 'stop' }] }), { headers: { 'content-type': 'application/json' } });
  } });
let browser;
const checks = [], failures = [], runtimeErrors = [], audits = [], zoomChecks = [];
try {
  await app.register(fastifyStatic, { root: path.join(root, 'dist') }); await app.listen({ host: '127.0.0.1', port: 0 });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  browser = await chromium.launch({ headless: true, ...(process.platform === 'win32' ? { channel: 'msedge' } : {}) });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce', acceptDownloads: true });
  await context.route('**/*', route => new URL(route.request().url()).origin === base ? route.continue() : route.abort('blockedbyclient'));
  const page = await context.newPage(); page.setDefaultTimeout(10000); page.on('pageerror', e => runtimeErrors.push(e.message));
  async function api(route, method = 'GET', body) {
    const response = await fetch(base + '/api' + route, { method, headers: body === undefined ? {} : { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, value: await response.json() };
  }
  let navigation = 0;
  async function route(hash) { await page.goto(`${base}/?acceptance=${++navigation}#${hash}`); await page.locator('main h1').waitFor(); }
  async function stage(name) { await page.locator('.stage-tabs').getByRole('button', { name }).click(); }
  async function check(name, run) {
    try { await run(); checks.push(name); console.log('PASS ' + name); }
    catch (e) { failures.push({ check: name, error: e.message }); console.log('FAIL ' + name + ': ' + e.message); }
  }
  const lessons = (await api('/lessons')).value;
  await check('50 lessons, review route and retired recording API', async () => {
    assert.deepEqual(lessons.map(l => l.id), Array.from({ length: 50 }, (_, i) => i + 1));
    for (const hash of ['home', 'lessons']) { await route(hash); await page.locator('.course-card').first().waitFor(); }
    await route('review/minna'); await page.getByRole('heading', { name: '大家的日本语', exact: true }).waitFor();
    await route('lessons'); await page.locator('.course-card').first().waitFor();
    assert.equal(await page.title(), 'スーパーミンナノニホンゴ');
    assert.equal(await page.locator('.sidebar nav > button, .sidebar nav > .special-nav > button').count(), 5);
    for (const label of ['今天学什么', '复习卡点', '听讲解']) assert.equal(await page.getByRole('button', { name: label, exact: true }).count(), 0);
    assert.equal((await api('/recordings')).status, 410);
  });
  await check('katakana IME composition, Enter submission and optional automatic next question', async () => {
    await page.getByRole('button', { name: '专项练习', exact: true }).click();
    await page.getByRole('button', { name: '片假名', exact: true }).click();
    const prompt = await page.locator('.kana-prompt').innerText();
    const answer = [...prompt].map(c => String.fromCharCode(c.charCodeAt(0) - 0x60)).join('');
    const field = page.locator('#kana-answer'); await field.focus(); await field.dispatchEvent('compositionstart'); await field.fill(answer);
    await page.waitForTimeout(400); assert.equal(await page.locator('.kana-prompt').innerText(), prompt);
    await field.press('Enter'); await field.dispatchEvent('compositionend');
    assert.equal(await page.locator('.kana-prompt').innerText(), prompt);
    await field.press('Enter'); await page.getByText('正确', { exact: true }).waitFor();
    assert.equal(await page.locator('.kana-prompt').innerText(), prompt);
    await field.press('Enter'); await page.waitForFunction(old => document.querySelector('.kana-prompt')?.textContent !== old, prompt);
    assert.equal(await field.inputValue(), ''); assert.equal(await field.evaluate(e => document.activeElement === e), true);
    const next = await page.locator('.kana-prompt').innerText();
    await page.getByRole('switch', { name: '回车答对自动下一题' }).check();
    await field.fill(next); await field.press('Enter');
    await page.waitForFunction(old => document.querySelector('.kana-prompt')?.textContent !== old, next);
    await page.getByRole('switch', { name: '回车答对自动下一题' }).uncheck();
  });
  await check('sidebar collapse survives reload', async () => {
    await page.getByRole('button', { name: '收拢目录', exact: true }).click(); await page.reload();
    await page.getByRole('button', { name: '展开目录', exact: true }).click();
    assert.equal(await page.getByRole('button', { name: '50课地图', exact: true }).isVisible(), true);
  });
  await check('four modules, word details and stable hidden translations', async () => {
    await route('study/6'); await stage('单词');
    assert.deepEqual(await page.locator('.stage-tabs button').allTextContents(), ['1单词', '2语法', '3听力', '4口语']);
    const vocabulary = (await api('/lessons/6/vocabulary')).value;
    assert.equal(vocabulary.words.length, 55); assert.equal(vocabulary.complete, true);
    assert.ok(vocabulary.words.every(w => !('examples' in w)));
    await page.locator('.vocabulary-list').waitFor();
    const first = vocabulary.words[0];
    assert.equal(await page.getByText(first.meaning, { exact: true }).isVisible(), false);
    await page.getByRole('button', { name: first.word, exact: true }).click();
    await page.getByRole('dialog').waitFor();
    assert.ok((await page.getByRole('dialog').innerText()).includes(first.detail.example.jp));
    await page.keyboard.press('Escape');
    assert.equal(await page.getByRole('dialog').count(), 0);
    await page.locator('.vocabulary-list tbody tr').first().getByRole('button', { name: '显示翻译', exact: true }).click();
    assert.equal(await page.getByText(first.meaning, { exact: true }).isVisible(), true);
    await page.getByRole('button', { name: first.meaning, exact: true }).click();
    assert.equal(await page.getByText(first.meaning, { exact: true }).isVisible(), false);
    await page.getByRole('button', { name: '显示所有翻译', exact: true }).click();
    assert.equal(await page.getByText(first.meaning, { exact: true }).isVisible(), true);
    await page.getByRole('button', { name: '隐藏所有翻译', exact: true }).click();
  });
  await check('all 50 vocabulary APIs are complete and lesson 27 renders the full list', async () => {
    let total = 0;
    for (let lesson = 1; lesson <= 50; lesson++) {
      const response = await api(`/lessons/${lesson}/vocabulary`); assert.equal(response.status, 200);
      assert.equal(response.value.complete, true); assert.ok(response.value.words.length > 10);
      assert.ok(response.value.words.every(word => word.partOfSpeech && word.meaning && word.reading && !('examples' in word)));
      total += response.value.words.length;
    }
    assert.equal(total, 2258);
    await route('study/27'); await stage('单词'); await page.locator('.vocabulary-list tbody tr').first().waitFor();
    assert.equal(await page.locator('.vocabulary-list tbody tr').count(), 44);
    assert.equal(await page.locator('.vocabulary-list .notice-inline').count(), 0);
  });
  await check('dialogue practice remains assisted after correcting an initial error', async () => {
    await route('study/14'); await stage('听力');
    assert.deepEqual(await page.locator('.content-switch').first().locator('button').allTextContents(), ['教材原声 MP3', '对话练习', 'AI练习']);
    await page.getByRole('button', { name: '对话练习', exact: true }).click(); const listening = lessons[13].listening[0];
    await page.locator('.answer-choices button').nth((listening.answer + 1) % 4).click(); await page.locator('.answer-feedback').waitFor();
    await page.locator('.answer-choices button').nth(listening.answer).click();
    await page.waitForFunction(async id => (await (await fetch('/api/backup')).json()).attempts.filter(a => a.itemId === id).length >= 2, listening.id);
    const attempts = (await api('/backup')).value.attempts.filter(a => a.itemId === listening.id); assert.equal(attempts.at(-1).usedHint, true);
    assert.equal(await page.getByRole('button', { name: '加入复习', exact: true }).count(), 0);
  });
  await check('AI starts on demand, keeps one lazy player and restores text feedback', async () => {
    await page.getByRole('button', { name: 'AI练习', exact: true }).click(); await page.getByRole('button', { name: '开始练习', exact: true }).waitFor(); assert.equal(simulatedCalls, 0);
    await page.getByRole('button', { name: '开始练习', exact: true }).click(); await page.getByRole('alert').waitFor(); assert.equal(simulatedCalls, 0);
    await api('/settings', 'PATCH', { apiKey: 'sk-local-browser-fixture', setupComplete: true });
    await page.getByRole('button', { name: '重试出题', exact: true }).click(); await page.locator('.ai-practice textarea').waitFor();
    assert.equal(await page.locator('.ai-practice .audio-controls').count(), 1);
    assert.equal(await page.getByText(/主考点/).count(), 0);
    await page.locator('.ai-practice textarea').fill(sentence.kana); await page.getByRole('button', { name: '检查听写', exact: true }).click(); await page.getByText('答对了。', { exact: true }).waitFor();
    const before = (await api('/ai-practice/current?lessonId=14&kind=dictation')).value, scored = assessmentCalls;
    await page.reload(); await stage('听力'); await page.getByRole('button', { name: 'AI练习', exact: true }).click();
    await page.getByText('答对了。', { exact: true }).waitFor();
    assert.deepEqual((await api('/ai-practice/current?lessonId=14&kind=dictation')).value, before);
    assert.equal(assessmentCalls, scored);
  });
  await check('immersive and Japanese switches preserve draft and large text preference', async () => {
    await api('/settings', 'PATCH', { largeText: true });
    const field = page.locator('.ai-practice textarea'); await field.fill('まだ書いています。');
    await page.getByRole('button', { name: '沉浸模式', exact: true }).click();
    assert.equal(await page.title(), '工作区'); assert.equal(await page.locator('.sidebar').isVisible(), false);
    await page.locator('.stage-tabs .immersion-text').first().waitFor({ state: 'hidden' });
    assert.equal(await page.locator('.ai-practice .practice-instruction').evaluateAll(elements => elements.every(element => getComputedStyle(element).display === 'none')), true, 'practice heading and instructions hidden');
    assert.equal(await page.locator('.dictation-label').evaluate(el => getComputedStyle(el).display), 'none', 'answer label hidden');
    assert.equal(await page.locator('.ai-practice .study-navigation .immersion-text').isVisible(), false, 'next label hidden');
    assert.equal(await field.getAttribute('placeholder'), null);
    await page.getByRole('combobox', { name: '界面语言' }).selectOption('ja-JP');
    assert.equal(await field.inputValue(), 'まだ書いています。'); assert.equal(await page.title(), 'ワークスペース');
    assert.equal(await page.getByRole('button', { name: '次の問題', exact: true }).isVisible(), true);
    await page.getByRole('button', { name: '集中モードを終了', exact: true }).click();
    assert.equal((await api('/settings')).value.largeText, true);
    await page.getByRole('combobox', { name: '表示言語' }).selectOption('zh-CN');
  });
  await check('speaking is AI only and textbook player is visible before fetching audio', async () => {
    await stage('口语'); assert.equal(await page.getByRole('button', { name: '原创练习', exact: true }).count(), 0);
    await page.getByRole('button', { name: '开始练习', exact: true }).waitFor();
    assert.equal(await page.locator('.recording-history').count(), 0);
    await stage('听力'); await page.getByRole('button', { name: '教材原声 MP3', exact: true }).click();
    const player = page.locator('.textbook-audio .audio-controls'); assert.equal(await player.count(), 1);
    for (const name of ['播放', '后退2秒', '前进2秒', '从头播放', '停止', '慢放', '快放']) assert.equal(await player.getByRole('button', { name, exact: true }).count(), 1);
    await player.getByRole('button', { name: '慢放', exact: true }).click(); assert.match(await player.innerText(), /0.75×/);
    await player.getByRole('button', { name: '快放', exact: true }).click(); assert.match(await player.innerText(), /1×/);
  });
  await check('speaking accepts typed answers, restores text scores and excludes pronunciation', async () => {
    await stage('口语'); await page.getByRole('button', { name: '开始练习', exact: true }).click();
    const mode = page.getByRole('combobox', { name: '回答模式' }); await mode.selectOption('text');
    const field = page.getByRole('textbox', { name: '用日语写出你的回答' });
    await field.fill('図書館で本を読みます。'); await field.press('Enter');
    await page.getByRole('heading', { name: '文字表达参考分 · 70/70' }).waitFor();
    const before = (await api('/ai-practice/current?lessonId=14&kind=speaking')).value, scored = assessmentCalls;
    await page.reload(); await stage('口语');
    await page.getByRole('heading', { name: '文字表达参考分 · 70/70' }).waitFor();
    assert.equal(await mode.inputValue(), 'text'); assert.equal(await field.inputValue(), '図書館で本を読みます。');
    assert.deepEqual((await api('/ai-practice/current?lessonId=14&kind=speaking')).value, before);
    assert.equal(assessmentCalls, scored);
    const mastery = (await api('/ai-practice/mastery?lessonId=14')).value;
    assert.equal(mastery.speaking.count, 1); assert.equal(mastery.pronunciation.count, 0);
  });
  await check('v4 backup download and atomic invalid/valid restore', async () => {
    await route('settings'); const pending = page.waitForEvent('download'); await page.getByRole('button', { name: '导出记录' }).click();
    const exported = path.join(temporary, 'export.json'); await (await pending).saveAs(exported); const backup = JSON.parse(await readFile(exported, 'utf8'));
    assert.equal(backup.version, 4); assert.deepEqual(backup.recordings, []); assert.equal(JSON.stringify(backup).includes('sk-local-browser-fixture'), false);
    const mastery = (await api('/ai-practice/mastery?lessonId=14')).value;
    const invalid = structuredClone(backup); invalid.progress[0].cursor = 999;
    await page.getByLabel('选择学习备份文件').setInputFiles({ name: 'invalid.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(invalid)) });
    await page.getByRole('button', { name: '确认恢复' }).click(); await page.getByText('学习位置与当前课程不一致。', { exact: true }).waitFor();
    assert.deepEqual((await api('/backup')).value.progress, backup.progress);
    await page.getByLabel('选择学习备份文件').setInputFiles({ name: 'valid.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(backup)) });
    await page.getByRole('button', { name: '确认恢复' }).click(); await page.getByText('学习记录已恢复。', { exact: true }).waitFor();
    assert.deepEqual((await api('/ai-practice/mastery?lessonId=14')).value, mastery);
  });
  await check('keyboard skip link and course navigation', async () => {
    await page.route('**/api/bootstrap', async route => { await new Promise(resolve => setTimeout(resolve, 150)); await route.continue(); }, { times: 1 });
    await route('study/14'); const hash = new URL(page.url()).hash;
    await page.waitForFunction(() => document.activeElement?.tagName === 'H1');
    await page.locator('.skip-link').focus(); await page.keyboard.press('Enter'); assert.equal(new URL(page.url()).hash, hash);
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'main');
    await page.locator('.stage-tabs button').nth(1).focus(); await page.keyboard.press('Space');
    await page.waitForFunction(() => document.querySelector('.stage-tabs [aria-current="step"]')?.textContent.includes('语法'));
  });
  await check('axe and large-text layout at desktop and mobile widths', async () => {
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 900 });
      for (const view of ['lessons', 'katakana', 'study/6', 'settings']) {
        await route(view); const result = await new AxeBuilder({ page }).analyze();
        audits.push({ width, view, overflow: await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), violations: result.violations.map(v => ({ id: v.id, targets: v.nodes.map(n => n.target) })) });
      }
    }
    assert.equal(audits.some(a => a.overflow || a.violations.length), false, JSON.stringify(audits));
  });
  await check('200 percent CSS zoom without horizontal overflow or clipped main controls', async () => {
    await page.setViewportSize({ width: 1280, height: 900 });
    for (const view of ['lessons', 'katakana', 'study/6', 'settings']) {
      await route(view); await page.evaluate(() => { document.documentElement.style.zoom = '2'; });
      zoomChecks.push({ view, overflow: await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1) });
    }
    assert.equal(zoomChecks.some(c => c.overflow), false, JSON.stringify(zoomChecks));
  });
  await check('each module has a charge bar and grammar completion persists', async () => {
    await route('study/6');
    for (const name of ['单词', '语法', '听力', '口语']) {
      await stage(name);
      const label = name === '听力' ? '听力进度' : name === '口语' ? '口语进度' : '学习进度';
      await page.getByRole('progressbar', { name: label, exact: true }).waitFor();
      assert.equal(await page.getByRole('progressbar', { name: label, exact: true }).count(), 1);
    }
    await stage('语法'); await page.getByRole('button', { name: '标记已学会', exact: true }).click();
    await page.waitForFunction(() => Number(document.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow')) > 0);
    const score = await page.getByRole('progressbar').getAttribute('aria-valuenow');
    await page.reload(); await stage('语法');
    await page.waitForFunction(expected => document.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow') === expected, score);
  });
  await check('AI katakana words keep a five-word buffer, submit on Enter and show translations', async () => {
    await route('katakana'); const calls = simulatedCalls;
    await page.getByRole('button', { name: 'AI练习', exact: true }).click(); assert.equal(simulatedCalls, calls);
    await page.getByRole('button', { name: '开始练习', exact: true }).click();
    await page.getByText('バスケットボール', { exact: true }).waitFor();
    const field = page.getByRole('textbox', { name: '平假名或片假名', exact: true });
    await page.getByText('正在准备下一题……', { exact: true }).waitFor({ state: 'hidden' });
    assert.deepEqual(wordBatches, [1, 5]);
    assert.equal(simulatedCalls, calls + 2);
    assert.equal(await page.locator('.katakana-meaning').count(), 0);
    await field.fill('ばすけっとぼる'); await field.press('Enter'); await page.getByText('请再试一次', { exact: true }).waitFor();
    await field.dispatchEvent('compositionstart'); await field.fill('ばすけっとぼーる');
    assert.equal(await page.locator('.kana-prompt').innerText(), 'バスケットボール');
    await field.press('Enter'); await field.dispatchEvent('compositionend');
    assert.equal(await page.locator('.kana-prompt').innerText(), 'バスケットボール');
    await field.press('Enter'); await page.getByText('正确', { exact: true }).waitFor();
    assert.equal(await page.locator('.katakana-meaning').innerText(), '中文释义：篮球');
    await field.press('Enter'); await page.getByText('コーヒー', { exact: true }).waitFor();
    assert.equal(await field.inputValue(), ''); assert.equal(await field.evaluate(el => document.activeElement === el), true);
    for (let i = 0; i < 9; i++) {
      const word = await page.locator('.kana-prompt').innerText();
      const hiragana = word.replace(/[ァ-ヶ]/g, char => String.fromCharCode(char.charCodeAt(0) - 96));
      await field.fill(i % 2 ? word : hiragana); await field.press('Enter');
      await page.getByText('正确', { exact: true }).waitFor();
      assert.equal(await page.locator('.kana-prompt').innerText(), word);
      assert.ok((await page.locator('.katakana-meaning').innerText()).startsWith('中文释义：'));
      await field.press('Enter'); await page.waitForFunction(old => document.querySelector('.kana-prompt')?.textContent !== old, word);
    }
    await page.getByText('バレーボール', { exact: true }).waitFor();
    await page.getByText('正在准备下一题……', { exact: true }).waitFor({ state: 'hidden' });
    assert.deepEqual(wordBatches, [1, 5, ...Array(10).fill(1)]);
    assert.equal(simulatedCalls, calls + 12); assert.equal(await field.inputValue(), '');
  });
  await check('no uncaught browser errors', async () => assert.deepEqual(runtimeErrors, []));
} finally {
  await browser?.close(); await app.close();
  if (path.dirname(path.resolve(temporary)) !== path.resolve(tmpdir()) || !path.basename(temporary).startsWith('nihongo-browser-v140-')) throw new Error('Unexpected temporary path');
  await rm(temporary, { recursive: true, force: true });
}
const report = { passed: checks, failures, audits, zoomChecks, runtimeErrors, simulatedCalls, realProviderCalls: 0 };
await mkdir(path.join(root, 'test-results'), { recursive: true }); await writeFile(path.join(root, 'test-results/v140-browser.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2)); if (failures.length) process.exitCode = 1;
