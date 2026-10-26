import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../src/server/app';
import { deploymentConfig } from '../src/server/deployment';
import { authEnvironment } from './auth-fixture';
import { checkReleaseAuth } from '../scripts/check-release-auth.mjs';

const root = 'https://study.example.com', token = 'proxy-token-test-only-'.repeat(3);
const deployment = deploymentConfig({ DEPLOYMENT: 'web', APP_PUBLIC_ORIGIN: root, APP_PROXY_TOKEN: token, ...authEnvironment });
const headers = { host: 'study.example.com', origin: root, 'x-nihongo-proxy': token };
const dirs: string[] = [], apps: ReturnType<typeof buildApp>[] = [];
function create(dataDir = mkdtempSync(join(tmpdir(), 'nihongo-auth-')), authVersion = 'test-1') {
  if (!dirs.includes(dataDir)) dirs.push(dataDir);
  const app = buildApp({ deployment, dataDir, authVersion }); apps.push(app); return { app, dataDir };
}
afterEach(async () => { for (const app of apps.splice(0)) await app.close(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
describe('persistent release-bound login', () => {
  it('verifies the deployed auth boundary over real HTTP with the exact proxy Host', async () => {
    const { app } = create();
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const options = { origin: root, proxyToken: token, username: authEnvironment.APP_AUTH_USER, passwordHash: authEnvironment.APP_AUTH_HASH, version: 'test-1', port: Number(new URL(address).port) };
    expect(await checkReleaseAuth(options)).toEqual({ version: 'test-1', protected: true, internalHealth: true });
    await expect(checkReleaseAuth({ ...options, version: 'wrong' })).rejects.toThrow('verification failed');
    await expect(checkReleaseAuth({ ...options, proxyToken: 'wrong' })).rejects.toThrow('verification failed');
  });
  it('requires authentication, persists across restart and invalidates on release/rollback', async () => {
    const first = create();
    expect((await first.app.inject({ url: '/api/bootstrap', headers })).statusCode).toBe(401);
    const login = await first.app.inject({ method: 'POST', url: '/api/auth/login', headers, payload: { username: 'learner', password: 'fixture-password-only' } });
    expect(login.statusCode).toBe(200);
    const raw = String(login.headers['set-cookie']);
    expect(raw).toContain('HttpOnly'); expect(raw).toContain('Secure'); expect(raw).toContain('SameSite=Strict'); expect(raw).toContain('Max-Age=31536000');
    const cookie = raw.split(';')[0];
    expect((await first.app.inject({ url: '/api/bootstrap', headers: { ...headers, cookie } })).statusCode).toBe(200);
    await first.app.close(); apps.splice(apps.indexOf(first.app), 1);
    const restart = create(first.dataDir);
    expect((await restart.app.inject({ url: '/api/bootstrap', headers: { ...headers, cookie } })).statusCode).toBe(200);
    await restart.app.close(); apps.splice(apps.indexOf(restart.app), 1);
    const updated = create(first.dataDir, 'test-2');
    expect((await updated.app.inject({ url: '/api/bootstrap', headers: { ...headers, cookie } })).statusCode).toBe(401);
    await updated.app.close(); apps.splice(apps.indexOf(updated.app), 1);
    const rollback = create(first.dataDir);
    expect((await rollback.app.inject({ url: '/api/bootstrap', headers: { ...headers, cookie } })).statusCode).toBe(401);
  });
  it('rejects wrong passwords, throttles attempts and still requires trusted origin/proxy', async () => {
    const { app } = create();
    for (let i = 0; i < 5; i++) expect((await app.inject({ method: 'POST', url: '/api/auth/login', headers, payload: { username: 'learner', password: 'wrong' } })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/api/auth/login', headers, payload: { username: 'learner', password: 'fixture-password-only' } })).statusCode).toBe(429);
    expect((await app.inject({ method: 'POST', url: '/api/auth/login', headers: { ...headers, origin: 'https://evil.example' }, payload: {} })).statusCode).toBe(403);
    expect((await app.inject({ url: '/api/auth/status' })).statusCode).toBe(403);
  });
  it('logout revokes the cookie and missing auth config fails closed', async () => {
    const { app, dataDir } = create();
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', headers, payload: { username: 'learner', password: 'fixture-password-only' } });
    const cookie = String(login.headers['set-cookie']).split(';')[0];
    expect((await app.inject({ method: 'POST', url: '/api/auth/logout', headers: { ...headers, cookie }, payload: {} })).statusCode).toBe(200);
    expect((await app.inject({ url: '/api/bootstrap', headers: { ...headers, cookie } })).statusCode).toBe(401);
    expect((await app.inject({ url: '/vocabulary-audio/example.wav', headers })).statusCode).toBe(401);
    await app.close(); apps.splice(apps.indexOf(app), 1);
    const missing = buildApp({ dataDir, deployment: deploymentConfig({ DEPLOYMENT: 'web', APP_PUBLIC_ORIGIN: root, APP_PROXY_TOKEN: token }) }); apps.push(missing);
    expect((await missing.inject({ url: '/api/bootstrap', headers })).statusCode).toBe(401);
  });
});
