import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { getLesson } from '../src/content';
import { legacyBackup } from './legacy-backup-fixtures';
import { createPractice } from './practice-fixtures';
import { task } from './recordings-fixtures';

describe('legacy original-speaking feedback remains historical data', () => {
  it.each([2, 3] as const)('keeps v%i expression and audio feedback, removes recording links, and does not invent AI mastery', async version => {
    const { app, aiFetch, audioFetch } = createPractice(); const backup = await legacyBackup(app, version);
    backup.assessments.push({ id: randomUUID(), lessonId: 1, itemId: task.id, recordingId: backup.recordings[0].id,
      text: '会社員です。', createdAt: backup.recordings[0].createdAt, kind: 'audio', source: 'qwen-omni', model: 'qwen3.8-omni-flash', latencyMs: 1200,
      summaryZh: '意思清楚。', grammarFeedbackZh: '语法正确。', corrections: [], pronunciation: { status: 'uncertain', feedbackZh: '发音暂不确定。', issues: [] }, reference: task.answer });
    const restored = await app.inject({ method: 'POST', url: '/api/restore', payload: { backup } }); expect(restored.statusCode, restored.body).toBe(200);
    const exported = (await app.inject('/api/backup')).json();
    expect(exported.assessments).toHaveLength(2); expect(exported.assessments[0]).toMatchObject({ totalScore: 95, text: '会社員です。' });
    expect(exported.assessments[1].pronunciation.status).toBe('uncertain'); expect(JSON.stringify(exported)).not.toContain('recordingId');
    expect(exported.aiAttempts).toEqual([]);
    const mastery = await app.inject('/api/ai-practice/mastery?lessonId=1'); expect(mastery.statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/api/restore', payload: { backup: exported } })).statusCode).toBe(200);
    expect(aiFetch).not.toHaveBeenCalled(); expect(audioFetch).not.toHaveBeenCalled();
  });
  it('rejects forged legacy scores, mismatched text and foreign grammar atomically', async () => {
    const { app } = createPractice(); const original = await legacyBackup(app, 3);
    expect((await app.inject({ method: 'POST', url: '/api/restore', payload: { backup: original } })).statusCode).toBe(200);
    const expected = (await app.inject('/api/backup')).json().assessments;
    for (const mutate of [
      (b: typeof original) => { b.assessments[0].totalScore = 100; },
      (b: typeof original) => { b.assessments[0].recordingId = randomUUID(); },
      (b: typeof original) => { b.assessments[0].text = '違います。'; },
      (b: typeof original) => { b.assessments[0].corrections = [{ goal: '说职业', original: '会社員', corrected: task.answer, explanation: '再练。', grammarId: getLesson(50)!.grammar[0].id }]; },
    ]) {
      const backup = structuredClone(original); mutate(backup);
      expect((await app.inject({ method: 'POST', url: '/api/restore', payload: { backup } })).statusCode).toBe(400);
      expect((await app.inject('/api/backup')).json().assessments).toEqual(expected);
    }
  });
});
