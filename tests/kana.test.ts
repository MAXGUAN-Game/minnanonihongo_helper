import { describe, expect, it } from 'vitest';
import { kanaItems, shuffledKana } from '../src/shared/kana';
describe('katakana practice pool', () => {
  it('contains 104 unique modern kana pairs including contracted syllables', () => {
    expect(kanaItems).toHaveLength(104);
    expect(new Set(kanaItems.map(item => item.katakana)).size).toBe(104);
    expect(kanaItems).toContainEqual({ hiragana: 'きゃ', katakana: 'キャ' });
    expect(kanaItems).toContainEqual({ hiragana: 'ぱ', katakana: 'パ' });
    expect(kanaItems).not.toContainEqual({ hiragana: 'てぃ', katakana: 'ティ' });
  });
  it('covers the entire pool in each cycle without repeating at the boundary', () => {
    const previous = shuffledKana(undefined, () => .5)[0].hiragana;
    const next = shuffledKana(previous, () => .5);
    expect(next[0].hiragana).not.toBe(previous);
    expect(new Set(next.map(item => item.hiragana))).toEqual(new Set(kanaItems.map(item => item.hiragana)));
  });
});
