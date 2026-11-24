import { z } from 'zod';
import { kanaItems } from './kana';
import { katakanaToHiragana } from './katakana-words';
export function validKatakanaAnswer(value: { mode: 'kana' | 'ai'; prompt: string; answer: string }) {
  const valid = value.mode === 'kana' ? kanaItems.some(item => item.katakana === value.prompt) : /^[ァ-ヶ][ァ-ヶー]{1,39}$/.test(value.prompt);
  return valid && [value.prompt, katakanaToHiragana(value.prompt)].includes(value.answer.trim());
}
export const rankTiers = [
  { id: 'iron', zh: '黑铁', ja: 'アイアン', start: 0, end: 30 },
  { id: 'bronze', zh: '青铜', ja: 'ブロンズ', start: 30, end: 60 },
  { id: 'silver', zh: '白银', ja: 'シルバー', start: 60, end: 150 },
  { id: 'gold', zh: '黄金', ja: 'ゴールド', start: 150, end: 300 },
  { id: 'diamond', zh: '钻石', ja: 'ダイヤモンド', start: 300, end: 500 },
  { id: 'prismatic', zh: '棱彩', ja: 'プリズマ', start: 500, end: Infinity },
] as const;
export function practiceRank(value: number) {
  const count = Number.isFinite(value) ? Math.max(0, value) : 0;
  const tier = rankTiers.find(tier => count < tier.end) ?? rankTiers[5];
  if (tier.id === 'prismatic') return { ...tier, count, division: null, progress: 100, next: null };
  const step = (tier.end - tier.start) / 5;
  const index = Math.min(4, Math.floor((count - tier.start) / step));
  return { ...tier, count, division: 5 - index, progress: 100 * (count - tier.start - index * step) / step, next: tier.start + (index + 1) * step };
}
export const practiceCreditSchema = z.discriminatedUnion('type', [
  z.object({ id: z.uuid(), type: z.literal('skip'), questionId: z.uuid(), createdAt: z.iso.datetime({ offset: true }) }).strict().refine(value => value.id === value.questionId),
  z.object({ id: z.uuid(), type: z.literal('katakana'), mode: z.enum(['kana', 'ai']), prompt: z.string().min(1).max(40), answer: z.string().min(1).max(40), createdAt: z.iso.datetime({ offset: true }) }).strict().refine(validKatakanaAnswer),
]);
export type PracticeCredit = z.infer<typeof practiceCreditSchema>;
