import { z } from 'zod';
import type { Example, Grammar, Lesson } from './types';

export const specialTopicSchema = z.enum(['time', 'date', 'count', 'number', 'price']);
export type SpecialTopic = z.infer<typeof specialTopicSchema>;
export const specialTopics = [
  { id: 'time', zh: '时分', ja: '時刻', description: '具体时分、几点到几点' },
  { id: 'date', zh: '年月日', ja: '年月日', description: '年份、月份、日期与日期范围' },
  { id: 'count', zh: '个数', ja: '個数', description: '几个、多少个与数量范围' },
  { id: 'number', zh: '数字', ja: '数字', description: '整数与数字范围' },
  { id: 'price', zh: '价格', ja: '値段', description: '日元金额与价格范围' },
] as const;
export const topicInfo = (topic: SpecialTopic) => specialTopics.find(item => item.id === topic)!;
export const specialGrammar = (topic: SpecialTopic): Grammar => ({ id: `special:${topic}`, title: topicInfo(topic).zh,
  explanation: '只表达目标短语，不要求完整句子。准确保留数字、单位和范围；接受等价汉字、数字和假名写法。',
  pattern: ['专项短语，不需要补成句子', topicInfo(topic).description, '数值、单位及范围必须准确'], examples: [] });
export const specialLesson = (topic: SpecialTopic): Lesson => ({ id: 0, volume: 1, title: `专项练习 · ${topicInfo(topic).zh}`,
  canDo: topicInfo(topic).description, prerequisiteLessonIds: [], grammar: [specialGrammar(topic)], vocabulary: [], listening: [], speaking: [], scenarios: [] });
export function practicePositionKey(value: { lessonId: number; kind: string; topic?: SpecialTopic; review?: true }) {
  return value.review ? 'review:current' : `${value.topic ? `special:${value.topic}` : value.lessonId}:${value.kind}`;
}
export function validPracticeScope(value: { lessonId: number; topic?: SpecialTopic; review?: true; kind?: string }) {
  if (value.review) return !value.topic && value.lessonId === 0 && (!value.kind || ['dictation','dialogue','speaking'].includes(value.kind));
  return value.topic ? value.lessonId === 0 && (!value.kind || ['dictation', 'speaking'].includes(value.kind)) : value.lessonId >= 1 && value.lessonId <= 50;
}

const digits = ['', 'いち', 'に', 'さん', 'よん', 'ご', 'ろく', 'なな', 'はち', 'きゅう'];
export function numberReading(n: number): string {
  if (!Number.isInteger(n) || n < 0 || n >= 100000000) throw new Error('Number outside practice range');
  if (!n) return 'ゼロ';
  if (n >= 10000) return numberReading(Math.floor(n / 10000)) + 'まん' + (n % 10000 ? numberReading(n % 10000) : '');
  let result = '';
  const thousands = Math.floor(n / 1000), hundreds = Math.floor(n % 1000 / 100), tens = Math.floor(n % 100 / 10);
  if (thousands) result += thousands === 1 ? 'せん' : thousands === 3 ? 'さんぜん' : thousands === 8 ? 'はっせん' : digits[thousands] + 'せん';
  if (hundreds) result += hundreds === 1 ? 'ひゃく' : hundreds === 3 ? 'さんびゃく' : hundreds === 6 ? 'ろっぴゃく' : hundreds === 8 ? 'はっぴゃく' : digits[hundreds] + 'ひゃく';
  if (tens) result += (tens === 1 ? '' : digits[tens]) + 'じゅう';
  return result + digits[n % 10];
}
export function timePhrase(hour: number, minute: number): Example {
  const hours = ['れい', 'いち', 'に', 'さん', 'よ', 'ご', 'ろく', 'しち', 'はち', 'く', 'じゅう', 'じゅういち', 'じゅうに'];
  const minutes = ['じゅっぷん', 'いっぷん', 'にふん', 'さんぷん', 'よんぷん', 'ごふん', 'ろっぷん', 'ななふん', 'はっぷん', 'きゅうふん'];
  const reading = minute % 10 === 0 ? (minute === 10 ? '' : digits[Math.floor(minute / 10)]) + 'じゅっぷん'
    : (minute >= 10 ? numberReading(Math.floor(minute / 10) * 10) : '') + minutes[minute % 10];
  return { jp: `${hour}時${minute ? `${minute}分` : ''}`, kana: hours[hour] + 'じ' + (minute ? reading : ''), zh: `${hour}点${minute ? `${minute}分` : ''}` };
}
const monthReadings = ['いち', 'に', 'さん', 'し', 'ご', 'ろく', 'しち', 'はち', 'く', 'じゅう', 'じゅういち', 'じゅうに'];
const dayReadings: Record<number, string> = { 1: 'ついたち', 2: 'ふつか', 3: 'みっか', 4: 'よっか', 5: 'いつか', 6: 'むいか', 7: 'なのか', 8: 'ようか', 9: 'ここのか', 10: 'とおか', 14: 'じゅうよっか', 20: 'はつか', 24: 'にじゅうよっか' };
const dayReading = (n: number) => dayReadings[n] || numberReading(n).replace(/なな$/, 'しち').replace(/きゅう$/, 'く') + 'にち';
const range = (a: Example, b: Example): Example => ({ jp: `${a.jp}から${b.jp}まで`, kana: `${a.kana}から${b.kana}まで`, zh: `${a.zh}到${b.zh}` });
const banks = new Map<SpecialTopic, Example[]>();
export function specialBank(topic: SpecialTopic): Example[] {
  const cached = banks.get(topic); if (cached) return cached;
  const items: Example[] = [];
  if (topic === 'time') {
    for (let h = 1; h <= 12; h++) for (let m = 0; m < 60; m++) items.push(timePhrase(h, m));
    for (let h = 1; h < 12; h++) for (const m of [0, 5, 15, 30, 40, 45, 55]) items.push(range(timePhrase(h, m), timePhrase(h + 1, (m + 15) % 60)));
    for (const prefix of [{ jp: '午前', kana: 'ごぜん', zh: '上午' }, { jp: '午後', kana: 'ごご', zh: '下午' }])
      for (let h = 1; h <= 11; h++) for (const m of [0, 10, 20, 30, 40, 50]) { const a = timePhrase(h, m); items.push({ jp: prefix.jp + a.jp, kana: prefix.kana + a.kana, zh: prefix.zh + a.zh }); }
  } else if (topic === 'date') {
    for (let year = 1990; year <= 2040; year++) items.push({ jp: `${year}年`, kana: numberReading(year).replace(/よん$/, 'よ') + 'ねん', zh: `${year}年` });
    for (let month = 1; month <= 12; month++) {
      const a = { jp: `${month}月`, kana: monthReadings[month - 1] + 'がつ', zh: `${month}月` }; items.push(a);
      const days = new Date(Date.UTC(2024, month, 0)).getUTCDate();
      for (let day = 1; day <= days; day++) {
        const b = { jp: `${day}日`, kana: dayReading(day), zh: `${day}日` };
        items.push({ jp: a.jp + b.jp, kana: a.kana + b.kana, zh: a.zh + b.zh });
        if (day <= 28 && day % 7 === 0) items.push({ jp: `2026年${a.jp}${b.jp}`, kana: 'にせんにじゅうろくねん' + a.kana + b.kana, zh: `2026年${a.zh}${b.zh}` });
        if (day < days && day % 5 === 0) items.push(range({ jp: a.jp + b.jp, kana: a.kana + b.kana, zh: a.zh + b.zh }, { jp: `${month}月${day + 1}日`, kana: a.kana + dayReading(day + 1), zh: `${month}月${day + 1}日` }));
      }
    }
    for (let day = 1; day <= 31; day++) items.push({ jp: `${day}日`, kana: dayReading(day), zh: `${day}日` });
  } else if (topic === 'count') {
    const readings = ['ひとつ', 'ふたつ', 'みっつ', 'よっつ', 'いつつ', 'むっつ', 'ななつ', 'やっつ', 'ここのつ', 'とお'];
    readings.forEach((kana, i) => items.push({ jp: i === 9 ? 'とお' : '一二三四五六七八九'[i] + 'つ', kana, zh: `${i + 1}个（通用数法）` }));
    for (let n = 1; n <= 99; n++) {
      const tail = n % 10;
      const kana = tail === 0 ? (n === 10 ? '' : digits[n / 10]) + 'じゅっこ' : (n >= 10 ? numberReading(Math.floor(n / 10) * 10) : '') + ({ 1: 'いっこ', 6: 'ろっこ', 8: 'はっこ' }[tail] || digits[tail] + 'こ');
      items.push({ jp: `${n}個`, kana, zh: `${n}个（用「個」计数）` });
    }
  } else {
    const numbers = [...new Set([0, ...Array.from({ length: 100 }, (_, i) => i + 1), ...Array.from({ length: 99 }, (_, i) => (i + 1) * 100), 101, 111, 305, 608, 808, 1234, 3456, 7890, 10000, 15000, 23000, 58000, 100000, 123456, 1000000])];
    for (const n of numbers.sort((a, b) => a - b)) items.push({ jp: `${n}${topic === 'price' ? '円' : ''}`, kana: numberReading(n) + (topic === 'price' ? 'えん' : ''), zh: `${n}${topic === 'price' ? '日元' : ''}` });
  }
  if (['count', 'number', 'price'].includes(topic)) {
    const singles = items.filter(item => !item.zh.includes('通用'));
    for (let i = 0; i < singles.length - 1; i += 4) items.push(range(singles[i], singles[i + 1]));
  }
  banks.set(topic, items); return items;
}
