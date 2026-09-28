import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Progress, ReviewItem, Session, Settings } from '../shared/types';
import type { Attempt, Backup } from './schemas';

const defaults: Omit<Settings, 'hasApiKey'> = { currentLessonId: 1, dailyMinutes: 15, largeText: true, furigana: true, autoplay: false, model: 'deepseek-flash', setupComplete: false };
type Table = 'progress' | 'attempts' | 'reviews' | 'sessions';
export class Store {
  readonly db: Database.Database;
  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.db = new Database(join(dataDir, 'nihongo.sqlite'));
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.exec(`CREATE TABLE IF NOT EXISTS settings (id INTEGER PRIMARY KEY CHECK (id=1), value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS secrets (id INTEGER PRIMARY KEY CHECK (id=1), api_key TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS progress (id TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS attempts (id TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS reviews (id TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, value TEXT NOT NULL);`);
    this.db.prepare('INSERT OR IGNORE INTO settings (id,value) VALUES (1,?)').run(JSON.stringify(defaults));
  }
  getKey(): string { return (this.db.prepare('SELECT api_key FROM secrets WHERE id=1').get() as { api_key: string } | undefined)?.api_key ?? ''; }
  setKey(key: string) { this.db.prepare('INSERT INTO secrets (id,api_key) VALUES (1,?) ON CONFLICT(id) DO UPDATE SET api_key=excluded.api_key').run(key); }
  settings(): Settings { return { ...defaults, ...JSON.parse((this.db.prepare('SELECT value FROM settings WHERE id=1').get() as { value: string }).value), hasApiKey: Boolean(this.getKey()) }; }
  saveSettings(value: Omit<Settings, 'hasApiKey'> | Settings) { const { hasApiKey: _, ...safe } = value as Settings; this.db.prepare('UPDATE settings SET value=? WHERE id=1').run(JSON.stringify(safe)); }
  all<T>(table: Table): T[] { return (this.db.prepare(`SELECT value FROM ${table} ORDER BY rowid`).all() as { value: string }[]).map(row => JSON.parse(row.value) as T); }
  get<T>(table: Table, id: string): T | undefined { const row = this.db.prepare(`SELECT value FROM ${table} WHERE id=?`).get(id) as { value: string } | undefined; return row ? JSON.parse(row.value) as T : undefined; }
  save<T>(table: Table, id: string, value: T) { this.db.prepare(`INSERT INTO ${table} (id,value) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value`).run(id, JSON.stringify(value)); }
  backup(): Backup {
    const { hasApiKey: _, ...settings } = this.settings();
    return { version: 1, exportedAt: new Date().toISOString(), settings, progress: this.all<Progress>('progress'), attempts: this.all<Attempt>('attempts'), reviews: this.all<ReviewItem>('reviews'), sessions: this.all<Session>('sessions') };
  }
  restore(backup: Backup) {
    this.db.transaction(() => {
      for (const table of ['progress', 'attempts', 'reviews', 'sessions'] as const) this.db.prepare(`DELETE FROM ${table}`).run();
      this.saveSettings(backup.settings);
      for (const value of backup.progress) this.save('progress', `${value.lessonId}:${value.stage}`, value);
      for (const value of backup.attempts) this.save('attempts', value.id, value);
      for (const value of backup.reviews) this.save('reviews', value.id, value);
      for (const value of backup.sessions) this.save('sessions', value.id, value);
    })();
  }
  close() { this.db.close(); }
}
