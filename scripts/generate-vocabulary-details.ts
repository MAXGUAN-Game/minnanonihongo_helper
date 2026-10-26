// Offline editorial generation. Credentials are read-only; learning data is never changed.
import Database from 'better-sqlite3';
import { mkdirSync, readFileSync, existsSync, writeFileSync, renameSync } from 'node:fs';
import { resolve } from 'node:path';
import { vocabularyForLesson } from '../src/content/vocabulary';
import { vocabularyDetailSchema, type VocabularyDetail } from '../src/shared/vocabulary-details';

const root = resolve('src/content/vocabulary-details');
mkdirSync(root, { recursive: true });
const db = new Database(resolve(process.env.CONTENT_DATA_DIR || 'data', 'nihongo.sqlite'), { readonly: true });
const key = process.env.DEEPSEEK_API_KEY || (db.prepare('SELECT api_key FROM secrets WHERE id=1').get() as { api_key: string } | undefined)?.api_key;
const settings = JSON.parse((db.prepare('SELECT value FROM settings WHERE id=1').get() as { value: string }).value);
db.close();
if (!key) throw new Error('Missing content-generation credential');
let next = Number(process.env.FIRST_LESSON || 1);
const last = Number(process.env.LAST_LESSON || 50);
let failed = false;
async function lesson(id: number) {
  const file = resolve(root, `${String(id).padStart(2, '0')}.json`);
  const saved: Record<string, VocabularyDetail> = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  const words = vocabularyForLesson(id).words.filter(w => !vocabularyDetailSchema.safeParse(saved[w.id]).success);
  for (let offset = 0; offset < words.length; offset += 12) {
    const batch = words.slice(offset, offset + 12);
    let done = false;
    for (let retry = 0; retry < 3 && !done; retry++) {
      try {
        const response = await fetch('https://api.deepseek.com/chat/completions', { method: 'POST', signal: AbortSignal.timeout(180000),
          headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: settings.model || 'deepseek-flash', thinking: { type: 'disabled' }, response_format: { type: 'json_object' }, temperature: .2, max_tokens: 10000,
            messages: [{ role: 'system', content: `你是日语教材词典编辑。为给出的每个词生成准确、原创的中文学习详情，结合本课词义，不改变词条。仅返回JSON对象，键必须为输入id，值恰好为{romaji,attributes,explanation,example:{jp,kana,romaji,zh}}。romaji采用一致的赫本式ASCII罗马音；例句romaji分词。attributes只可含自动词、他动词、自他两用、い形容词、な形容词；名词等用[]；逐词判断具体义项，不按词尾猜，自他两用时用该单一标签。explanation用1至3句中文说明此义的实际用法、搭配、语体或易混点，不能只重复词义。example只给一个自然简短的初学者例句，必须实际使用该词（允许合理变形），专名也用自然例句；jp为正常日语，kana为全句假名读音（无汉字），zh为准确中文。例句不可只写“这是某某”机械套模板。不要增加字段或省略词条。` },
              { role: 'user', content: JSON.stringify({ lessonId: id, words: batch.map(({ id, word, reading, meaning, partOfSpeech }) => ({ id, word, reading, meaning, partOfSpeech })) }) }] }) });
        if (!response.ok) throw new Error(`provider HTTP ${response.status}`);
        const result = await response.json() as any;
        if (result.choices?.[0]?.finish_reason !== 'stop') throw new Error('incomplete provider response');
        const parsed = JSON.parse(result.choices[0].message.content);
        const additions: Record<string, VocabularyDetail> = {};
        for (const word of batch) additions[word.id] = vocabularyDetailSchema.parse(parsed[word.id]);
        Object.assign(saved, additions);
        writeFileSync(file + '.tmp', JSON.stringify(saved, null, 2) + '\n'); renameSync(file + '.tmp', file);
        console.log(`lesson ${id}: ${Object.keys(saved).length} details`); done = true;
      } catch (error) {
        console.log(`lesson ${id} batch ${offset}: retry ${retry + 1} (${error instanceof Error && error.message.startsWith('provider HTTP') ? error.message : 'generation/validation failed'})`);
        if (retry < 2) await new Promise(r => setTimeout(r, 2000 * (retry + 1)));
      }
    }
    if (!done) { failed = true; return; }
  }
}
await Promise.all(Array.from({ length: 6 }, async () => { while (next <= last) { const id = next++; await lesson(id); } }));
if (failed) process.exitCode = 1;
