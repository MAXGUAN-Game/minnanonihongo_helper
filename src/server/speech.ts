import type { FastifyInstance } from 'fastify';
import type { SpeechStatus } from '../shared/types';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { availableParallelism } from 'node:os';

function configuredPath(value: string | undefined, name: string) {
  if (!value?.trim()) return undefined;
  if (!path.isAbsolute(value.trim())) throw new Error(`${name} must be an absolute path.`);
  return path.normalize(value.trim());
}
export function speechThreads(environment: NodeJS.ProcessEnv = process.env, parallelism = availableParallelism()) {
  const configured = environment.WHISPER_THREADS?.trim();
  if (!configured) return Math.max(1, Math.min(8, parallelism));
  if (!/^[1-9]\d*$/.test(configured) || Number(configured) > 32) throw new Error('WHISPER_THREADS must be an integer between 1 and 32.');
  return Number(configured);
}
export function speechPaths(dataDir: string, environment: NodeJS.ProcessEnv = process.env, platform = process.platform) {
  const base = path.resolve(dataDir, 'speech');
  let binary = platform === 'win32' ? path.join(base, 'runtime', 'Release', 'whisper-cli.exe') : path.join(base, 'runtime', 'bin', 'whisper-cli');
  const manifests = platform === 'win32' ? ['install.json'] : ['install-linux.json', 'install.json'];
  for (const name of manifests) {
    try {
      const saved = JSON.parse(readFileSync(path.join(base, name), 'utf8'));
      if (typeof saved.binary !== 'string' || (platform !== 'win32' && /\.exe$/i.test(saved.binary))) continue;
      const resolved = path.resolve(base, saved.binary);
      if (resolved.startsWith(base + path.sep)) { binary = resolved; break; }
    } catch { /* An absent or invalid installation manifest keeps the platform default. */ }
  }
  return { base, binary: configuredPath(environment.WHISPER_BINARY, 'WHISPER_BINARY') ?? binary, model: configuredPath(environment.WHISPER_MODEL, 'WHISPER_MODEL') ?? path.join(base, 'ggml-small.bin') };
}
export function getSpeechStatus(dataDir: string, environment: NodeJS.ProcessEnv = process.env, platform = process.platform): SpeechStatus {
  const paths = speechPaths(dataDir, environment, platform); const binaryReady = existsSync(paths.binary), modelReady = existsSync(paths.model);
  const localWindows = platform === 'win32' && environment.DEPLOYMENT !== 'web';
  const message = binaryReady && modelReady
    ? localWindows ? '本机日语识别已就绪' : '日语语音识别服务已就绪'
    : localWindows ? '首次需要安装语音模型，请双击“安装本机语音”。' : '语音识别服务尚未准备好，请安装语音组件和模型。可以先打字练习。';
  return { ready: binaryReady && modelReady, binaryReady, modelReady, message };
}
export function validateWav(buffer: Buffer) {
  if (buffer.length < 44 || buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') throw new Error('需要有效的 WAV 录音。');
  let position = 12, pcm: Buffer | undefined, validFormat = false;
  while (position + 8 <= buffer.length) {
    const name = buffer.toString('ascii', position, position + 4), length = buffer.readUInt32LE(position + 4), begin = position + 8;
    if (begin + length > buffer.length) throw new Error('录音文件不完整。');
    if (name === 'fmt ') validFormat = length >= 16 && buffer.readUInt16LE(begin) === 1 && buffer.readUInt16LE(begin + 2) === 1 && buffer.readUInt32LE(begin + 4) === 16000 && buffer.readUInt16LE(begin + 14) === 16;
    if (name === 'data') pcm = buffer.subarray(begin, begin + length);
    position = begin + length + (length % 2);
  }
  if (!validFormat || !pcm || pcm.length % 2 || pcm.length < 8000 || pcm.length > 16000 * 2 * 31) throw new Error('请提交 0.25–30 秒、单声道 16 kHz 的录音。');
  let energy = 0; for (let i = 0; i < pcm.length; i += 2) energy += (pcm.readInt16LE(i) / 32768) ** 2;
  if (Math.sqrt(energy / (pcm.length / 2)) < .002) throw new Error('没有听到声音，请靠近麦克风再试。');
}
export function registerSpeechRoutes(app: FastifyInstance, dataDir: string) {
  const threads = speechThreads();
  // Validate explicit paths on startup, before recording can reach this service.
  speechPaths(dataDir);
  const localWindows = process.platform === 'win32' && process.env.DEPLOYMENT !== 'web';
  let busy = false;
  app.addContentTypeParser('audio/wav', { parseAs: 'buffer', bodyLimit: 1100000 }, (_request, body, done) => done(null, body));
  app.get('/api/speech/status', async () => getSpeechStatus(dataDir));
  app.post('/api/speech/transcribe', { bodyLimit: 1100000 }, async (request, reply) => {
    if (!getSpeechStatus(dataDir).ready) return reply.code(503).send({ code: 'SPEECH_NOT_INSTALLED', error: localWindows ? '语音模型尚未安装。请双击“安装本机语音”，也可以先打字回答。' : '语音识别服务尚未准备好，请在服务器准备语音组件和模型。可以先打字回答。' });
    if (busy) return reply.code(409).send({ code: 'SPEECH_BUSY', error: '正在识别上一句，请稍等。' });
    if (!Buffer.isBuffer(request.body)) return reply.code(400).send({ error: '请上传 WAV 录音。' });
    try { validateWav(request.body); } catch (error) { return reply.code(400).send({ code: 'INVALID_AUDIO', error: (error as Error).message }); }
    busy = true;
    let dir: string | undefined;
    const started = performance.now();
    try {
      const temporary = path.resolve(dataDir, 'speech', 'tmp'); await mkdir(temporary, { recursive: true });
      dir = await mkdtemp(path.join(temporary, 'utterance-')); const output = path.join(dir, 'result'); const input = path.join(dir, 'input.wav');
      await writeFile(input, request.body);
      const { binary, model } = speechPaths(dataDir);
      await new Promise<void>((resolve, reject) => {
        const child = spawn(binary, ['-m', model, '-f', input, '-l', 'ja', '-t', String(threads), '-otxt', '-of', output, '-np', '-nt'], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
        let diagnostic = ''; child.stderr.on('data', chunk => { diagnostic = (diagnostic + chunk.toString()).slice(-2000); });
        let timedOut = false;
        const timer = setTimeout(() => { timedOut = true; child.kill(); }, 120000);
        const cancel = () => { if (!reply.raw.writableEnded) child.kill(); }; reply.raw.on('close', cancel);
        child.on('error', () => { clearTimeout(timer); reply.raw.off('close', cancel); reject(new Error(localWindows ? '本机语音程序未能启动，请重新安装语音组件。' : '语音识别程序未能启动，请检查服务器的语音组件。')); });
        child.on('close', code => { clearTimeout(timer); reply.raw.off('close', cancel); if (timedOut) reject(new Error('识别超过两分钟，请缩短录音再试。')); else if (code === 0) resolve(); else reject(new Error(diagnostic.includes('failed to load') ? '语音模型加载失败，请重新安装。' : '识别中断，请重新录一句。')); });
      });
      const text = (await readFile(output + '.txt', 'utf8')).replace(/\[[^\]]*\]/g, '').trim();
      if (!text) return reply.code(422).send({ code: 'NO_SPEECH', error: '没有辨认出日语，请重新说一句。' });
      return { text, durationMs: Math.round(performance.now() - started) };
    } catch (error) { return reply.code(500).send({ code: 'TRANSCRIPTION_FAILED', error: (error as Error).message }); }
    finally { busy = false; if (dir) await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); }
  });
}
