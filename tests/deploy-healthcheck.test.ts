import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildApp } from '../src/server/app';
import { deploymentConfig } from '../src/server/deployment';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const publicOrigin = 'https://healthcheck.example.com';
const proxyToken = 'healthcheck-fixture-token-never-a-real-secret';
const fixturePrefix = 'nihongo-healthcheck-test-';
const apps: ReturnType<typeof buildApp>[] = [];
const directories: string[] = [];
const { patchCompose, oldCheck, newCheck } = await import(pathToFileURL(join(projectRoot, 'deploy/fix-healthcheck.mjs')).href);

// Execute the actual deployment command, rather than a copied implementation.
// The Compose files use a JSON-compatible, single-line quoted YAML string here.
function commandFrom(composeFile: string) {
  const source = readFileSync(join(projectRoot, composeFile), 'utf8');
  const match = source.match(/    healthcheck:\r?\n\s+test:\r?\n\s+- CMD\r?\n\s+- node\r?\n\s+- -e\r?\n\s+- ("[^\r\n]*")/);
  if (!match) throw new Error(`Cannot locate the Node healthcheck in ${composeFile}`);
  const command: unknown = JSON.parse(match[1]);
  if (typeof command !== 'string') throw new Error('The healthcheck must be a JavaScript string');
  return command;
}

async function probe(composeFile: string, overrides: Record<string, string> = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), fixturePrefix));
  directories.push(dataDir);
  const externalFetch = vi.fn<typeof fetch>().mockRejectedValue(new Error('Health checks must not contact an AI provider'));
  const app = buildApp({
    dataDir,
    deployment: deploymentConfig({ DEPLOYMENT: 'web', APP_PUBLIC_ORIGIN: publicOrigin, APP_PROXY_TOKEN: proxyToken }),
    aiFetch: externalFetch,
    voiceFetch: externalFetch,
  });
  apps.push(app);
  const requests: { host: string | undefined; origin: string | undefined; token: string | string[] | undefined; status: number }[] = [];
  app.addHook('onResponse', async (request, reply) => {
    requests.push({ host: request.headers.host, origin: request.headers.origin, token: request.headers['x-nihongo-proxy'], status: reply.statusCode });
  });
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  const command = commandFrom(composeFile);
  expect(command.match(/http:\/\/127\.0\.0\.1:4317\/api\/health/g)).toHaveLength(1);
  // Only the connection port changes. Host/Origin/token construction remains
  // exactly as shipped, so fetch() dropping an explicit Host is caught here.
  const testCommand = command.replace('http://127.0.0.1:4317/api/health', `${address}/api/health`);
  const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }>((resolveResult, reject) => {
    const child = spawn(process.execPath, ['-e', testCommand], {
      cwd: dataDir,
      env: {
        ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
        APP_PUBLIC_ORIGIN: publicOrigin,
        APP_PROXY_TOKEN: proxyToken,
        ...overrides,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      timeout: 8000,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk.toString(); });
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    child.once('error', reject);
    child.once('close', (code, signal) => resolveResult({ code, signal, stdout, stderr }));
  });
  expect(result.signal).toBeNull();
  expect(externalFetch).not.toHaveBeenCalled();
  expect(result.stdout + result.stderr).not.toContain(proxyToken);
  if (overrides.APP_PROXY_TOKEN) expect(result.stdout + result.stderr).not.toContain(overrides.APP_PROXY_TOKEN);
  return { ...result, requests };
}

afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  for (const directory of directories.splice(0)) {
    if (!resolve(directory).startsWith(resolve(tmpdir(), fixturePrefix))) throw new Error('Unexpected healthcheck fixture directory');
    rmSync(directory, { recursive: true, force: true });
  }
});

describe.each(['compose.yaml', 'compose.shared.yaml'])('%s real HTTP healthcheck', composeFile => {
  it('passes the web guard using the public Host while connecting to loopback', async () => {
    const result = await probe(composeFile);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout + result.stderr).toBe('');
    expect(result.requests).toEqual([{ host: 'healthcheck.example.com', origin: publicOrigin, token: proxyToken, status: 200 }]);
  });

  it('fails with a sanitized HTTP diagnostic when the proxy token is wrong', async () => {
    const result = await probe(composeFile, { APP_PROXY_TOKEN: 'wrong-fixture-token-never-a-real-secret' });
    expect(result.code).toBe(1);
    expect(result.stderr.trim()).toBe('Health HTTP 403');
    expect(result.requests).toHaveLength(1);
    expect(result.requests[0]).toMatchObject({ host: 'healthcheck.example.com', status: 403 });
  });

  it('cannot report healthy for a different public hostname', async () => {
    const result = await probe(composeFile, { APP_PUBLIC_ORIGIN: 'https://wrong.example.com' });
    expect(result.code).toBe(1);
    expect(result.stderr.trim()).toBe('Health HTTP 403');
    expect(result.requests).toHaveLength(1);
    expect(result.requests[0]).toMatchObject({ host: 'wrong.example.com', status: 403 });
  });

  it('still enforces the HTTPS Origin when Host and proxy token are correct', async () => {
    const result = await probe(composeFile, { APP_PUBLIC_ORIGIN: 'http://healthcheck.example.com' });
    expect(result.code).toBe(1);
    expect(result.stderr.trim()).toBe('Health HTTP 403');
    expect(result.requests).toEqual([{ host: 'healthcheck.example.com', origin: 'http://healthcheck.example.com', token: proxyToken, status: 403 }]);
  });
});

describe('standalone healthcheck repair', () => {
  it.each(['compose.yaml', 'compose.shared.yaml'])('only replaces the old probe in %s', composeFile => {
    const current = readFileSync(join(projectRoot, composeFile), 'utf8');
    expect(commandFrom(composeFile)).toBe(newCheck);
    const original = current.replace(newCheck, oldCheck);
    expect(original).not.toBe(current);
    // Exact equality also covers environment settings, mounts, auth, and all
    // other deployment content; none of those may change during the repair.
    expect(patchCompose(original)).toBe(current);
  });

  it.each(['compose.yaml', 'compose.shared.yaml'])('does nothing when %s is already repaired', composeFile => {
    const current = readFileSync(join(projectRoot, composeFile), 'utf8');
    expect(patchCompose(current)).toBe(current);
    expect(patchCompose(patchCompose(current))).toBe(current);
  });

  it('refuses unfamiliar or ambiguous probes instead of rewriting them', () => {
    for (const text of [
      'services: {}',
      oldCheck.replace('/api/health', '/custom-health'),
      oldCheck + '\n' + oldCheck,
      oldCheck + '\n' + newCheck,
      newCheck + '\n' + newCheck,
    ]) expect(() => patchCompose(text)).toThrow('Unknown healthcheck configuration');
  });
});
