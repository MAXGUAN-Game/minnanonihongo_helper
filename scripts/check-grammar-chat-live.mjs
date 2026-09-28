import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { getLesson } from '../src/content/index.ts';
import { getGrammarChatScenario } from '../src/shared/grammar-chat.ts';
import { requestTurn } from '../src/server/ai.ts';

// Opt-in only: this sends two short requests to the configured DeepSeek account.
// Its synthetic session exists only in memory and never changes user progress.
if (!process.argv.includes('--allow-paid')) throw new Error('This check uses DeepSeek credit. Pass --allow-paid to run.');
const db = new Database('data/nihongo.sqlite', { readonly: true });
try {
  const apiKey = db.prepare('SELECT api_key FROM secrets WHERE id=1').get()?.api_key;
  assert.ok(apiKey, 'Configure DeepSeek in the app first.');
  const model = JSON.parse(db.prepare('SELECT value FROM settings WHERE id=1').get().value).model;
  const lesson = getLesson(27);
  const grammarId = 'l27-g2';
  const scenario = getGrammarChatScenario(lesson, grammarId);
  const session = {
    id: randomUUID(), lessonId: lesson.id, scenarioId: scenario.id, mode: 'grammar', grammarId,
    status: 'active', turnCount: 0, feedback: [], completedGoals: [], updatedAt: new Date().toISOString(),
    turns: [{ id: randomUUID(), role: 'assistant', text: scenario.opening.jp, translation: scenario.opening.zh, source: 'lesson', createdAt: new Date().toISOString() }],
  };
  const checks = [];
  let requests = 0;
  const aiFetch = (...args) => { requests++; return fetch(...args); };
  for (const text of ['見えます和見られます有什么区别？请用简短中文解释，再举一个例子。', '窓から海が見えます。この言い方はいいですか。']) {
    const started = performance.now();
    const result = await requestTurn({ aiFetch, apiKey, model, lesson, scenario, session, text, usedHint: false,
      prerequisites: lesson.prerequisiteLessonIds.map(id => ({ id, canDo: getLesson(id).canDo })),
    });
    assert.equal(result.endSession, false);
    assert.deepEqual(result.completedGoals, []);
    checks.push({ input: text, replyJa: result.replyJa, explanationZh: result.replyZh, hintZh: result.hintZh, corrections: result.corrections, elapsedMs: Math.round(performance.now() - started) });
    session.turnCount++;
    session.turns.push(
      { id: randomUUID(), role: 'user', text, source: 'user', createdAt: new Date().toISOString() },
      { id: randomUUID(), role: 'assistant', text: result.replyJa, translation: result.replyZh, hint: result.hintZh, source: 'deepseek', createdAt: new Date().toISOString() },
    );
  }
  const report = { passed: true, model, lessonId: lesson.id, grammarId, requests, checks, note: 'Real DeepSeek replies validated through requestTurn; in-memory synthetic session, no user learning records changed. Not a full teaching-quality evaluation.' };
  await mkdir('test-results', { recursive: true });
  await writeFile('test-results/grammar-chat-live.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  console.error(JSON.stringify({ passed: false, code: error.code || 'CHECK_FAILED', message: error.code?.startsWith('AI_') ? error.message : 'Grammar chat check did not complete.' }));
  process.exitCode = 1;
} finally { db.close(); }
