import http from 'node:http';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Node fetch does not preserve an explicit Host header. Probe the same proxy
// boundary as Docker's healthcheck with node:http, without exposing credentials.
export async function checkReleaseAuth({ origin, proxyToken, username, passwordHash, version, port = 4317 }) {
  if (!username || !passwordHash || !proxyToken) throw new Error('Missing session authentication configuration.');
  const headers = { host: new URL(origin).host, 'x-nihongo-proxy': proxyToken };
  const get = (path, extra = {}) => new Promise((resolveResult, reject) => {
    const request = http.get({ hostname: '127.0.0.1', port, path, headers: { ...headers, ...extra }, signal: AbortSignal.timeout(10000) }, response => {
      let body = '';
      response.on('data', chunk => { body += chunk; if (body.length > 65536) request.destroy(new Error('Unexpected probe response.')); });
      response.on('error', reject);
      response.on('end', () => { try { resolveResult({ status: response.statusCode, body: JSON.parse(body) }); } catch { reject(new Error('Invalid probe response.')); } });
    });
    request.on('error', reject);
  });
  const status = await get('/api/auth/status');
  if (status.status !== 200 || status.body.required !== true || status.body.authenticated !== false || status.body.version !== version) throw new Error('Session authentication/version verification failed.');
  const protectedPage = await get('/api/bootstrap');
  const internalHealth = await get('/api/health');
  const externalHealth = await get('/api/health', { 'x-nihongo-client-ip': '127.0.0.1' });
  if (protectedPage.status !== 401 || protectedPage.body.code !== 'AUTH_REQUIRED' || internalHealth.status !== 200 || externalHealth.status !== 401) throw new Error('Authentication boundary verification failed.');
  return { version, protected: true, internalHealth: true };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await checkReleaseAuth({ origin: process.env.APP_PUBLIC_ORIGIN, proxyToken: process.env.APP_PROXY_TOKEN, username: process.env.APP_AUTH_USER, passwordHash: process.env.APP_AUTH_HASH, version: process.argv[2] });
    console.log(`AUTH_VERIFIED v${result.version}`);
  } catch { console.error('Session authentication verification failed; keep the gateway closed and inspect deployment configuration.'); process.exitCode = 1; }
}
