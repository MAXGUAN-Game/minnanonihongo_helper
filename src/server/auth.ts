import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type Database from 'better-sqlite3';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { compare } from 'bcryptjs';
import { z } from 'zod';
import type { Deployment } from './deployment';
import { ApiError } from './schemas';

const release = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version as string;
const cookieName = '__Host-nihongo-session';
const maxAge = 365 * 24 * 60 * 60;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
export function registerAuth(app: FastifyInstance, db: Database.Database, deployment: Deployment, version = release) {
  db.exec(`CREATE TABLE IF NOT EXISTS auth_sessions (id TEXT PRIMARY KEY, version TEXT NOT NULL, expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS auth_release (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL);`);
  // Persist the release boundary: even rolling back cannot revive old cookies.
  const config = deployment.mode === 'web' ? deployment.auth : undefined;
  const boundary = hash(JSON.stringify([version, config?.username, config?.passwordHash]));
  db.transaction(() => {
    const previous = db.prepare('SELECT value FROM auth_release WHERE id=1').get() as { value: string } | undefined;
    if (previous?.value !== boundary) {
      db.prepare('DELETE FROM auth_sessions').run();
      db.prepare('INSERT OR REPLACE INTO auth_release (id,value) VALUES (1,?)').run(boundary);
    }
    db.prepare('DELETE FROM auth_sessions WHERE expires <= ?').run(Date.now());
  })();
  const failures = new Map<string, { count: number; until: number }>();
  function cookie(request: FastifyRequest) {
    const raw = request.headers.cookie?.split(';').map(s => s.trim()).find(s => s.startsWith(cookieName + '='))?.slice(cookieName.length + 1);
    return raw && /^[a-f0-9]{64}$/.test(raw) ? raw : undefined;
  }
  function setCookie(reply: FastifyReply, token: string, age = maxAge) {
    reply.header('Set-Cookie', `${cookieName}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${age}`);
  }
  function authenticated(request: FastifyRequest, reply: FastifyReply) {
    if (deployment.mode === 'local') return true;
    if (!config) return false;
    const token = cookie(request); if (!token) return false;
    const found = db.prepare('SELECT expires FROM auth_sessions WHERE id=? AND version=?').get(hash(token), boundary) as { expires: number } | undefined;
    if (!found || found.expires <= Date.now()) return false;
    if (found.expires < Date.now() + (maxAge - 86400) * 1000) {
      db.prepare('UPDATE auth_sessions SET expires=? WHERE id=?').run(Date.now() + maxAge * 1000, hash(token)); setCookie(reply, token);
    }
    return true;
  }
  const publicApis = new Set(['/api/auth/status', '/api/auth/login', '/api/auth/logout']);
  app.addHook('onRequest', async (request, reply) => {
    if (deployment.mode === 'local') return;
    let path: string;
    try { path = decodeURIComponent(new URL(request.url, 'http://internal').pathname); }
    catch { throw new ApiError(400, 'INVALID_PATH', '请求路径不正确。'); }
    if (path === '/api/health' && !request.headers['x-nihongo-client-ip']) return;
    // Only the login shell/assets are public. APIs and bundled audio are protected.
    if ((!path.startsWith('/api/') && !path.startsWith('/vocabulary-audio/')) || publicApis.has(path)) return;
    if (!authenticated(request, reply)) throw new ApiError(401, 'AUTH_REQUIRED', '请验证网站密码。');
  });
  app.get('/api/auth/status', async (request, reply) => ({ authenticated: authenticated(request, reply), required: deployment.mode === 'web', version }));
  app.post('/api/auth/login', async (request, reply) => {
    const input = z.object({ username: z.string().trim().min(1).max(64), password: z.string().min(1).max(200) }).strict().parse(request.body);
    if (deployment.mode === 'local') return { authenticated: true, version };
    if (!config) throw new ApiError(503, 'AUTH_NOT_CONFIGURED', '服务器登录配置未迁移，请完成发布配置。');
    const ip = String(request.headers['x-nihongo-client-ip'] || request.ip);
    const now = Date.now();
    for (const [key, value] of failures) if (value.until <= now) failures.delete(key);
    const limit = failures.get(ip);
    if (limit && limit.count >= 5) { reply.header('Retry-After', String(Math.ceil((limit.until - now) / 1000))); throw new ApiError(429, 'AUTH_RATE_LIMIT', '尝试过于频繁，请稍后重试。'); }
    // Reserve the attempt before bcrypt, so concurrent requests cannot bypass the limit.
    if (failures.size >= 10000 && !limit) throw new ApiError(429, 'AUTH_RATE_LIMIT', '尝试过于频繁，请稍后重试。');
    failures.set(ip, { count: (limit?.count || 0) + 1, until: limit?.until || now + 15 * 60 * 1000 });
    const matches = await compare(input.password, config.passwordHash);
    if (!matches || input.username !== config.username) throw new ApiError(401, 'AUTH_INVALID', '用户名或密码不正确。');
    failures.delete(ip);
    const token = randomBytes(32).toString('hex');
    db.prepare('INSERT INTO auth_sessions (id,version,expires) VALUES (?,?,?)').run(hash(token), boundary, now + maxAge * 1000);
    setCookie(reply, token); return { authenticated: true, version };
  });
  app.post('/api/auth/logout', async (request, reply) => {
    const token = cookie(request); if (token) db.prepare('DELETE FROM auth_sessions WHERE id=?').run(hash(token));
    setCookie(reply, '', 0); return { authenticated: false };
  });
}
