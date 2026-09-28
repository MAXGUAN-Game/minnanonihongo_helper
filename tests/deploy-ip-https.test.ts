import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { EventEmitter } from 'node:events';
import { buildApp } from '../src/server/app';
import { deploymentConfig } from '../src/server/deployment';

const root = process.cwd();
const { patchEnv, patchCaddy, probeHttps } = await import(pathToFileURL(join(root, 'deploy/enable-ip-https.mjs')).href);
const ip = '8.133.242.232';
const origin = `https://${ip}`;
const token = 'ip-deployment-test-token-never-real-1234567890';
const fixtureEnv = [
  '# fixture only', 'APP_DOMAIN=jp.nbblearnjp.xyz', 'APP_AUTH_USER=fixture',
  "APP_AUTH_HASH='$2a$14$fixture-not-a-real-password'", `APP_PROXY_TOKEN=${token}`,
  'APP_UID=1000', 'APP_GID=1000', "ICP_NUMBER=''", '',
].join('\n');
const apps: ReturnType<typeof buildApp>[] = [];
const directories: string[] = [];

afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  for (const directory of directories.splice(0)) {
    if (!resolve(directory).startsWith(resolve(tmpdir(), 'nihongo-ip-https-test-'))) throw new Error('Unexpected test directory');
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('verification does not falsely announce a usable website', () => {
  it.each([
    [401, true, 'Basic realm="restricted"', true],
    [200, true, undefined, false],
    [403, true, undefined, false],
    [401, false, 'Basic realm="restricted"', false],
    [401, true, undefined, false],
  ])('checks status %s, trusted TLS %s, and the login challenge', async (status, authorized, challenge, expected) => {
    const get = vi.fn((_url, options, respond) => {
      expect(options).toEqual({ rejectUnauthorized: true });
      queueMicrotask(() => respond({ statusCode: status, socket: { authorized }, headers: { 'www-authenticate': challenge }, resume() {} }));
      return Object.assign(new EventEmitter(), { destroy: vi.fn() });
    });
    expect((await probeHttps(origin, { get })).ok).toBe(expected);
  });

  it('retains only a safe error code from a certificate failure', async () => {
    const get = () => {
      const request = Object.assign(new EventEmitter(), { destroy: vi.fn() });
      queueMicrotask(() => request.emit('error', Object.assign(new Error('fixture-sensitive-diagnostic'), { code: 'CERT_HAS_EXPIRED' })));
      return request;
    };
    expect(await probeHttps(origin, { get })).toEqual({ ok: false, reason: 'CERT_HAS_EXPIRED' });
  });

  it('ends a stalled connection without declaring success', async () => {
    const request = Object.assign(new EventEmitter(), { destroy: vi.fn() });
    expect(await probeHttps(origin, { get: () => request, timeoutMs: 10 })).toEqual({ ok: false, reason: 'TIMEOUT' });
    expect(request.destroy).toHaveBeenCalledOnce();
  });
});

describe('IP HTTPS migration helper', () => {
  it.each(['\n', '\r\n'])('preserves all credentials and other environment bytes with %j newlines', newline => {
    const before = fixtureEnv.replaceAll('\n', newline);
    expect(patchEnv(before, ip)).toBe(before.replace('APP_DOMAIN=jp.nbblearnjp.xyz', `APP_DOMAIN=${ip}`));
    expect(patchEnv(patchEnv(before, ip), ip)).toBe(patchEnv(before, ip));
  });

  it('rejects ambiguous or missing domain lines', () => {
    for (const input of ['APP_AUTH_USER=fixture\n', fixtureEnv + '\nAPP_DOMAIN=another.example.com\n']) {
      expect(() => patchEnv(input, ip)).toThrow();
    }
  });

  it('only adjusts certificate configuration and retains every protected route', () => {
    const before = readFileSync(join(root, 'deploy/Caddyfile'), 'utf8');
    const after = patchCaddy(before);
    expect(after).toContain('profile shortlived');
    expect(after).toContain('default_sni {$APP_DOMAIN}');
    expect(after).toContain('dir https://acme-v02.api.letsencrypt.org/directory');
    expect(after).toContain('disable_tlsalpn_challenge');
    expect(after.slice(after.indexOf('\tencode zstd gzip'))).toBe(before.slice(before.indexOf('\tencode zstd gzip')));
    expect(patchCaddy(after)).toBe(after);
  });

  it('refuses an unknown proxy configuration', () => {
    expect(() => patchCaddy('http://:80 {\n respond "hello"\n}\n')).toThrow();
  });

  it('ships exactly the tested helper for upload', () => {
    expect(readFileSync(join(root, 'releases/enable-ip-https.mjs'), 'utf8')).toBe(readFileSync(join(root, 'deploy/enable-ip-https.mjs'), 'utf8'));
  });
});

describe('application at the HTTPS IP origin', () => {
  it('allows legitimate requests, rejects wrong host/origin/token, and persists study progress', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'nihongo-ip-https-test-'));
    directories.push(dataDir);
    const provider = vi.fn<typeof fetch>().mockRejectedValue(new Error('No external API calls allowed'));
    const deployment = deploymentConfig({ DEPLOYMENT: 'web', APP_PUBLIC_ORIGIN: origin, APP_PROXY_TOKEN: token });
    expect(deployment).toMatchObject({ publicHost: ip, origin });
    const app = buildApp({ dataDir, deployment, aiFetch: provider, voiceFetch: provider });
    apps.push(app);
    const headers = { host: ip, origin, 'x-nihongo-proxy': token };
    expect((await app.inject({ url: '/api/health', headers })).statusCode).toBe(200);
    for (const invalid of [
      { ...headers, host: 'jp.nbblearnjp.xyz' },
      { ...headers, origin: 'https://example.com' },
      { ...headers, origin: `http://${ip}` },
      { ...headers, 'x-nihongo-proxy': 'incorrect' },
      { host: ip, 'x-nihongo-proxy': token },
    ]) {
      expect((await app.inject({ method: 'PATCH', url: '/api/settings', headers: invalid, payload: { currentLessonId: 50 } })).statusCode).toBe(403);
    }
    expect((await app.inject({ method: 'PATCH', url: '/api/settings', headers, payload: { currentLessonId: 27 } })).statusCode).toBe(200);
    await app.close(); apps.splice(apps.indexOf(app), 1);
    const restarted = buildApp({ dataDir, deployment, aiFetch: provider, voiceFetch: provider });
    apps.push(restarted);
    const response = await restarted.inject({ url: '/api/bootstrap', headers });
    expect(response.statusCode).toBe(200);
    expect(response.json().settings.currentLessonId).toBe(27);
    expect(response.body).not.toContain(token);
    expect(provider).not.toHaveBeenCalled();
  });
});
