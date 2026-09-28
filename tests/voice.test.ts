import { afterEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, truncateSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { buildApp, type AppOptions } from '../src/server/app';
import { DEFAULT_VOICE_SETTINGS } from '../src/shared/voice';

const key = 'minimax-private-test-key';
const apps: ReturnType<typeof buildApp>[] = [];
const directories: string[] = [];
function create(options: AppOptions = {}) {
  const dataDir = options.dataDir ?? mkdtempSync(join(tmpdir(), 'nihongo-voice-test-'));
  if (!directories.includes(dataDir)) directories.push(dataDir);
  const app = buildApp({ ...options, dataDir }); apps.push(app);
  return { app, dataDir };
}
function wav(bytes = 4800) {
  const audio = Buffer.alloc(44 + bytes);
  audio.write('RIFF', 0); audio.writeUInt32LE(audio.length - 8, 4); audio.write('WAVEfmt ', 8);
  audio.writeUInt32LE(16, 16); audio.writeUInt16LE(1, 20); audio.writeUInt16LE(1, 22);
  audio.writeUInt32LE(32000, 24); audio.writeUInt32LE(64000, 28); audio.writeUInt16LE(2, 32); audio.writeUInt16LE(16, 34);
  audio.write('data', 36); audio.writeUInt32LE(bytes, 40);
  return audio;
}
function audioResponse(audio = wav()) { return new Response(JSON.stringify({ base_resp: { status_code: 0 }, data: { audio: audio.toString('hex'), status: 2 } }), { headers: { 'Content-Type': 'application/json' } }); }
function mockVoice() { return vi.fn<typeof fetch>().mockImplementation(async () => audioResponse()); }
async function configure(app: ReturnType<typeof buildApp>, patch: object = {}) {
  const response = await app.inject({ method: 'PATCH', url: '/api/voice/settings', payload: { provider: 'minimax', apiKey: key, ...patch } });
  expect(response.statusCode).toBe(200); return response;
}
function synthesize(app: ReturnType<typeof buildApp>, payload: object = { text: 'こんにちは。' }) {
  return app.inject({ method: 'POST', url: '/api/voice/synthesize', payload });
}
afterEach(async () => {
  vi.useRealTimers();
  for (const app of apps.splice(0)) await app.close();
  vi.restoreAllMocks();
  for (const directory of directories.splice(0)) {
    if (!resolve(directory).startsWith(resolve(tmpdir(), 'nihongo-voice-test-'))) throw new Error('Unexpected test directory');
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('independent cloud voice settings', () => {
  it('defaults to system speech and persists MiniMax settings without changing or exporting either secret', async () => {
    const first = create();
    expect((await first.app.inject('/api/voice/settings')).json()).toEqual(DEFAULT_VOICE_SETTINGS);
    expect((await first.app.inject({ method: 'PATCH', url: '/api/settings', payload: { apiKey: 'existing-deepseek-secret', dailyMinutes: 15 } })).statusCode).toBe(200);
    const before = (await first.app.inject('/api/backup')).json();
    const response = await configure(first.app, { model: 'speech-2.8-turbo', voice: 'Japanese_GentleButler', speed: 0.9 });
    expect(response.json()).toMatchObject({ model: 'speech-2.8-turbo', voice: 'Japanese_GentleButler', speed: 0.9, hasApiKey: true });
    expect(response.body).not.toContain(key);
    for (const url of ['/api/voice/settings', '/api/voice/cache', '/api/settings', '/api/bootstrap', '/api/backup']) {
      const response = await first.app.inject(url);
      expect(response.body).not.toContain(key); expect(response.body).not.toContain('existing-deepseek-secret');
      expect(response.body).not.toContain('"apiKey"');
    }
    const backup = (await first.app.inject('/api/backup')).json();
    expect({ ...backup, exportedAt: before.exportedAt }).toEqual(before);
    expect((await first.app.inject({ method: 'POST', url: '/api/restore', payload: { backup: before } })).statusCode).toBe(200);
    await first.app.close(); apps.splice(apps.indexOf(first.app), 1);
    const second = create({ dataDir: first.dataDir });
    expect((await second.app.inject('/api/voice/settings')).json()).toMatchObject({ model: 'speech-2.8-turbo', hasApiKey: true, speed: 0.9 });
    const database = new Database(join(first.dataDir, 'nihongo.sqlite'), { readonly: true });
    try {
      expect(database.prepare('SELECT api_key FROM secrets WHERE id=1').get()).toEqual({ api_key: 'existing-deepseek-secret' });
      expect(JSON.stringify(database.prepare('SELECT value FROM voice_settings WHERE id=1').get())).not.toContain(key);
    } finally { database.close(); }
    const preserve = await second.app.inject({ method: 'PATCH', url: '/api/voice/settings', payload: { alternateSpeakers: false } });
    expect(preserve.json().hasApiKey).toBe(true);
    const clear = await second.app.inject({ method: 'PATCH', url: '/api/voice/settings', payload: { apiKey: '   ' } });
    expect(clear.json().hasApiKey).toBe(false);
    expect((await second.app.inject('/api/settings')).json().hasApiKey).toBe(true);
  });
  it.each([
    { provider: 'other' }, { hasApiKey: true }, { region: 'eastasia' }, { model: '../evil' },
    { voice: 'unlisted-voice' }, { secondaryVoice: 'unlisted-voice' }, { speed: 0.79 }, { speed: 1.21 }, { alternateSpeakers: 'true' }, { apiKey: 'x'.repeat(513) },
  ])('rejects an invalid or untrusted settings patch: %j', async patch => {
    const { app } = create();
    expect((await app.inject({ method: 'PATCH', url: '/api/voice/settings', payload: patch })).statusCode).toBe(400);
    expect((await app.inject('/api/voice/settings')).json()).toEqual(DEFAULT_VOICE_SETTINGS);
  });
});

describe('MiniMax request and audio cache', () => {
  it('deduplicates concurrent requests, persists valid WAV, and plays cached clips without a key or network', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const voiceFetch = vi.fn<typeof fetch>().mockImplementation(async () => { await gate; return audioResponse(); });
    const first = create({ voiceFetch }); await configure(first.app);
    const requests = [synthesize(first.app), synthesize(first.app)];
    const responses = Promise.all(requests);
    await vi.waitFor(() => expect(voiceFetch).toHaveBeenCalledTimes(1));
    release();
    for (const response of await responses) {
      expect(response.statusCode).toBe(200); expect(response.headers['content-type']).toBe('audio/wav');
      expect(response.rawPayload).toEqual(wav());
    }
    expect(voiceFetch).toHaveBeenCalledTimes(1);
    const [url, init] = voiceFetch.mock.calls[0]!;
    expect(url).toBe('https://api.minimax.cn/v1/t2a_v2');
    expect(init!.headers).toMatchObject({ Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' });
    expect(init!.redirect).toBe('error');
    expect(JSON.parse(init!.body as string)).toMatchObject({ model: 'speech-2.8-hd', text: 'こんにちは。', stream: false, language_boost: 'Japanese', output_format: 'hex', voice_setting: { voice_id: 'Japanese_KindLady', speed: 1, vol: 1, pitch: 0 }, audio_setting: { sample_rate: 32000, format: 'wav', channel: 1 } });
    expect(init!.body).not.toContain(key);
    const stats = (await first.app.inject('/api/voice/cache')).json();
    expect(stats).toEqual({ clips: 1, bytes: wav().length });
    const file = readdirSync(join(first.dataDir, 'voice-cache'))[0]!;
    expect(file).toMatch(/^v1-[a-f0-9]{64}\.wav$/); expect(readFileSync(join(first.dataDir, 'voice-cache', file))).toEqual(wav());
    await first.app.close(); apps.splice(apps.indexOf(first.app), 1);
    const offline = mockVoice().mockRejectedValue(new Error('offline'));
    const second = create({ dataDir: first.dataDir, voiceFetch: offline });
    await second.app.inject({ method: 'PATCH', url: '/api/voice/settings', payload: { apiKey: '' } });
    const cached = await synthesize(second.app);
    expect(cached.statusCode).toBe(200); expect(cached.headers['x-voice-cache']).toBe('hit'); expect(offline).not.toHaveBeenCalled();
  });
  it('sends exact text as JSON and separates speaker, model, text and combined speech speed in the cache', async () => {
    const voiceFetch = mockVoice(); const { app } = create({ voiceFetch }); await configure(app);
    const text = '私 & <voice name="x">\'です。';
    await synthesize(app, { text });
    expect(JSON.parse(voiceFetch.mock.calls[0]![1]!.body as string)).toMatchObject({ text, voice_setting: { voice_id: 'Japanese_KindLady' } });
    await synthesize(app, { text, speaker: 'secondary' });
    expect(JSON.parse(voiceFetch.mock.calls[1]![1]!.body as string).voice_setting.voice_id).toBe('Japanese_IntellectualSenior');
    await app.inject({ method: 'PATCH', url: '/api/voice/settings', payload: { alternateSpeakers: false } });
    expect((await synthesize(app, { text, speaker: 'secondary' })).headers['x-voice-cache']).toBe('hit');
    await app.inject({ method: 'PATCH', url: '/api/voice/settings', payload: { speed: 0.8 } });
    await synthesize(app, { text, rate: 0.6 });
    expect(JSON.parse(voiceFetch.mock.calls[2]![1]!.body as string).voice_setting).toMatchObject({ speed: 0.5, pitch: 0 });
    await app.inject({ method: 'PATCH', url: '/api/voice/settings', payload: { model: 'speech-2.8-turbo' } });
    await synthesize(app, { text, rate: 0.6 });
    await synthesize(app, { text: 'こんばんは。', rate: 0.6 });
    expect(voiceFetch).toHaveBeenCalledTimes(5);
  });
  it('ignores corrupt cached audio and safely clears only owned files without repopulating after an in-flight request', async () => {
    const voiceFetch = mockVoice(); const { app, dataDir } = create({ voiceFetch }); await configure(app); await synthesize(app);
    const directory = join(dataDir, 'voice-cache');
    const filename = readdirSync(directory)[0]!;
    writeFileSync(join(directory, filename), 'invalid-wave');
    expect((await synthesize(app)).headers['x-voice-cache']).toBe('miss'); expect(voiceFetch).toHaveBeenCalledTimes(2);
    writeFileSync(join(directory, 'keep.txt'), 'unrelated file');
    mkdirSync(join(directory, `v1-${'f'.repeat(64)}.wav`));
    let release!: () => void;
    voiceFetch.mockImplementationOnce(async () => { await new Promise<void>(resolve => { release = resolve; }); return audioResponse(); });
    const inFlight = synthesize(app, { text: 'まだです。' }).then(response => response);
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    expect((await app.inject({ method: 'DELETE', url: '/api/voice/cache' })).json()).toEqual({ clips: 0, bytes: 0 });
    release(); expect((await inFlight).statusCode).toBe(200);
    expect((await app.inject('/api/voice/cache')).json().clips).toBe(0);
    expect(readFileSync(join(directory, 'keep.txt'), 'utf8')).toBe('unrelated file');
    expect(existsSync(join(directory, `v1-${'f'.repeat(64)}.wav`))).toBe(true);
    expect((await app.inject('/api/voice/settings')).json().hasApiKey).toBe(true);
  });
  it('refuses a redirected cache directory and leaves its contents untouched', async () => {
    const voiceFetch = mockVoice(); const { app, dataDir } = create({ voiceFetch }); await configure(app);
    const outside = join(dataDir, 'unrelated'); mkdirSync(outside);
    const filename = `v1-${'a'.repeat(64)}.wav`; writeFileSync(join(outside, filename), wav());
    symlinkSync(outside, join(dataDir, 'voice-cache'), process.platform === 'win32' ? 'junction' : 'dir');
    expect((await synthesize(app)).statusCode).toBe(200);
    expect((await app.inject({ method: 'DELETE', url: '/api/voice/cache' })).json()).toEqual({ clips: 0, bytes: 0 });
    expect(readdirSync(outside)).toEqual([filename]);
  });
  it('evicts the oldest owned clips to keep the disk cache within 100 MiB', async () => {
    const voiceFetch = mockVoice(); const { app, dataDir } = create({ voiceFetch }); await configure(app);
    const directory = join(dataDir, 'voice-cache'); mkdirSync(directory);
    for (let index = 0; index < 13; index++) {
      const path = join(directory, `v1-${index.toString(16).padStart(64, '0')}.wav`);
      writeFileSync(path, wav().subarray(0, 44)); truncateSync(path, 8 * 1024 * 1024);
      utimesSync(path, new Date(index * 1000), new Date(index * 1000));
    }
    await synthesize(app);
    expect((await app.inject('/api/voice/cache')).json().bytes).toBeLessThanOrEqual(100 * 1024 * 1024);
    expect(existsSync(join(directory, `v1-${'0'.repeat(64)}.wav`))).toBe(false);
    expect((await synthesize(app)).headers['x-voice-cache']).toBe('hit');
  });
});

describe('cloud voice failures do not expose provider bodies or keys', () => {
  it('requires MiniMax selection and a key for uncached audio', async () => {
    const voiceFetch = mockVoice(); const { app } = create({ voiceFetch });
    expect((await synthesize(app)).json().code).toBe('VOICE_PROVIDER_DISABLED');
    await app.inject({ method: 'PATCH', url: '/api/voice/settings', payload: { provider: 'minimax' } });
    const missing = await synthesize(app); expect(missing.statusCode).toBe(503); expect(missing.json().code).toBe('VOICE_NOT_CONFIGURED');
    expect(voiceFetch).not.toHaveBeenCalled();
  });
  it.each([{ text: '' }, { text: '  ' }, { text: 'あ'.repeat(1501) }, { text: 'あ', rate: 0.59 }, { text: 'あ', rate: 1.21 }, { text: 'あ', speaker: 'other' }, { text: 'あ', model: 'other' }])('rejects invalid synthesis input: %j', async payload => {
    const voiceFetch = mockVoice(); const { app } = create({ voiceFetch }); await configure(app);
    expect((await synthesize(app, payload)).statusCode).toBe(400); expect(voiceFetch).not.toHaveBeenCalled();
  });
  it.each([[401, 'VOICE_AUTH_FAILED'], [403, 'VOICE_AUTH_FAILED'], [429, 'VOICE_QUOTA_EXCEEDED'], [500, 'VOICE_UNAVAILABLE']])('maps provider status %s to a safe localized error', async (status, code) => {
    const voiceFetch = vi.fn<typeof fetch>().mockResolvedValue(new Response(`provider secret ${key}`, { status: Number(status) }));
    const { app } = create({ voiceFetch }); await configure(app);
    const response = await synthesize(app);
    expect(response.json().code).toBe(code); expect(response.body).not.toContain(key); expect(response.body).not.toContain('provider secret');
    expect((await app.inject('/api/voice/cache')).json().clips).toBe(0);
  });
  it.each([[1004, 'VOICE_AUTH_FAILED'], [1008, 'VOICE_QUOTA_EXCEEDED'], [1002, 'VOICE_QUOTA_EXCEEDED'], [2056, 'VOICE_QUOTA_EXCEEDED'], [9999, 'VOICE_UNAVAILABLE']])('rejects HTTP 200 business failure %s without caching or exposing provider messages', async (status, code) => {
    const voiceFetch = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ base_resp: { status_code: status, status_msg: `private ${key}` } })));
    const { app } = create({ voiceFetch }); await configure(app);
    const response = await synthesize(app);
    expect(response.json().code).toBe(code); expect(response.statusCode).toBe(code === 'VOICE_QUOTA_EXCEEDED' ? 503 : 502);
    expect(response.body).not.toContain(key); expect(response.body).not.toContain('private');
    expect((await app.inject('/api/voice/cache')).json()).toEqual({ clips: 0, bytes: 0 });
  });
  it.each(['abc', '0x12', 'zz', '', 'aa aa'])('rejects invalid hex audio %j', async audio => {
    const voiceFetch = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ base_resp: { status_code: 0 }, data: { status: 2, audio } })));
    const { app } = create({ voiceFetch }); await configure(app);
    expect((await synthesize(app)).json().code).toBe('VOICE_INVALID_AUDIO');
    expect((await app.inject('/api/voice/cache')).json().clips).toBe(0);
  });
  it('sanitizes network failures and rejects malformed, truncated and oversized audio before caching', async () => {
    const voiceFetch = mockVoice().mockRejectedValueOnce(new Error(key));
    const { app } = create({ voiceFetch }); await configure(app);
    const network = await synthesize(app); expect(network.json().code).toBe('VOICE_UNAVAILABLE'); expect(network.body).not.toContain(key);
    const malformed = wav(); malformed.writeUInt32LE(1000000, 40);
    for (const audio of [Buffer.from('RIFFfake'), wav().subarray(0, 50), malformed, wav(8 * 1024 * 1024)]) {
      voiceFetch.mockResolvedValueOnce(audioResponse(audio));
      expect((await synthesize(app)).json().code).toBe('VOICE_INVALID_AUDIO');
    }
    expect((await app.inject('/api/voice/cache')).json().clips).toBe(0);
  });
  it('aborts the entire request after 25 seconds even when a provider ignores cancellation', async () => {
    const voiceFetch = vi.fn<typeof fetch>().mockImplementation(() => new Promise<Response>(() => {}));
    const { app } = create({ voiceFetch }); await configure(app);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const request = synthesize(app).then(response => response);
    await vi.waitFor(() => expect(voiceFetch).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(25001);
    const response = await request;
    expect(response.statusCode).toBe(504); expect(response.json().code).toBe('VOICE_TIMEOUT');
    expect(voiceFetch.mock.calls[0]![1]!.signal!.aborted).toBe(true);
  });
});
