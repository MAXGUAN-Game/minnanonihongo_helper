import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'nihongo-audit-test-')); roots.push(root);
  const source = join(root, 'source'), scratch = join(root, 'scratch');
  mkdirSync(source); mkdirSync(scratch);
  return { root, source, scratch };
}
function snapshot(source: string) {
  return Object.fromEntries(readdirSync(source).sort().map(file => [file, readFileSync(join(source, file)).toString('base64')]));
}
function audit(value: ReturnType<typeof fixture>) {
  return spawnSync(process.execPath, [resolve('scripts/check-progress-integrity.mjs')], {
    encoding: 'utf8', windowsHide: true,
    env: { ...process.env, DATA_DIR: value.source, TMPDIR: value.scratch, TMP: value.scratch, TEMP: value.scratch },
  });
}
describe('deployment progress audit', () => {
  it('reads a cleanly closed WAL database without creating sidecars in the source', () => {
    const value = fixture();
    const db = new Database(join(value.source, 'nihongo.sqlite'));
    db.pragma('journal_mode = WAL');
    db.exec("CREATE TABLE progress (id TEXT PRIMARY KEY, value TEXT); INSERT INTO progress VALUES ('lesson-1', 'historical-progress')");
    db.close();
    const before = snapshot(value.source);
    expect(Object.keys(before)).toEqual(['nihongo.sqlite']);
    const result = audit(value);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).progress.count).toBe(1);
    expect(result.stdout).not.toContain('historical-progress');
    expect(snapshot(value.source)).toEqual(before);
    expect(readdirSync(value.scratch)).toEqual([]);
  });
  it('includes committed records still in WAL, with no SHM, and leaves every source byte unchanged', () => {
    const value = fixture();
    const live = join(value.root, 'live.sqlite');
    const db = new Database(live);
    try {
      db.pragma('journal_mode = WAL');
      db.pragma('wal_autocheckpoint = 0');
      db.exec('CREATE TABLE attempts (id TEXT PRIMARY KEY, value TEXT); CREATE TABLE secrets (id INTEGER PRIMARY KEY, api_key TEXT)');
      db.pragma('wal_checkpoint(TRUNCATE)');
      db.exec("INSERT INTO attempts VALUES ('second-question', 'correct'); INSERT INTO secrets VALUES (1, 'fixture-secret-never-log')");
      copyFileSync(live, join(value.source, 'nihongo.sqlite'));
      copyFileSync(live + '-wal', join(value.source, 'nihongo.sqlite-wal'));
    } finally { db.close(); }
    const before = snapshot(value.source);
    expect(Object.keys(before)).toEqual(['nihongo.sqlite', 'nihongo.sqlite-wal']);
    const result = audit(value);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).attempts).toEqual({ count: 1,
      sha256: createHash('sha256').update(JSON.stringify([{ id: 'second-question', value: 'correct' }])).digest('hex') });
    expect(JSON.parse(result.stdout).secrets.count).toBe(1);
    expect(result.stdout + result.stderr).not.toContain('fixture-secret-never-log');
    expect(snapshot(value.source)).toEqual(before);
    expect(readdirSync(value.scratch)).toEqual([]);
    expect(audit(value).stdout).toBe(result.stdout);
  });
  it.each(['missing', 'corrupt'])('fails closed for a %s database and removes the temporary copy', kind => {
    const value = fixture();
    if (kind === 'corrupt') writeFileSync(join(value.source, 'nihongo.sqlite'), 'invalid database fixture');
    const before = snapshot(value.source);
    const result = audit(value);
    expect(result.status).not.toBe(0); expect(result.stdout).toBe('');
    expect(snapshot(value.source)).toEqual(before);
    expect(readdirSync(value.scratch)).toEqual([]);
  });
});
