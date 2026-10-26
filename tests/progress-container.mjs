// Real Linux container regression: read-only root and production data mount,
// writable tmpfs only. No production database, credentials or server is used.
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';

const root = mkdtempSync(join(tmpdir(), 'nihongo-container-audit-'));
const image = 'nihongo-audit-regression:local';
const run = args => execFileSync('docker', args, { encoding: 'utf8' });
try {
  execFileSync('docker', ['build', '-t', image, '-f', '-', '.'], { stdio: ['pipe', 'inherit', 'inherit'], input: `
FROM node:24-bookworm
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY scripts/check-progress-integrity.mjs ./scripts/check-progress-integrity.mjs
USER node
ENTRYPOINT ["node", "scripts/check-progress-integrity.mjs"]
` });
  run(['run', '--rm', '--user', `${process.getuid()}:${process.getgid()}`, '-v', `${root}:/fixture`, '--entrypoint', 'node', image, '--input-type=module', '-e', `
import Database from 'better-sqlite3';
import { mkdirSync, copyFileSync, unlinkSync } from 'node:fs';
for (const name of ['clean', 'wal']) {
  mkdirSync('/fixture/'+name);
  const path='/fixture/'+name+'/nihongo.sqlite';
  const db=new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('wal_autocheckpoint = 0');
  db.exec('CREATE TABLE progress (id TEXT PRIMARY KEY, value TEXT)');
  db.pragma('wal_checkpoint(TRUNCATE)');
  db.exec("INSERT INTO progress VALUES ('lesson-1', 'preserve-latest-progress')");
  if (name==='wal') {
    copyFileSync(path, '/fixture/main-copy');
    copyFileSync(path+'-wal', '/fixture/wal-copy');
    db.close();
    copyFileSync('/fixture/main-copy', path);
    copyFileSync('/fixture/wal-copy', path+'-wal');
    unlinkSync('/fixture/main-copy'); unlinkSync('/fixture/wal-copy');
  } else db.close();
}
`]);
  for (const name of ['clean', 'wal']) {
    const source = join(root, name);
    for (const file of readdirSync(source)) chmodSync(join(source, file), 0o444);
    const snapshot = () => Object.fromEntries(readdirSync(source).sort().map(file => [file, createHash('sha256').update(readFileSync(join(source, file))).digest('hex')]));
    const before = snapshot();
    const args = ['run', '--rm', '--network', 'none', '--read-only', '-v', `${source}:/app/data:ro`];
    const legacy = spawnSync('docker', [...args, '--entrypoint', 'node', image, '--input-type=module', '-e', `import Database from 'better-sqlite3'; const db=new Database('/app/data/nihongo.sqlite',{readonly:true}); db.prepare('SELECT * FROM progress').all();`], { encoding: 'utf8' });
    assert.notEqual(legacy.status, 0, 'Old read-only audit must reproduce the failure');
    assert.match(legacy.stderr, /SQLITE_CANTOPEN|SQLITE_READONLY/);
    const result = JSON.parse(run([...args, '--tmpfs', '/tmp:rw,nosuid,nodev,noexec,mode=1777', '-e', 'DATA_DIR=/app/data', image]));
    assert.equal(result.progress.count, 1);
    assert.equal(result.progress.sha256, createHash('sha256').update(JSON.stringify([{ id: 'lesson-1', value: 'preserve-latest-progress' }])).digest('hex'));
    assert.deepEqual(snapshot(), before);
    console.log('PASS: old audit fails, new audit preserves read-only ' + name + ' database and reads latest committed progress');
  }
} finally { rmSync(root, { recursive: true, force: true }); }
