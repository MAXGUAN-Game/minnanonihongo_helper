// Caller must stop all database writers before this audit. Production is mounted
// read-only; SQLite recovery/SHM creation is allowed only on a disposable copy.
// Compare digests only. No keys or learning text are printed/exported.
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
const tables = ['progress', 'attempts', 'reviews', 'sessions', 'assessments', 'ai_questions', 'ai_attempts', 'ai_positions', 'vocabulary_mastery', 'settings', 'secrets', 'audio_settings', 'audio_secrets', 'voice_settings', 'voice_secrets'];
const temporary = mkdtempSync(join(tmpdir(), 'nihongo-progress-audit-'));
let db;
try {
  const source = resolve(process.env.DATA_DIR || 'data', 'nihongo.sqlite');
  const target = join(temporary, 'nihongo.sqlite');
  copyFileSync(source, target);
  chmodSync(target, 0o600);
  // WAL contains committed records that may not yet be in the main database.
  // SHM is an index: regenerate it locally rather than using stale shared locks.
  for (const suffix of ['-wal', '-journal']) {
    try { copyFileSync(source + suffix, target + suffix); chmodSync(target + suffix, 0o600); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  db = new Database(target, { fileMustExist: true });
  if (db.pragma('quick_check', { simple: true }) !== 'ok') throw new Error('Database integrity check failed.');
  const result = {};
  for (const table of tables) {
    if (!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table)) continue;
    const rows = db.prepare(`SELECT * FROM ${table} ORDER BY id`).all();
    result[table] = { count: rows.length, sha256: createHash('sha256').update(JSON.stringify(rows)).digest('hex') };
  }
  console.log(JSON.stringify(result));
} finally {
  try { db?.close(); }
  finally { rmSync(temporary, { recursive: true, force: true }); }
}
