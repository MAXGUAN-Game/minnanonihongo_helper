import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { hashSync } from 'bcryptjs';
export const authEnvironment = { APP_AUTH_USER: 'learner', APP_AUTH_HASH: hashSync('fixture-password-only', 4) };
const token = 'ab'.repeat(32);
export const authCookie = `__Host-nihongo-session=${token}`;
export function seedAuthSession(dataDir: string) {
  const db = new Database(join(dataDir, 'nihongo.sqlite'));
  const boundary = (db.prepare('SELECT value FROM auth_release WHERE id=1').get() as { value: string }).value;
  db.prepare('INSERT OR REPLACE INTO auth_sessions (id,version,expires) VALUES (?,?,?)').run(createHash('sha256').update(token).digest('hex'), boundary, Date.now() + 86400000);
  db.close();
}
