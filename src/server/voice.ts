import type Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { DEFAULT_VOICE_SETTINGS, type VoiceCacheStats, type VoiceSettings } from '../shared/voice';
import { ApiError } from './schemas';

const MAX_AUDIO_BYTES = 8 * 1024 * 1024;
const MAX_CACHE_BYTES = 100 * 1024 * 1024;
const CACHE_VERSION = 'v1';
const CACHE_FILE = /^v1-[a-f0-9]{64}\.wav$/;
const voiceSchema = z.enum(['Japanese_KindLady', 'Japanese_IntellectualSenior', 'Japanese_CalmLady', 'Japanese_GentleButler']);
const settingsSchema = z.object({
  provider: z.enum(['system', 'minimax']),
  model: z.enum(['speech-2.8-hd', 'speech-2.8-turbo']),
  voice: voiceSchema, secondaryVoice: voiceSchema,
  alternateSpeakers: z.boolean(), speed: z.number().min(0.8).max(1.2),
}).strict();
const patchSchema = settingsSchema.partial().extend({ apiKey: z.string().trim().max(512) }).partial().strict();
const inputSchema = z.object({
  text: z.string().trim().min(1).max(1500),
  rate: z.number().min(0.6).max(1.2).default(1), speaker: z.enum(['primary', 'secondary']).default('primary'),
}).strict();

// Validate RIFF structure and the exact uncompressed format requested from MiniMax.
function validWav(audio: Buffer): boolean {
  if (audio.length < 46 || audio.length > MAX_AUDIO_BYTES || audio.toString('ascii', 0, 4) !== 'RIFF' || audio.toString('ascii', 8, 12) !== 'WAVE' || audio.readUInt32LE(4) + 8 !== audio.length) return false;
  let format = false;
  let data = false;
  let offset = 12;
  while (offset + 8 <= audio.length) {
    const kind = audio.toString('ascii', offset, offset + 4);
    const size = audio.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (size > audio.length - start) return false;
    if (kind === 'fmt ') {
      if (format || size < 16) return false;
      format = audio.readUInt16LE(start) === 1 && audio.readUInt16LE(start + 2) === 1 && audio.readUInt32LE(start + 4) === 32000 && audio.readUInt32LE(start + 8) === 64000 && audio.readUInt16LE(start + 12) === 2 && audio.readUInt16LE(start + 14) === 16;
      if (!format) return false;
    }
    if (kind === 'data') {
      if (data || !format || size === 0 || size % 2) return false;
      data = true;
    }
    offset = start + size + size % 2;
  }
  return format && data && offset === audio.length;
}

type CacheFile = { path: string; bytes: number; modified: number };
class VoiceCache {
  private readonly directory: string;
  private readonly realDirectory: string;
  epoch = 0;
  constructor(dataDir: string) {
    this.directory = join(dataDir, 'voice-cache');
    this.realDirectory = join(realpathSync(dataDir), 'voice-cache');
  }
  private ready(): boolean {
    try {
      mkdirSync(this.directory, { recursive: true });
      const directory = lstatSync(this.directory);
      return directory.isDirectory() && !directory.isSymbolicLink() && realpathSync(this.directory) === this.realDirectory;
    } catch { return false; }
  }
  private files(): CacheFile[] {
    if (!this.ready()) return [];
    return readdirSync(this.directory).filter(name => CACHE_FILE.test(name)).flatMap(name => {
      const path = join(this.directory, name);
      try {
        const info = lstatSync(path);
        return info.isFile() && !info.isSymbolicLink() && info.nlink === 1 ? [{ path, bytes: info.size, modified: info.mtimeMs }] : [];
      } catch { return []; }
    });
  }
  private remove(path: string) { try { unlinkSync(path); } catch { /* Concurrent cleanup or unavailable cache never affects learning data. */ } }
  read(key: string): Buffer | undefined {
    if (!this.ready()) return;
    const path = join(this.directory, `${CACHE_VERSION}-${key}.wav`);
    try {
      const info = lstatSync(path);
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) return;
      if (info.size > MAX_AUDIO_BYTES) { this.remove(path); return; }
      const audio = readFileSync(path);
      if (!validWav(audio)) { this.remove(path); return; }
      try { const now = new Date(); utimesSync(path, now, now); } catch { /* Playback can continue on a read-only cache. */ }
      return audio;
    } catch { return; }
  }
  write(key: string, audio: Buffer, epoch: number) {
    if (epoch !== this.epoch || !this.ready()) return;
    const temporary = join(this.directory, `.voice-${randomUUID()}.tmp`);
    try {
      const files = this.files().sort((a, b) => a.modified - b.modified);
      let bytes = files.reduce((sum, item) => sum + item.bytes, 0);
      for (const item of files) {
        if (bytes + audio.length <= MAX_CACHE_BYTES) break;
        this.remove(item.path);
        // Failed deletions count toward the bound, so a full/read-only cache is skipped.
        try { lstatSync(item.path); } catch { bytes -= item.bytes; }
      }
      if (bytes + audio.length > MAX_CACHE_BYTES) return;
      writeFileSync(temporary, audio, { flag: 'wx', mode: 0o600 });
      renameSync(temporary, join(this.directory, `${CACHE_VERSION}-${key}.wav`));
    } catch { /* Cloud playback remains usable if the disk cache is unavailable. */ }
    finally { this.remove(temporary); }
  }
  stats(): VoiceCacheStats {
    const files = this.files();
    return { clips: files.length, bytes: files.reduce((sum, item) => sum + item.bytes, 0) };
  }
  clear(): VoiceCacheStats {
    this.epoch++;
    for (const file of this.files()) this.remove(file.path);
    return this.stats();
  }
}

function invalidAudio() { return new ApiError(502, 'VOICE_INVALID_AUDIO', '云语音返回的音频不完整，请重试。'); }
async function readAudio(response: Response): Promise<Buffer> {
  const maxResponseBytes = MAX_AUDIO_BYTES * 2 + 65536;
  const length = Number(response.headers.get('content-length'));
  if (length > maxResponseBytes || !response.body) {
    void response.body?.cancel().catch(() => {});
    throw invalidAudio();
  }
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let bytes = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > maxResponseBytes) { void reader.cancel().catch(() => {}); throw invalidAudio(); }
      chunks.push(Buffer.from(part.value));
    }
  } finally { reader.releaseLock(); }
  let envelope: { base_resp?: { status_code?: number }; data?: { audio?: unknown; status?: number } };
  try { envelope = JSON.parse(Buffer.concat(chunks, bytes).toString('utf8')); }
  catch { throw invalidAudio(); }
  const code = envelope?.base_resp?.status_code;
  if (code === 1004) throw new ApiError(502, 'VOICE_AUTH_FAILED', 'MiniMax 未接受密钥，请在语音设置中核对 API 密钥。');
  if (code === 1008) throw new ApiError(503, 'VOICE_QUOTA_EXCEEDED', 'MiniMax 语音余额不足，请检查语音套餐或账户余额。');
  if (code === 2056) throw new ApiError(503, 'VOICE_QUOTA_EXCEEDED', 'MiniMax 语音额度已用完，请在 MiniMax 控制台补充额度后重试。');
  if (code === 1002) throw new ApiError(503, 'VOICE_QUOTA_EXCEEDED', 'MiniMax 语音请求过多，请稍后重试。');
  if (code !== 0) throw new ApiError(502, 'VOICE_UNAVAILABLE', 'MiniMax 语音服务暂时不可用，请稍后重试。');
  const hex = envelope.data?.audio;
  if (envelope.data?.status !== 2 || typeof hex !== 'string' || hex.length > MAX_AUDIO_BYTES * 2 || hex.length % 2 || !/^[a-f0-9]+$/i.test(hex)) throw invalidAudio();
  const audio = Buffer.from(hex, 'hex');
  if (!validWav(audio)) throw invalidAudio();
  return audio;
}

async function requestAudio(voiceFetch: typeof fetch, settings: VoiceSettings, apiKey: string, voice: VoiceSettings['voice'], rate: number, text: string): Promise<Buffer> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(new ApiError(504, 'VOICE_TIMEOUT', '云语音等待超过 25 秒，请检查网络后重试。')); }, 25000);
  });
  try {
    return await Promise.race([timeout, (async () => {
      const body = JSON.stringify({ model: settings.model, text, stream: false, language_boost: 'Japanese', output_format: 'hex',
        voice_setting: { voice_id: voice, speed: rate, vol: 1, pitch: 0 }, audio_setting: { sample_rate: 32000, format: 'wav', channel: 1 } });
      const response = await voiceFetch('https://api.minimax.cn/v1/t2a_v2', {
        method: 'POST', redirect: 'error', signal: controller.signal,
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }, body,
      });
      if (!response.ok) {
        void response.body?.cancel().catch(() => {});
        if (response.status === 401 || response.status === 403) throw new ApiError(502, 'VOICE_AUTH_FAILED', 'MiniMax 未接受密钥，请在语音设置中核对 API 密钥。');
        if (response.status === 429) throw new ApiError(503, 'VOICE_QUOTA_EXCEEDED', 'MiniMax 语音额度不足或请求过多，请稍后重试并检查额度。');
        throw new ApiError(502, 'VOICE_UNAVAILABLE', '云语音服务暂时不可用，请稍后重试。');
      }
      return readAudio(response);
    })()]);
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(502, 'VOICE_UNAVAILABLE', '没有连上云语音服务，请检查网络后重试。');
  } finally { clearTimeout(timer); }
}

export function registerVoiceRoutes(app: FastifyInstance, db: Database.Database, dataDir: string, voiceFetch: typeof fetch) {
  // These tables deliberately stay separate from DeepSeek settings and learning backups.
  db.exec(`CREATE TABLE IF NOT EXISTS voice_settings (id INTEGER PRIMARY KEY CHECK (id=1), value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS voice_secrets (id INTEGER PRIMARY KEY CHECK (id=1), api_key TEXT NOT NULL);`);
  const { hasApiKey: _, ...defaults } = DEFAULT_VOICE_SETTINGS;
  db.prepare('INSERT OR IGNORE INTO voice_settings (id,value) VALUES (1,?)').run(JSON.stringify(defaults));
  const getKey = () => (db.prepare('SELECT api_key FROM voice_secrets WHERE id=1').get() as { api_key: string } | undefined)?.api_key ?? '';
  const settings = (): VoiceSettings => {
    const value = JSON.parse((db.prepare('SELECT value FROM voice_settings WHERE id=1').get() as { value: string }).value);
    return { ...settingsSchema.parse({ ...defaults, ...value }), hasApiKey: Boolean(getKey()) };
  };
  const cache = new VoiceCache(dataDir);
  const pending = new Map<string, Promise<Buffer>>();
  app.get('/api/voice/settings', async () => settings());
  app.patch('/api/voice/settings', async request => {
    const { apiKey, ...patch } = patchSchema.parse(request.body);
    const { hasApiKey: _, ...current } = settings();
    db.transaction(() => {
      db.prepare('UPDATE voice_settings SET value=? WHERE id=1').run(JSON.stringify({ ...current, ...patch }));
      if (apiKey !== undefined) {
        if (apiKey) db.prepare('INSERT INTO voice_secrets (id,api_key) VALUES (1,?) ON CONFLICT(id) DO UPDATE SET api_key=excluded.api_key').run(apiKey);
        else db.prepare('DELETE FROM voice_secrets WHERE id=1').run();
      }
    })();
    return settings();
  });
  app.get('/api/voice/cache', async () => cache.stats());
  app.delete('/api/voice/cache', async () => cache.clear());
  app.post('/api/voice/synthesize', async (request, reply) => {
    const input = inputSchema.parse(request.body);
    const configuration = settings();
    if (configuration.provider !== 'minimax') throw new ApiError(400, 'VOICE_PROVIDER_DISABLED', '请先在设置中选择 MiniMax 云语音。');
    const voice = input.speaker === 'secondary' && configuration.alternateSpeakers
      ? configuration.secondaryVoice : configuration.voice;
    const rate = Math.max(0.5, Math.min(2, Number((configuration.speed * input.rate).toFixed(4))));
    const key = createHash('sha256').update(JSON.stringify(['minimax', CACHE_VERSION, configuration.model, voice, rate, input.text])).digest('hex');
    const cached = cache.read(key);
    if (cached) return reply.type('audio/wav').header('X-Voice-Cache', 'hit').send(cached);
    const apiKey = getKey();
    if (!apiKey) throw new ApiError(503, 'VOICE_NOT_CONFIGURED', '请先在语音设置中填写 MiniMax API 密钥。');
    let task = pending.get(key);
    if (!task) {
      const epoch = cache.epoch;
      task = requestAudio(voiceFetch, configuration, apiKey, voice, rate, input.text).then(audio => { cache.write(key, audio, epoch); return audio; });
      pending.set(key, task);
    }
    try { return reply.type('audio/wav').header('X-Voice-Cache', 'miss').send(await task); }
    finally { if (pending.get(key) === task) pending.delete(key); }
  });
}
