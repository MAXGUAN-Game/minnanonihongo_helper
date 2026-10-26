import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createPractice, configurePractice } from './practice-fixtures';
import { provider } from './recordings-fixtures';
import { katakanaToHiragana } from '../src/shared/katakana-words';

const words = [
  { word: 'バスケットボール', meaningZh: '篮球' }, { word: 'コーヒー', meaningZh: '咖啡' },
  { word: 'テレビ', meaningZh: '电视' }, { word: 'サッカー', meaningZh: '足球' }, { word: 'パン', meaningZh: '面包' },
];
describe('AI katakana words', () => {
  it('generates real AI batches on demand, deduplicates concurrent retries and converts small kana and long vowels', async () => {
    let calls = 0;
    const { app } = createPractice({ aiFetch: async () => { calls++; return provider({ words }); } });
    await configurePractice(app);
    expect(calls).toBe(0);
    const payload = { requestId: randomUUID(), recent: [], count: 5 };
    const responses = await Promise.all([1, 2].map(() => app.inject({ method: 'POST', url: '/api/katakana/words', payload })));
    responses.forEach(response => { expect(response.statusCode, response.body).toBe(200); expect(response.json().words).toEqual(words); });
    expect(calls).toBe(1); expect(katakanaToHiragana(words[0].word)).toBe('ばすけっとぼーる');
    expect(katakanaToHiragana('ティッシュ')).toBe('てぃっしゅ');
    const conflict = await app.inject({ method: 'POST', url: '/api/katakana/words', payload: { ...payload, recent: ['バス'] } });
    expect(conflict.statusCode).toBe(409);
    const resized = await app.inject({ method: 'POST', url: '/api/katakana/words', payload: { ...payload, count: 1 } });
    expect(resized.statusCode).toBe(409); expect(calls).toBe(1);
  });
  it('rejects repeated or invalid words and retries once without substituting fixed questions', async () => {
    let calls = 0;
    const { app } = createPractice({ aiFetch: async () => { calls++; return provider({ words: [{ word: '漢字', meaningZh: '汉字' }] }); } });
    await configurePractice(app);
    const response = await app.inject({ method: 'POST', url: '/api/katakana/words', payload: { requestId: randomUUID(), recent: [] } });
    expect(response.statusCode).toBe(502); expect(calls).toBe(2);
  });
  it('requests exactly the missing capacity and includes translations without course context', async () => {
    const contexts: Record<string, unknown>[] = [];
    const { app } = createPractice({ aiFetch: async (_url, init) => {
      const context = JSON.parse(JSON.parse(init!.body as string).messages[1].content);
      contexts.push(context); return provider({ words: words.slice(0, context.count) });
    } });
    await configurePractice(app);
    for (const count of [1, 3, 5]) {
      const requestId = randomUUID();
      const response = await app.inject({ method: 'POST', url: '/api/katakana/words', payload: { requestId, recent: ['バス'], count } });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toEqual({ words: words.slice(0, count) });
      expect(contexts.at(-1)).toEqual({ randomSeed: requestId, count, recent: ['バス'], retry: false });
    }
    for (const count of [0, 6, 10, 1.5]) expect((await app.inject({ method: 'POST', url: '/api/katakana/words', payload: { requestId: randomUUID(), recent: [], count } })).statusCode).toBe(400);
    expect(contexts).toHaveLength(3);
  });
  it.each(['missing meaning', 'wrong count', 'duplicate', 'recent'] as const)('rejects %s and permits retrying the same request after failure', async invalid => {
    let valid = false, calls = 0;
    const { app } = createPractice({ aiFetch: async () => {
      calls++;
      if (valid) return provider({ words: words.slice(0, 2) });
      return provider({ words: invalid === 'missing meaning' ? [{ word: words[0].word }, words[1]] : invalid === 'wrong count' ? words.slice(0, 1) : invalid === 'duplicate' ? [words[0], words[0]] : [{ word: 'バス', meaningZh: '巴士' }, words[0]] });
    } });
    await configurePractice(app);
    const payload = { requestId: randomUUID(), recent: ['バス'], count: 2 };
    expect((await app.inject({ method: 'POST', url: '/api/katakana/words', payload })).statusCode).toBe(502);
    expect(calls).toBe(2); valid = true;
    const response = await app.inject({ method: 'POST', url: '/api/katakana/words', payload });
    expect(response.statusCode, response.body).toBe(200); expect(response.json().words).toEqual(words.slice(0, 2)); expect(calls).toBe(3);
  });
  it('requires configuration without charging or fabricating a batch', async () => {
    let calls = 0;
    const { app } = createPractice({ aiFetch: async () => { calls++; return provider({ words }); } });
    const response = await app.inject({ method: 'POST', url: '/api/katakana/words', payload: { requestId: randomUUID(), recent: [] } });
    expect(response.statusCode).toBe(503); expect(calls).toBe(0);
  });
});
