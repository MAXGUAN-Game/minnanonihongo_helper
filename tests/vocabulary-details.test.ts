import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { vocabularyForLesson } from '../src/content/vocabulary';
import { vocabularyDetailSchema } from '../src/shared/vocabulary-details';
import { createPractice, configurePractice } from './practice-fixtures';

describe('bundled vocabulary details and runtime grammar', () => {
  it('ships a valid example and reviewed attributes for every stable entry', () => {
    let total = 0;
    for (let id = 1; id <= 50; id++) {
      const words = vocabularyForLesson(id).words; total += words.length;
      const review = JSON.parse(readFileSync(new URL(`../src/content/vocabulary-details-review/${String(id).padStart(2, '0')}.json`, import.meta.url), 'utf8'));
      expect(review.reviewedCount).toBe(words.length);
      for (const word of words) {
        const detail = vocabularyDetailSchema.parse(word.detail);
        expect(detail.example.kana, word.id).not.toMatch(/[\p{Script=Han}]/u);
        expect(detail.romaji + detail.example.romaji, word.id).not.toMatch(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u);
        if (word.partOfSpeech.startsWith('动词')) expect(detail.attributes.length, word.id).toBeGreaterThan(0);
      }
    }
    expect(total).toBe(2258);
  });
  it('reads details offline and analyzes only on explicit request, caching without changing progress', async () => {
    const { app, aiFetch } = createPractice(); await configurePractice(app);
    const word = vocabularyForLesson(1).words[0], path = `/api/lessons/1/vocabulary/${word.id}`;
    const before = (await app.inject('/api/backup')).json();
    expect((await app.inject(path)).json().detail).toEqual(word.detail); expect(aiFetch).not.toHaveBeenCalled();
    const grammar = { structure: '主题＋说明。', points: [{ expression: 'は', explanation: '提示主题。' }] };
    aiFetch.mockImplementation(async () => new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(grammar) } }] })));
    expect((await app.inject({ method: 'POST', url: path + '/grammar' })).json()).toEqual(grammar);
    expect((await app.inject({ method: 'POST', url: path + '/grammar' })).json()).toEqual(grammar);
    expect(aiFetch).toHaveBeenCalledTimes(1);
    expect({ ...(await app.inject('/api/backup')).json(), exportedAt: before.exportedAt }).toEqual(before);
    expect((await app.inject('/api/lessons/2/vocabulary/' + word.id)).statusCode).toBe(404);
  });
  it('serves bundled pronunciation without a provider and reports missing credentials explicitly', async () => {
    const { app } = createPractice();
    const word = vocabularyForLesson(1).words[0];
    const bundled = await app.inject(`/api/lessons/1/vocabulary/${word.id}/audio`);
    expect(bundled.statusCode).toBe(200); expect(bundled.rawPayload.subarray(0, 4).toString()).toBe('RIFF');
    const missing = vocabularyForLesson(50).words.at(-1)!;
    expect((await app.inject(`/api/lessons/50/vocabulary/${missing.id}/audio`)).json().code).toBe('VOICE_NOT_CONFIGURED');
  });
});
