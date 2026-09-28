import { timingSafeEqual } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import { ApiError } from './schemas';

export type Deployment = { mode: 'local'; host: string } | { mode: 'web'; host: string; origin: string; publicHost: string; proxyToken: string; icpNumber?: string };
export function deploymentConfig(environment: NodeJS.ProcessEnv = process.env): Deployment {
  const mode = environment.DEPLOYMENT || 'local';
  const host = environment.HOST || (mode === 'web' ? '0.0.0.0' : '127.0.0.1');
  if (mode !== 'local' && mode !== 'web') throw new Error('DEPLOYMENT must be local or web.');
  if (mode === 'local') {
    if (!['127.0.0.1', '::1'].includes(host) || environment.APP_PUBLIC_ORIGIN || environment.APP_PROXY_TOKEN) throw new Error('Public access requires DEPLOYMENT=web and a configured HTTPS proxy.');
    return { mode, host };
  }
  const raw = environment.APP_PUBLIC_ORIGIN || '';
  let origin: URL;
  try { origin = new URL(raw); } catch { throw new Error('APP_PUBLIC_ORIGIN must be an HTTPS origin.'); }
  if (origin.protocol !== 'https:' || raw !== origin.origin || origin.username || origin.password || !origin.hostname.includes('.') || !/^[a-z0-9.-]+$/.test(origin.hostname)) throw new Error('APP_PUBLIC_ORIGIN must be a canonical HTTPS domain, without a path.');
  const proxyToken = environment.APP_PROXY_TOKEN || '';
  if (!/^[A-Za-z0-9_-]{32,128}$/.test(proxyToken)) throw new Error('APP_PROXY_TOKEN must contain 32–128 random letters, digits, underscores or hyphens.');
  if (!['127.0.0.1', '::1', '0.0.0.0'].includes(host)) throw new Error('Unsupported HOST.');
  const icpNumber = environment.ICP_NUMBER?.trim() || '';
  if (icpNumber.length > 64 || /[\r\n\u0000-\u001f]/.test(icpNumber)) throw new Error('ICP_NUMBER must be a single line of at most 64 characters.');
  return { mode, host, origin: origin.origin, publicHost: origin.host, proxyToken, icpNumber };
}

function loopback(host: string) { return ['localhost', '127.0.0.1', '[::1]', '::1'].includes(host.toLowerCase()); }
export function authorizeRequest(request: FastifyRequest, deployment: Deployment) {
  if (deployment.mode === 'web') {
    const token = request.headers['x-nihongo-proxy'];
    const matches = typeof token === 'string' && Buffer.byteLength(token) === Buffer.byteLength(deployment.proxyToken) && timingSafeEqual(Buffer.from(token), Buffer.from(deployment.proxyToken));
    if (!matches || request.headers.host !== deployment.publicHost) throw new ApiError(403, 'PROXY_REQUIRED', '请通过配置好的 HTTPS 网站访问。');
    const origin = request.headers.origin;
    if ((origin !== undefined && origin !== deployment.origin) || (!['GET', 'HEAD', 'OPTIONS'].includes(request.method) && origin !== deployment.origin)) throw new ApiError(403, 'ORIGIN_REJECTED', '请求来源不匹配，请回到网站刷新后重试。');
    return;
  }
  if (!request.url.startsWith('/api/')) return;
  let local = false;
  try {
    const host = new URL(`http://${request.headers.host ?? ''}`);
    local = loopback(host.hostname) && !host.username && !host.password;
    if (request.headers.origin) { const origin = new URL(request.headers.origin); local = local && ['http:', 'https:'].includes(origin.protocol) && loopback(origin.hostname); }
  } catch { local = false; }
  if (!local) throw new ApiError(403, 'LOCAL_ONLY', '此服务只接受来自本机页面的请求。');
}
