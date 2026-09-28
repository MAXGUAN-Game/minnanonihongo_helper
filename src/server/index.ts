import { buildApp } from './app';
import { getSpeechStatus, registerSpeechRoutes } from './speech';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deploymentConfig } from './deployment';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
if (existsSync(path.join(root, '.env.local'))) process.loadEnvFile(path.join(root, '.env.local'));
const deployment = deploymentConfig();
const dataDir = path.resolve(root, process.env.DATA_DIR || 'data');
const port = Number(process.env.PORT || 4317);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('PORT must be a number between 1024 and 65535.');
const app = buildApp({ dataDir, deployment, speechStatus: () => getSpeechStatus(dataDir) });
registerSpeechRoutes(app, dataDir);
const dist = path.join(root, 'dist');
if (existsSync(dist)) {
  await app.register(fastifyStatic, { root: dist, prefix: '/', index: 'index.html', list: false, dotfiles: 'deny' });
  app.setNotFoundHandler((request, reply) => request.url.startsWith('/api/') ? reply.code(404).send({ error: '没有这个接口。', code: 'NOT_FOUND' }) : reply.code(404).type('text/plain; charset=utf-8').send('页面不存在，请返回应用首页。'));
} else app.get('/', async (_request, reply) => reply.type('text/html; charset=utf-8').send('<h1>请先运行 npm run build，再重新启动应用。</h1>'));
await mkdir(dataDir, { recursive: true });
const runtimeFile = path.join(dataDir, 'runtime.json');
let closing = false;
async function close() {
  if (closing) return; closing = true;
  await app.close();
  try { const saved = JSON.parse(await readFile(runtimeFile, 'utf8')); if (saved.pid === process.pid) await rm(runtimeFile, { force: true }); } catch {}
  process.exit(0);
}
process.on('SIGTERM', () => void close()); process.on('SIGINT', () => void close());
try {
  await app.listen({ host: deployment.host, port });
  await writeFile(runtimeFile, JSON.stringify({ pid: process.pid, port, root, startedAt: new Date().toISOString() }));
  console.log(`日语，慢慢来 ${deployment.mode === 'web' ? deployment.origin : `http://127.0.0.1:${port}`}`);
  console.log(getSpeechStatus(dataDir).message);
} catch (error) { console.error((error as Error).message); await app.close(); process.exitCode = 1; }
