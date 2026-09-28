import { afterEach, describe, expect, it, vi } from 'vitest';
import fastifyStatic from '@fastify/static';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { buildApp, type AppOptions } from '../src/server/app';
import { deploymentConfig } from '../src/server/deployment';
import { getLesson } from '../src/content';

const publicOrigin = 'https://japanese.example.com';
const publicHost = 'japanese.example.com';
const proxyToken = 'deployment-test-proxy-token-1234567890';
const environment = { DEPLOYMENT: 'web', APP_PUBLIC_ORIGIN: publicOrigin, APP_PROXY_TOKEN: proxyToken };
const web = deploymentConfig(environment);
const apps: ReturnType<typeof buildApp>[] = [];
const directories: string[] = [];
function headers(origin: string | undefined = undefined): Record<string, string> {
  return { host: publicHost, 'x-nihongo-proxy': proxyToken, ...(origin !== undefined ? { origin } : {}) };
}
function create(options: AppOptions = {}) {
  const dataDir = options.dataDir ?? mkdtempSync(join(tmpdir(), 'nihongo-deployment-test-'));
  if (!directories.includes(dataDir)) directories.push(dataDir);
  const app = buildApp({ ...options, dataDir }); apps.push(app);
  return { app, dataDir };
}
async function addStaticFixture(app: ReturnType<typeof buildApp>, dataDir: string) {
  const root = join(dataDir, 'public');
  mkdirSync(join(root, 'assets'), { recursive: true });
  writeFileSync(join(root, 'index.html'), '<h1>protected learning application</h1>');
  writeFileSync(join(root, 'assets', 'application.js'), 'window.protectedLearningApplication = true;');
  await app.register(fastifyStatic, { root, prefix: '/', index: 'index.html', list: false, dotfiles: 'deny' });
}
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  vi.restoreAllMocks();
  for (const directory of directories.splice(0)) {
    if (!resolve(directory).startsWith(resolve(tmpdir(), 'nihongo-deployment-test-'))) throw new Error('Unexpected deployment test directory');
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('explicit deployment configuration', () => {
  it('defaults to local loopback and permits the IPv6 loopback explicitly', () => {
    expect(deploymentConfig({})).toEqual({ mode: 'local', host: '127.0.0.1' });
    expect(deploymentConfig({ HOST: '::1' })).toEqual({ mode: 'local', host: '::1' });
  });
  it('refuses public bindings or proxy configuration unless web mode is explicit', () => {
    for (const env of [
      { HOST: '0.0.0.0' }, { HOST: '192.168.1.20' }, { HOST: '::' },
      { APP_PUBLIC_ORIGIN: publicOrigin }, { APP_PROXY_TOKEN: proxyToken },
    ]) expect(() => deploymentConfig(env)).toThrow('Public access requires');
    expect(() => deploymentConfig({ DEPLOYMENT: 'production' })).toThrow('DEPLOYMENT');
  });
  it('requires a canonical HTTPS origin without credentials, paths, queries or fragments', () => {
    for (const origin of [undefined, '', 'not-an-origin', 'http://japanese.example.com', 'https://localhost',
      'https://japanese.example.com/', 'https://japanese.example.com/study', 'https://japanese.example.com?x=1',
      'https://japanese.example.com#study', 'https://learner:password@japanese.example.com', 'https://JAPANESE.example.com',
      'https://japanese.example.com:443']) {
      expect(() => deploymentConfig({ ...environment, APP_PUBLIC_ORIGIN: origin })).toThrow('APP_PUBLIC_ORIGIN');
    }
  });
  it('rejects missing, short, oversized or malformed proxy tokens', () => {
    for (const token of [undefined, '', 'short', 'a'.repeat(31), 'a'.repeat(129), 'a'.repeat(31) + ' ', 'a'.repeat(31) + ':']) {
      expect(() => deploymentConfig({ ...environment, APP_PROXY_TOKEN: token })).toThrow('APP_PROXY_TOKEN');
    }
    expect(deploymentConfig({ ...environment, APP_PROXY_TOKEN: 'a'.repeat(32) }).mode).toBe('web');
    expect(deploymentConfig({ ...environment, APP_PROXY_TOKEN: 'a'.repeat(128) }).mode).toBe('web');
  });
  it('returns the exact public host and only supports intentional bind addresses', () => {
    expect(web).toMatchObject({ mode: 'web', host: '0.0.0.0', origin: publicOrigin, publicHost, proxyToken });
    expect(deploymentConfig({ ...environment, HOST: '127.0.0.1' }).host).toBe('127.0.0.1');
    expect(deploymentConfig({ ...environment, APP_PUBLIC_ORIGIN: publicOrigin + ':8443' })).toMatchObject({ publicHost: publicHost + ':8443', origin: publicOrigin + ':8443' });
    for (const host of ['localhost', '192.168.1.20', '::', 'attacker.example.com']) expect(() => deploymentConfig({ ...environment, HOST: host })).toThrow('HOST');
  });
});

describe('proxy boundary and cross-origin protection', () => {
  it('keeps the existing local application usable without a proxy or Origin header', async () => {
    const { app } = create();
    expect((await app.inject('/api/bootstrap')).json().deployment).toBe('local');
    expect((await app.inject('/api/health')).json()).toMatchObject({ ok: true, pid: process.pid, root: process.cwd() });
    const saved = await app.inject({ method: 'PATCH', url: '/api/settings', payload: { currentLessonId: 25 } });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().currentLessonId).toBe(25);
    expect((await app.inject({ url: '/api/settings', headers: { host: publicHost } })).json().code).toBe('LOCAL_ONLY');
    expect((await app.inject({ url: '/api/settings', headers: { host: 'localhost:4317', origin: 'https://attacker.example.com' } })).statusCode).toBe(403);
  });
  it('protects real static files, health and API routes before returning their contents', async () => {
    const { app, dataDir } = create({ deployment: web });
    await addStaticFixture(app, dataDir);
    for (const url of ['/', '/assets/application.js', '/api/health', '/api/bootstrap', '/api/backup', '/api/voice/settings', '/missing-file']) {
      for (const token of [undefined, 'wrong', 'x'.repeat(proxyToken.length), proxyToken + ',' + proxyToken]) {
        const response = await app.inject({ url, headers: { host: publicHost, ...(token !== undefined ? { 'x-nihongo-proxy': token } : {}) } });
        expect(response.statusCode, url).toBe(403);
        expect(response.json().code).toBe('PROXY_REQUIRED');
        expect(response.body).not.toContain(proxyToken);
        expect(response.headers['cache-control']).toBe('no-store');
      }
    }
    expect((await app.inject({ url: '/', headers: headers() })).body).toContain('protected learning application');
    expect((await app.inject({ url: '/assets/application.js', headers: headers() })).body).toContain('window.protectedLearningApplication');
  });
  it('requires the exact configured Host even when proxy or forwarded headers look valid', async () => {
    const { app } = create({ deployment: web });
    for (const host of ['localhost:4317', '127.0.0.1:4317', 'attacker.example.com', publicHost + '.attacker.example.com', publicHost + ':8443']) {
      const response = await app.inject({ url: '/api/health', headers: { ...headers(), host, 'x-forwarded-host': publicHost, 'x-forwarded-proto': 'https' } });
      expect(response.statusCode).toBe(403);
      expect(response.json().code).toBe('PROXY_REQUIRED');
    }
    const passwordOnly = await app.inject({ url: '/api/settings', headers: { host: publicHost, authorization: 'Basic bGVhcm5lcjpwYXNzd29yZA==' } });
    expect(passwordOnly.statusCode).toBe(403);
  });
  it('allows safe navigation without Origin but rejects a foreign or opaque Origin', async () => {
    const { app } = create({ deployment: web });
    for (const method of ['GET', 'HEAD'] as const) {
      expect((await app.inject({ method, url: '/api/health', headers: headers() })).statusCode).toBe(200);
      expect((await app.inject({ method, url: '/api/health', headers: headers(publicOrigin) })).statusCode).toBe(200);
      for (const origin of ['null', 'https://attacker.example.com', 'http://japanese.example.com', publicOrigin + ':8443', publicOrigin + '.attacker.example.com']) {
        expect((await app.inject({ method, url: '/api/health', headers: headers(origin) })).statusCode).toBe(403);
      }
    }
  });
  it('rejects unsafe requests with absent, opaque or different Origins before changing settings', async () => {
    const { app } = create({ deployment: web });
    for (const origin of [undefined, 'null', '', 'https://attacker.example.com', publicOrigin + ':8443', publicOrigin + '/']) {
      const response = await app.inject({ method: 'PATCH', url: '/api/settings', headers: headers(origin), payload: { apiKey: 'sk-fixture-not-a-real-key', currentLessonId: 50 } });
      expect(response.statusCode).toBe(403);
      expect(response.json().code).toBe('ORIGIN_REJECTED');
    }
    expect((await app.inject({ url: '/api/settings', headers: headers() })).json()).toMatchObject({ currentLessonId: 1, hasApiKey: false });
  });
  it('does not let invalid proxy credentials mutate settings even with a legitimate Origin', async () => {
    const { app } = create({ deployment: web });
    const response = await app.inject({ method: 'PATCH', url: '/api/settings', headers: { host: publicHost, origin: publicOrigin }, payload: { currentLessonId: 50, apiKey: 'sk-fixture-not-a-real-key' } });
    expect(response.statusCode).toBe(403);
    expect(response.json().code).toBe('PROXY_REQUIRED');
    expect((await app.inject({ url: '/api/settings', headers: headers() })).json()).toMatchObject({ currentLessonId: 1, hasApiKey: false });
  });
  it('persists legitimate same-origin updates and omits deployment secrets from browser data', async () => {
    const first = create({ deployment: web });
    const fakeKey = 'sk-deployment-fixture-never-contact-provider';
    const saved = await first.app.inject({ method: 'PATCH', url: '/api/settings', headers: headers(publicOrigin), payload: { currentLessonId: 27, setupComplete: true, apiKey: fakeKey } });
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toMatchObject({ currentLessonId: 27, hasApiKey: true });
    await first.app.close(); apps.splice(apps.indexOf(first.app), 1);
    const second = create({ deployment: web, dataDir: first.dataDir });
    const bootstrap = await second.app.inject({ url: '/api/bootstrap', headers: headers() });
    expect(bootstrap.json()).toMatchObject({ deployment: 'web', settings: { currentLessonId: 27, setupComplete: true, hasApiKey: true } });
    const health = await second.app.inject({ url: '/api/health', headers: headers() });
    expect(health.json()).toEqual({ ok: true, app: 'nihongo-small-steps' });
    for (const response of [saved, bootstrap, health, await second.app.inject({ url: '/api/backup', headers: headers() })]) {
      expect(response.body).not.toContain(fakeKey);
      expect(response.body).not.toContain(proxyToken);
      expect(response.body).not.toContain('proxyToken');
    }
  });
  it('blocks unauthorized paid operations without a provider request or conversation write', async () => {
    const externalFetch = vi.fn<typeof fetch>().mockRejectedValue(new Error('A provider must not be contacted by this test.'));
    const { app } = create({ deployment: web, aiFetch: externalFetch, voiceFetch: externalFetch });
    await app.inject({ method: 'PATCH', url: '/api/settings', headers: headers(publicOrigin), payload: { apiKey: 'sk-fake-deployment-test' } });
    await app.inject({ method: 'PATCH', url: '/api/voice/settings', headers: headers(publicOrigin), payload: { provider: 'minimax', apiKey: 'sk-fake-voice-test' } });
    const lesson = getLesson(1)!;
    const created = await app.inject({ method: 'POST', url: '/api/sessions', headers: headers(publicOrigin), payload: { lessonId: 1, scenarioId: lesson.scenarios[0]!.id } });
    expect(created.statusCode).toBe(200);
    const session = created.json();
    const turn = await app.inject({ method: 'POST', url: `/api/sessions/${session.id}/turn`, headers: { host: publicHost, origin: publicOrigin }, payload: { text: '学生です。', usedHint: false, clientTurnId: 'unauthorized-test-turn' } });
    expect(turn.statusCode).toBe(403);
    const audio = await app.inject({ method: 'POST', url: '/api/voice/synthesize', headers: headers('https://attacker.example.com'), payload: { text: 'こんにちは。', rate: 1, speaker: 'primary' } });
    expect(audio.statusCode).toBe(403);
    expect(externalFetch).not.toHaveBeenCalled();
    expect((await app.inject({ url: `/api/sessions/${session.id}`, headers: headers() })).json()).toEqual(session);
  });
});
