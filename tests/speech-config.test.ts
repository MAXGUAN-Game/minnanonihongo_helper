import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import { getSpeechStatus, registerSpeechRoutes, speechPaths, speechThreads } from '../src/server/speech';

const directories: string[] = [];
function temporary() {
  const directory = mkdtempSync(path.join(tmpdir(), 'nihongo-speech-config-'));
  directories.push(directory); mkdirSync(path.join(directory, 'speech'));
  return directory;
}
afterEach(() => {
  vi.unstubAllEnvs();
  for (const directory of directories.splice(0)) {
    if (!path.resolve(directory).startsWith(path.resolve(tmpdir(), 'nihongo-speech-config-'))) throw new Error('Unexpected test directory');
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('speech deployment configuration', () => {
  it('preserves Windows paths and selects Linux paths without using an uploaded Windows binary', () => {
    const dataDir = temporary();
    writeFileSync(path.join(dataDir, 'speech', 'install.json'), JSON.stringify({ binary: 'runtime/alternate/whisper-cli.exe' }));
    expect(speechPaths(dataDir, {}, 'win32').binary).toBe(path.join(dataDir, 'speech', 'runtime', 'alternate', 'whisper-cli.exe'));
    expect(speechPaths(dataDir, {}, 'linux').binary).toBe(path.join(dataDir, 'speech', 'runtime', 'bin', 'whisper-cli'));
    expect(speechPaths(dataDir, {}, 'linux').model).toBe(path.join(dataDir, 'speech', 'ggml-small.bin'));
  });
  it('accepts a Linux installation manifest while refusing a manifest path outside the speech directory', () => {
    const dataDir = temporary();
    const manifest = path.join(dataDir, 'speech', 'install-linux.json');
    writeFileSync(manifest, JSON.stringify({ binary: 'runtime/custom/whisper-cli' }));
    expect(speechPaths(dataDir, {}, 'linux').binary).toBe(path.join(dataDir, 'speech', 'runtime', 'custom', 'whisper-cli'));
    writeFileSync(manifest, JSON.stringify({ binary: '../outside' }));
    expect(speechPaths(dataDir, {}, 'linux').binary).toBe(path.join(dataDir, 'speech', 'runtime', 'bin', 'whisper-cli'));
  });
  it('allows explicit absolute binary and model overrides for a Docker image', () => {
    const dataDir = temporary();
    const binary = path.resolve(dataDir, 'image', 'whisper-cli');
    const model = path.resolve(dataDir, 'models', 'ggml-small.bin');
    expect(speechPaths(dataDir, { WHISPER_BINARY: binary, WHISPER_MODEL: model }, 'linux')).toMatchObject({ binary, model });
    expect(() => speechPaths(dataDir, { WHISPER_BINARY: 'relative/whisper-cli' }, 'linux')).toThrow('WHISPER_BINARY must be an absolute path');
    expect(() => speechPaths(dataDir, { WHISPER_MODEL: 'relative/model.bin' }, 'linux')).toThrow('WHISPER_MODEL must be an absolute path');
  });
  it('matches thread defaults to CPU capacity and accepts only a bounded integer override', () => {
    expect(speechThreads({}, 2)).toBe(2);
    expect(speechThreads({}, 64)).toBe(8);
    expect(speechThreads({}, 0)).toBe(1);
    expect(speechThreads({ WHISPER_THREADS: '1' }, 8)).toBe(1);
    expect(speechThreads({ WHISPER_THREADS: '32' }, 2)).toBe(32);
    for (const value of ['0', '-1', '33', '1.5', '2e1', 'many']) expect(() => speechThreads({ WHISPER_THREADS: value }, 8)).toThrow('WHISPER_THREADS');
  });
  it('describes missing cloud speech components without Windows installation instructions', () => {
    const dataDir = temporary();
    expect(getSpeechStatus(dataDir, {}, 'win32').message).toContain('双击');
    for (const [environment, platform] of [[{}, 'linux'], [{ DEPLOYMENT: 'web' }, 'win32']] as const) {
      const status = getSpeechStatus(dataDir, environment, platform);
      expect(status).toMatchObject({ ready: false, modelReady: false, binaryReady: false });
      expect(status.message).toContain('语音识别服务');
      expect(status.message).not.toMatch(/本机|双击|Windows/);
    }
  });
  it('reports ready only when both configured speech files exist', () => {
    const dataDir = temporary();
    const environment = { WHISPER_BINARY: path.join(dataDir, 'whisper-cli'), WHISPER_MODEL: path.join(dataDir, 'small.bin') };
    writeFileSync(environment.WHISPER_BINARY, 'binary fixture');
    expect(getSpeechStatus(dataDir, environment, 'linux')).toMatchObject({ ready: false, binaryReady: true, modelReady: false });
    writeFileSync(environment.WHISPER_MODEL, 'model fixture');
    expect(getSpeechStatus(dataDir, environment, 'linux')).toMatchObject({ ready: true, message: '日语语音识别服务已就绪' });
  });
  it('returns an actionable cloud error when recording reaches an unconfigured server', async () => {
    vi.stubEnv('DEPLOYMENT', 'web');
    vi.stubEnv('WHISPER_BINARY', ''); vi.stubEnv('WHISPER_MODEL', ''); vi.stubEnv('WHISPER_THREADS', '2');
    const app = Fastify();
    registerSpeechRoutes(app, temporary());
    try {
      const response = await app.inject({ method: 'POST', url: '/api/speech/transcribe', headers: { 'Content-Type': 'audio/wav' }, payload: Buffer.from('recording fixture') });
      expect(response.statusCode).toBe(503);
      expect(response.json()).toMatchObject({ code: 'SPEECH_NOT_INSTALLED' });
      expect(response.json().error).toContain('服务器');
      expect(response.json().error).not.toMatch(/本机|双击|Windows/);
    } finally { await app.close(); }
  });
});
