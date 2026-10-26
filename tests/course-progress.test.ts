import { describe, expect, it } from 'vitest';
import { vocabularyForLesson } from '../src/content/vocabulary';
import { courseCardTier, type LessonProgress } from '../src/shared/course-progress';
import type { Progress } from '../src/shared/types';
import { createPractice } from './practice-fixtures';

const stages = ['vocabulary', 'understand', 'listen', 'speak'] as const;
const adjustment = (lessonId: number, stage: Progress['stage'], score: number): Progress => ({
  lessonId, stage, cursor: 0, status: 'seen', updatedAt: '2026-10-25T00:00:00.000Z', manualProgress: { score, baselineCount: 0 },
});

describe('course progress', () => {
  it('returns all 50 fresh lessons in one read-only request', async () => {
    const { app } = createPractice();
    const before = (await app.inject('/api/backup')).json();
    const response = await app.inject('/api/course-progress');
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(Array.from({ length: 50 }, (_, i) => ({ lessonId: i + 1, score: 0 })));
    const after = (await app.inject('/api/backup')).json();
    expect({ ...after, exportedAt: before.exportedAt }).toEqual(before);
  });

  it('averages the four existing module scores and preserves manual progress', async () => {
    const { app } = createPractice();
    const backup = (await app.inject('/api/backup')).json();
    backup.progress = [27, 28, 29].flatMap(id => stages.map(stage => adjustment(id, stage, 70)));
    backup.progress.push(...stages.map((stage, i) => adjustment(30, stage, [0, 20, 40, 60][i])));
    expect((await app.inject({ method: 'POST', url: '/api/restore', payload: { backup } })).statusCode).toBe(200);
    const values = (await app.inject('/api/course-progress')).json<LessonProgress[]>();
    for (const lessonId of [27, 28, 29]) expect(values.find(item => item.lessonId === lessonId)).toEqual({ lessonId, score: 70 });
    expect(values.find(item => item.lessonId === 30)).toEqual({ lessonId: 30, score: 30 });
    expect(values.find(item => item.lessonId === 26)).toEqual({ lessonId: 26, score: 0 });
  });

  it('keeps an unfinished unit below diamond and displays a small gain above zero', async () => {
    const { app } = createPractice();
    const backup = (await app.inject('/api/backup')).json();
    backup.progress = stages.flatMap((stage, i) => [adjustment(1, stage, i === 3 ? 99 : 100), adjustment(2, stage, 100), adjustment(3, stage, i === 3 ? 1 : 0)]);
    expect((await app.inject({ method: 'POST', url: '/api/restore', payload: { backup } })).statusCode).toBe(200);
    const values = (await app.inject('/api/course-progress')).json<LessonProgress[]>();
    expect(values.find(item => item.lessonId === 1)?.score).toBe(99.8);
    expect(values.find(item => item.lessonId === 2)?.score).toBe(100);
    expect(values.find(item => item.lessonId === 3)?.score).toBe(0.3);
  });

  it('updates after a real word is marked as mastered and matches the module detail', async () => {
    const { app } = createPractice();
    const word = vocabularyForLesson(27).words[0];
    expect((await app.inject({ method: 'PATCH', url: `/api/lessons/27/vocabulary/${word.id}/mastery`, payload: { mastered: true } })).statusCode).toBe(200);
    const detail = (await app.inject('/api/ai-practice/mastery?lessonId=27')).json().modules;
    const values = (await app.inject('/api/course-progress')).json<LessonProgress[]>();
    expect(values.find(item => item.lessonId === 27)?.score).toBe(0.5);
    expect(values.find(item => item.lessonId === 27)?.score).toBe(detail.vocabulary.score / 4);
    expect(values.find(item => item.lessonId === 28)?.score).toBe(0);
    expect((await app.inject({ method: 'PATCH', url: `/api/lessons/27/vocabulary/${word.id}/mastery`, payload: { mastered: false } })).statusCode).toBe(200);
    expect((await app.inject('/api/course-progress')).json<LessonProgress[]>().find(item => item.lessonId === 27)?.score).toBe(0);
  });

  it.each([
    [0, 'locked'], [0.3, 'bronze'], [29.9, 'bronze'], [30, 'silver'], [69.9, 'silver'], [70, 'gold'], [99.8, 'gold'], [100, 'diamond'],
  ] as const)('assigns %s%% to %s', (score, tier) => {
    expect(courseCardTier(score)).toBe(tier);
  });
});
