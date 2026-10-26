import { vocabularyForLesson } from '../src/content/vocabulary';
import { vocabularyDetailSchema } from '../src/shared/vocabulary-details';
let total = 0;
const failures: string[] = [];
for (let lesson = 1; lesson <= 50; lesson++) {
  for (const word of vocabularyForLesson(lesson).words) {
    total++;
    const parsed = vocabularyDetailSchema.safeParse(word.detail);
    if (!parsed.success) { failures.push(`${word.id}: missing/invalid detail`); continue; }
    const detail = parsed.data;
    if (/[\p{Script=Han}]/u.test(detail.example.kana)) failures.push(`${word.id}: example kana contains kanji`);
    if (/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(detail.romaji + detail.example.romaji)) failures.push(`${word.id}: romanization contains Japanese characters`);
    if (detail.attributes.includes('自他两用') && (detail.attributes.includes('自动词') || detail.attributes.includes('他动词'))) failures.push(`${word.id}: conflicting transitivity`);
    if (word.partOfSpeech.startsWith('动词') && !detail.attributes.some(a => ['自动词', '他动词', '自他两用'].includes(a))) failures.push(`${word.id}: missing verb attribute`);
  }
}
if (total !== 2258) failures.push(`Unexpected vocabulary size: ${total}`);
if (failures.length) { console.error(failures.join('\n')); process.exitCode = 1; }
else console.log(`Validated ${total} vocabulary details across 50 lessons.`);
