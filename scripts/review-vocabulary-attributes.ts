import Database from 'better-sqlite3';
import { mkdirSync, readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import { vocabularyForLesson } from '../src/content/vocabulary';
import { vocabularyDetailSchema } from '../src/shared/vocabulary-details';
const directory = resolve('src/content/vocabulary-details-review'); mkdirSync(directory, { recursive: true });
const db = new Database(resolve(process.env.CONTENT_DATA_DIR || 'data', 'nihongo.sqlite'), { readonly: true });
const key = (db.prepare('SELECT api_key FROM secrets WHERE id=1').get() as { api_key: string }).api_key;
const model = JSON.parse((db.prepare('SELECT value FROM settings WHERE id=1').get() as { value: string }).value).model; db.close();
let next = 1, failed = false;
await Promise.all(Array.from({ length: 5 }, async () => {
  while (next <= 50) {
    const lesson = next++, name = `${String(lesson).padStart(2, '0')}.json`, auditFile = resolve(directory, name);
    if (existsSync(auditFile)) continue;
    const words = vocabularyForLesson(lesson).words;
    try {
      const response = await fetch('https://api.deepseek.com/chat/completions', { method: 'POST', signal: AbortSignal.timeout(120000),
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, thinking: { type: 'disabled' }, response_format: { type: 'json_object' }, max_tokens: 8000, temperature: 0,
          messages: [{ role: 'system', content: '你是严谨的日语辞典审校。逐条核查词义对应的词性特殊属性。输入是完整一课的词条和待审attributes。只返回需要修改的条目，不要重写正确的。返回JSON {corrections:[{id,attributes,reason}]}。attributes仅允许自动词、他动词、自他两用、い形容词、な形容词。所有动词（含する动词、活用形和动词表达）必须有且只有一个自他属性；根据具体词义和论元判断，不能依词尾猜。自他两用使用此单独标签；复合词要判断最后的谓语，移動の「を」不等于他动词。名词短语即使可加する，当前词性不是动词则不强加动词属性；な／い形容词标出适用属性。缺失的属性也必须补齐。reason给一句中文核对理由。' }, { role: 'user', content: JSON.stringify(words.map(w => ({ id: w.id, word: w.word, reading: w.reading, meaning: w.meaning, partOfSpeech: w.partOfSpeech, attributes: w.detail?.attributes }))) }] }) });
      if (!response.ok) throw new Error('request failed');
      const envelope = await response.json() as any;
      if (envelope.choices?.[0]?.finish_reason !== 'stop') throw new Error('truncated');
      const review = z.object({ corrections: z.array(z.object({ id: z.string(), attributes: vocabularyDetailSchema.shape.attributes, reason: z.string().min(1) })) }).parse(JSON.parse(envelope.choices[0].message.content));
      const file = resolve('src/content/vocabulary-details', name), data = JSON.parse(readFileSync(file, 'utf8'));
      for (const correction of review.corrections) { if (!words.some(w => w.id === correction.id)) throw new Error('invalid id'); data[correction.id].attributes = correction.attributes; }
      writeFileSync(file + '.tmp', JSON.stringify(data, null, 2) + '\n'); renameSync(file + '.tmp', file);
      writeFileSync(auditFile, JSON.stringify({ lessonId: lesson, model, reviewedCount: words.length, ...review }, null, 2) + '\n');
      console.log(`reviewed lesson ${lesson}: ${review.corrections.length} corrections`);
    } catch { failed = true; console.log(`review failed lesson ${lesson}; rerun to resume`); }
  }
}));
if (failed) process.exitCode = 1;
