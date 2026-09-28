import { describe, expect, it } from 'vitest';
import { lessons1 } from '../src/content/lessons-01-25.js';

describe('original volume I curriculum integrity', () => {
  it('contains every lesson exactly once with only earlier prerequisites', () => {
    expect(lessons1.map(l => l.id)).toEqual(Array.from({ length: 25 }, (_, i) => i + 1));
    for (const l of lessons1) {
      expect(l.volume).toBe(1);
      expect(l.prerequisiteLessonIds.every(p => p > 0 && p < l.id)).toBe(true);
    }
  });
  it('has usable learning tasks and no dangling or duplicate identifiers', () => {
    const ids: string[] = [];
    for (const l of lessons1) {
      expect(l.vocabulary.length).toBeGreaterThanOrEqual(10);
      expect(l.grammar.length).toBeGreaterThanOrEqual(3);
      expect(l.speaking.length).toBeGreaterThanOrEqual(6);
      expect(l.listening.length).toBeGreaterThanOrEqual(2);
      expect(l.scenarios.length).toBeGreaterThanOrEqual(2);
      const gs = new Set(l.grammar.map(g => g.id));
      for (const g of l.grammar) expect(g.examples.length).toBeGreaterThanOrEqual(2);
      for (const s of l.speaking) expect(gs.has(s.grammarId)).toBe(true);
      expect(new Set(l.speaking.map(s => s.grammarId))).toEqual(gs);
      for (const d of l.listening) {
        expect(d.lines.length).toBeGreaterThanOrEqual(4);
        expect(d.options).toHaveLength(3);
        expect(Number.isInteger(d.answer) && d.answer >= 0 && d.answer < 3).toBe(true);
        expect(d.grammarIds.every(id => gs.has(id))).toBe(true);
      }
      for (const s of l.scenarios) {
        expect(s.targetGrammarIds.every(id => gs.has(id))).toBe(true);
        expect(s.successCriteria.length).toBeGreaterThanOrEqual(2);
      }
      ids.push(...[...l.grammar, ...l.listening, ...l.speaking, ...l.scenarios].map(x => x.id));
      const examples = [...l.grammar.flatMap(g => g.examples), ...l.vocabulary.map(v => v.example), ...l.listening.flatMap(d => d.lines), ...l.speaking.map(s => s.answer), ...l.scenarios.map(s => s.opening)];
      for (const e of examples) {
        expect(e.jp.trim().length).toBeGreaterThan(0);
        expect(e.zh.trim().length).toBeGreaterThan(0);
        expect(e.kana).toMatch(/[ぁ-んァ-ン]/u);
        expect(e.kana).not.toMatch(/[一-龯]/u);
      }
    }
    expect(new Set(ids).size).toBe(ids.length);
  });
  it('keeps initial teaching language within beginner sentence patterns', () => {
    const initial = lessons1.slice(0, 6).flatMap(l => [...l.grammar.flatMap(g => g.examples), ...l.listening.flatMap(d => d.lines)]);
    for (const e of initial) expect(e.jp).not.toMatch(/ことができ|と思い|なければ|てもいい|ている|ています|かったです/u);
  });
  it('retains the requested anchor lessons and their practical distinctions', () => {
    expect(lessons1[0]!.grammar.map(g => g.title).join(' ')).toContain('不是');
    expect(lessons1[13]!.grammar.map(g => g.title)).toEqual(['て形与请求', '正在进行', '主动帮忙']);
    expect(lessons1[13]!.scenarios[0]!.successCriteria.join(' ')).toContain('重复');
    expect(lessons1[24]!.grammar.map(g => g.title)).toEqual(['如果……', '做完以后就', '即使……也……']);
    const rain = lessons1[24]!.listening[0]!;
    expect(rain.options[rain.answer]).toBe('公园');
  });
});
