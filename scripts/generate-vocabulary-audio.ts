import Database from 'better-sqlite3';
import { mkdirSync, existsSync, writeFileSync, renameSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { vocabularyForLesson } from '../src/content/vocabulary';
import { requestAudio } from '../src/server/voice';
import { DEFAULT_VOICE_SETTINGS } from '../src/shared/voice';

const directory = resolve('public/vocabulary-audio'); mkdirSync(directory, { recursive: true });
const db = new Database(resolve(process.env.CONTENT_DATA_DIR || 'data', 'nihongo.sqlite'), { readonly: true });
const key = process.env.MINIMAX_API_KEY || (db.prepare('SELECT api_key FROM voice_secrets WHERE id=1').get() as { api_key: string } | undefined)?.api_key;
db.close();
if (!key) throw new Error('Missing voice generation credential');
const words = Array.from({ length: 50 }, (_, i) => vocabularyForLesson(i + 1).words).flat();
const manifest: Record<string, { file: string; sha256: string }> = {};
// Same spelling with different readings must have different assets.
const unique = new Map(words.map(w => [w.reading, w]));
let count = 0, failed = 0;
for (const [reading] of unique) {
  const hash = createHash('sha256').update(`minimax:speech-2.8-hd:Japanese_KindLady:1:${reading}`).digest('hex');
  const file = `${hash}.wav`, path = resolve(directory, file);
  if (!existsSync(path)) {
    try {
      const audio = await requestAudio(fetch, DEFAULT_VOICE_SETTINGS, key, DEFAULT_VOICE_SETTINGS.voice, 1, reading);
      writeFileSync(path + '.tmp', audio); renameSync(path + '.tmp', path);
    } catch (error) {
      failed++; console.log(`audio unavailable at ${count}: ${(error as { code?: string }).code || 'request failed'}`);
      // Stop on quota/auth failures instead of repeatedly charging a failing service.
      break;
    }
  }
  const sha256 = createHash('sha256').update(readFileSync(path)).digest('hex');
  for (const word of words.filter(w => w.reading === reading)) manifest[word.id] = { file, sha256 };
  writeFileSync(resolve(directory, 'manifest.json.tmp'), JSON.stringify(manifest, null, 2) + '\n');
  renameSync(resolve(directory, 'manifest.json.tmp'), resolve(directory, 'manifest.json'));
  if (++count % 25 === 0) console.log(`audio ${count}/${unique.size}`);
}
console.log(`audio ready for ${Object.keys(manifest).length}/${words.length} entries; failures: ${failed}`);
if (failed) process.exitCode = 1;
