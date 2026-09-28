import { describe, expect, it } from 'vitest';
import { lessons2 } from '../src/content/lessons-26-50';

describe('初级 II 原创课程完整性', () => {
  it('覆盖第 26—50 课，并且所有前置课都早于本课', () => {
    expect(lessons2.map(l => l.id)).toEqual(Array.from({ length: 25 }, (_, i) => i + 26));
    for (const lesson of lessons2) {
      expect(lesson.volume).toBe(2);
      expect(lesson.prerequisiteLessonIds.every(id => id > 0 && id < lesson.id)).toBe(true);
    }
  });

  it.each(lessons2)('第 $id 课有实际词卡、可听文本、提取任务与有效引用', lesson => {
    expect(lesson.vocabulary.length).toBeGreaterThanOrEqual(10);
    expect(new Set(lesson.vocabulary.map(v => v.word)).size).toBe(lesson.vocabulary.length);
    expect(lesson.grammar.length).toBeGreaterThanOrEqual(3);
    expect(lesson.listening).toHaveLength(2);
    expect(lesson.speaking).toHaveLength(6);
    expect(lesson.scenarios).toHaveLength(2);
    const grammarIds = new Set(lesson.grammar.map(g => g.id));
    const examples = [
      ...lesson.grammar.flatMap(g => g.examples),
      ...lesson.vocabulary.map(v => v.example),
      ...lesson.listening.flatMap(l => l.lines),
      ...lesson.speaking.map(s => s.answer),
      ...lesson.scenarios.map(s => s.opening),
    ];
    for (const example of examples) {
      expect(example.jp.length).toBeGreaterThan(3);
      expect(example.kana.length).toBeGreaterThan(3);
      expect(example.zh.length).toBeGreaterThan(2);
      expect(example.kana).not.toMatch(/[\u3400-\u9fff]/);
      expect(example.jp).not.toMatch(/TODO|placeholder|示例文本/);
    }
    for (const grammar of lesson.grammar) {
      expect(grammar.examples.length).toBeGreaterThanOrEqual(2);
      expect(grammar.pattern.length).toBeGreaterThan(0);
      expect(lesson.speaking.some(task => task.grammarId === grammar.id)).toBe(true);
    }
    for (const item of lesson.listening) {
      expect(item.lines.length).toBeGreaterThanOrEqual(4);
      expect(item.options).toHaveLength(3);
      expect(new Set(item.options).size).toBe(3);
      expect(item.answer).toBeGreaterThanOrEqual(0);
      expect(item.answer).toBeLessThan(3);
      expect(item.grammarIds.every(id => grammarIds.has(id))).toBe(true);
    }
    for (const item of lesson.scenarios) {
      expect(item.targetGrammarIds.every(id => grammarIds.has(id))).toBe(true);
      expect(item.successCriteria.length).toBeGreaterThanOrEqual(2);
      expect(item.setting).toContain('AI');
    }
    const ids = [...lesson.grammar, ...lesson.listening, ...lesson.speaking, ...lesson.scenarios].map(x => x.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.every(id => id.startsWith(`l${lesson.id}-`))).toBe(true);
  });

  it('重点课次没有错位，听说练习保留关键的语法区分', () => {
    const titles = (id: number) => lessons2.find(l => l.id === id)!.grammar.map(g => g.title).join(' ');
    const expected: [number, string][] = [
      [26, 'んです'], [27, '可能形'], [28, 'ながら'], [29, '自动词'], [30, 'てあります'],
      [31, '意向形'], [32, 'かもしれません'], [33, '命令形'], [34, 'とおり'], [35, 'ば：'],
      [36, 'ように'], [37, '受身'], [38, 'のは'], [39, 'ので'], [40, 'かどうか'],
      [41, 'いただきます'], [42, 'ために'], [43, '看起来'], [44, 'すぎます'], [45, '場合'],
      [46, 'ところ'], [47, '听说'], [48, '使役'], [49, '尊敬'], [50, '谦让'],
    ];
    for (const [id, text] of expected) expect(titles(id)).toContain(text);
    expect(titles(43)).not.toContain('听说');
    expect(titles(47)).toContain('ようです');
    expect(titles(49)).not.toContain('谦让');
    expect(lessons2.find(l => l.id === 49)!.scenarios[1].opening.jp).toContain('予約したい');
  });
});
