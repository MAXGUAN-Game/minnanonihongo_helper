// Compare digests only. No keys or learning text are printed/exported.
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
const db = new Database(resolve(process.env.DATA_DIR || 'data', 'nihongo.sqlite'), { readonly: true });
const tables = ['progress', 'attempts', 'reviews', 'sessions', 'assessments', 'ai_questions', 'ai_attempts', 'ai_positions', 'vocabulary_mastery', 'settings', 'secrets', 'audio_settings', 'audio_secrets', 'voice_settings', 'voice_secrets'];
const result = {};
for (const table of tables) {
  if (!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table)) continue;
  const rows = db.prepare(`SELECT * FROM ${table} ORDER BY id`).all();
  result[table] = { count: rows.length, sha256: createHash('sha256').update(JSON.stringify(rows)).digest('hex') };
}
db.close(); console.log(JSON.stringify(result));
