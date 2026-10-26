import { withoutRecordingLinks } from './audio-retirement';
import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Progress, ReviewItem, Session, Settings } from '../shared/types';
import type { Attempt, Backup } from './schemas';
import type { RecordingMetadata, SpeakingAssessment } from '../shared/recordings';
import { DEFAULT_AUDIO_ASSESSMENT_SETTINGS, type AudioAssessmentSettings } from '../shared/audio-assessment';
import type { PracticeAttempt, PracticeKind, PracticePosition, PracticeQuestion } from '../shared/ai-practice';
import type { VocabularyMastery } from '../shared/vocabulary';
import { vocabularyMastery } from './vocabulary-mastery';
import { vocabularyForLesson } from '../content/vocabulary';

const defaults: Omit<Settings, 'hasApiKey'> = { currentLessonId: 1, dailyMinutes: 15, largeText: true, furigana: true, autoplay: true, model: 'deepseek-flash', setupComplete: false };
type Table = 'progress' | 'attempts' | 'reviews' | 'sessions' | 'recordings' | 'assessments' | 'ai_questions' | 'ai_attempts' | 'ai_positions' | 'vocabulary_mastery';
export class Store {
  readonly db: Database.Database;
  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.db = new Database(join(dataDir, 'nihongo.sqlite'));
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.exec(`CREATE TABLE IF NOT EXISTS settings (id INTEGER PRIMARY KEY CHECK (id=1), value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS secrets (id INTEGER PRIMARY KEY CHECK (id=1), api_key TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS audio_settings (id INTEGER PRIMARY KEY CHECK (id=1), value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS audio_secrets (id INTEGER PRIMARY KEY CHECK (id=1), api_key TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS progress (id TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS attempts (id TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS reviews (id TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS recordings (id TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS assessments (id TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS recording_files (id TEXT PRIMARY KEY, sha256 TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS ai_questions (id TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS ai_attempts (id TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS ai_positions (id TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS vocabulary_mastery (id TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS ai_fingerprints (hash TEXT PRIMARY KEY, question_id TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS ai_question_kind ON ai_questions(json_extract(value,'$.content.kind'));
      CREATE INDEX IF NOT EXISTS ai_attempt_question ON ai_attempts(json_extract(value,'$.questionId'));
      CREATE TABLE IF NOT EXISTS migrations (id TEXT PRIMARY KEY);`);
    this.db.prepare('INSERT OR IGNORE INTO settings (id,value) VALUES (1,?)').run(JSON.stringify(defaults));
    this.db.transaction(() => {
      if (!this.db.prepare('SELECT id FROM migrations WHERE id=?').get('v1.1-autoplay')) {
        this.saveSettings({ ...this.settings(), autoplay: true });
        this.db.prepare('INSERT INTO migrations (id) VALUES (?)').run('v1.1-autoplay');
      }
    })();
  }
  getKey(): string { return (this.db.prepare('SELECT api_key FROM secrets WHERE id=1').get() as { api_key: string } | undefined)?.api_key ?? ''; }
  setKey(key: string) { this.db.prepare('INSERT INTO secrets (id,api_key) VALUES (1,?) ON CONFLICT(id) DO UPDATE SET api_key=excluded.api_key').run(key); }
  getAudioKey(): string { return (this.db.prepare('SELECT api_key FROM audio_secrets WHERE id=1').get() as { api_key: string } | undefined)?.api_key ?? ''; }
  setAudioKey(key: string) { this.db.prepare('INSERT INTO audio_secrets (id,api_key) VALUES (1,?) ON CONFLICT(id) DO UPDATE SET api_key=excluded.api_key').run(key); }
  audioSettings(): AudioAssessmentSettings {
    const row = this.db.prepare('SELECT value FROM audio_settings WHERE id=1').get() as { value: string } | undefined;
    return { ...DEFAULT_AUDIO_ASSESSMENT_SETTINGS, ...(row ? JSON.parse(row.value) : {}), hasApiKey: Boolean(this.getAudioKey()) };
  }
  saveAudioSettings(value: AudioAssessmentSettings) {
    const { hasApiKey: _, ...safe } = value;
    this.db.prepare('INSERT INTO audio_settings (id,value) VALUES (1,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value').run(JSON.stringify(safe));
  }
  settings(): Settings { return { ...defaults, ...JSON.parse((this.db.prepare('SELECT value FROM settings WHERE id=1').get() as { value: string }).value), hasApiKey: Boolean(this.getKey()) }; }
  saveSettings(value: Omit<Settings, 'hasApiKey'> | Settings) { const { hasApiKey: _, ...safe } = value as Settings; this.db.prepare('UPDATE settings SET value=? WHERE id=1').run(JSON.stringify(safe)); }
  all<T>(table: Table): T[] { return (this.db.prepare(`SELECT value FROM ${table} ORDER BY rowid`).all() as { value: string }[]).map(row => JSON.parse(row.value) as T); }
  get<T>(table: Table, id: string): T | undefined { const row = this.db.prepare(`SELECT value FROM ${table} WHERE id=?`).get(id) as { value: string } | undefined; return row ? JSON.parse(row.value) as T : undefined; }
  save<T>(table: Table, id: string, value: T) { this.db.prepare(`INSERT INTO ${table} (id,value) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value`).run(id, JSON.stringify(value)); }
  recordingHash(id: string) { return (this.db.prepare('SELECT sha256 FROM recording_files WHERE id=?').get(id) as { sha256: string } | undefined)?.sha256; }
  vocabularyProgress(lessonId: number) {
    const content = vocabularyForLesson(lessonId);
    return { ...content, mastery: vocabularyMastery(content.words.map(word => word.id), this.all<PracticeQuestion>('ai_questions'), this.all<PracticeAttempt>('ai_attempts'), this.all<VocabularyMastery>('vocabulary_mastery').filter(mark => mark.lessonId === lessonId)) };
  }
  practiceQuestions(kind: PracticeKind, limit: number, grammarId?: string): PracticeQuestion[] {
    const filter = grammarId ? " AND json_extract(value,'$.grammarId')=?" : '';
    const args = grammarId ? [kind, grammarId, limit] : [kind, limit];
    return (this.db.prepare(`SELECT value FROM ai_questions WHERE json_extract(value,'$.content.kind')=?${filter} ORDER BY rowid DESC LIMIT ?`).all(...args) as { value: string }[]).map(row => JSON.parse(row.value));
  }
  practiceAttempts(questionId: string): PracticeAttempt[] {
    return (this.db.prepare("SELECT value FROM ai_attempts WHERE json_extract(value,'$.questionId')=? ORDER BY rowid").all(questionId) as { value: string }[]).map(row => JSON.parse(row.value));
  }
  practiceDuplicate(fingerprints: string[]): boolean { return fingerprints.some(hash => Boolean(this.db.prepare('SELECT hash FROM ai_fingerprints WHERE hash=?').get(hash))); }
  savePracticeFingerprints(question: PracticeQuestion) { for (const hash of question.fingerprints) this.db.prepare('INSERT INTO ai_fingerprints (hash,question_id) VALUES (?,?)').run(hash, question.id); }
  learnedLessonIds(): number[] {
    const ids = new Set<number>();
    for (const table of ['attempts', 'ai_attempts', 'assessments'] as const) {
      for (const item of this.all<{ lessonId: number }>(table)) ids.add(item.lessonId);
    }
    for (const session of this.all<Session>('sessions')) {
      if (session.turnCount > 0 && session.turns.some(turn => turn.role === 'user' && turn.text.trim())) ids.add(session.lessonId);
    }
    for (const progress of this.all<Progress>('progress')) {
      if (progress.status === 'assisted' || progress.status === 'independent') ids.add(progress.lessonId);
    }
    return [...ids].filter(id => Number.isInteger(id) && id >= 1 && id <= 50).sort((a, b) => a - b);
  }
  saveRecordingHash(id: string, hash: string) { this.db.prepare('INSERT INTO recording_files (id,sha256) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET sha256=excluded.sha256').run(id, hash); }
  backup(): Backup {
    const { hasApiKey: _, ...settings } = this.settings();
    return { version: 4, exportedAt: new Date().toISOString(), settings, progress: this.all<Progress>('progress'), attempts: this.all<Attempt>('attempts'), reviews: this.all<ReviewItem>('reviews'), sessions: this.all<Session>('sessions'), recordings: [], assessments: this.all<SpeakingAssessment>('assessments'), aiQuestions: this.all<PracticeQuestion>('ai_questions'), aiAttempts: this.all<PracticeAttempt>('ai_attempts'), aiPositions: this.all<PracticePosition>('ai_positions'), vocabularyMastery: this.all<VocabularyMastery>('vocabulary_mastery') };
  }
  restore(backup: Backup) {
    this.db.transaction(() => {
      for (const table of ['progress', 'attempts', 'reviews', 'sessions', 'recordings', 'assessments', 'recording_files', 'ai_questions', 'ai_attempts', 'ai_positions', 'ai_fingerprints', 'vocabulary_mastery'] as const) this.db.prepare(`DELETE FROM ${table}`).run();
      this.saveSettings(backup.settings);
      if ('vocabularyMastery' in backup) for (const value of backup.vocabularyMastery) this.save('vocabulary_mastery', value.wordId, value);
      for (const value of backup.progress) this.save('progress', `${value.lessonId}:${value.stage}`, value);
      for (const value of backup.attempts) this.save('attempts', value.id, withoutRecordingLinks(value));
      for (const value of backup.reviews) this.save('reviews', value.id, value);
      for (const value of backup.sessions) this.save('sessions', value.id, withoutRecordingLinks(value));
      if ('assessments' in backup) for (const value of backup.assessments) this.save('assessments', value.id, withoutRecordingLinks(value));
      if ('aiQuestions' in backup) {
        for (const value of backup.aiQuestions) { this.save('ai_questions', value.id, value); this.savePracticeFingerprints(value); }
        for (const value of backup.aiAttempts) this.save('ai_attempts', value.id, withoutRecordingLinks(value));
        for (const value of backup.aiPositions) this.save('ai_positions', `${value.lessonId}:${value.kind}`, value);
      }
    })();
  }
  close() { this.db.close(); }
}
