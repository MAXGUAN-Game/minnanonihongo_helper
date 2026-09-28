import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// Import the Node 18-compatible deployment helper without executing its CLI.
const helperUrl = pathToFileURL(path.resolve('deploy/configure.mjs')).href;
const { ensureCaddyImage, confirmAndPrepare, hashPassword } = await import(helperUrl);

const image = 'caddy:2.11.4-alpine';
const fakeHash = '$2a$14$' + 'A'.repeat(53);
const password = 'test-private-password-42';

function dockerResults(results: object[]) {
  return vi.fn(() => {
    const result = results.shift();
    if (!result) throw new Error('Unexpected Docker invocation in test');
    return result;
  });
}

function fakeHasher({ output = fakeHash + '\n', diagnostic = '', code = 0, failure, wait = false }: {
  output?: string; diagnostic?: string; code?: number; failure?: Error; wait?: boolean;
} = {}) {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    kill: vi.fn(() => true),
  });
  let input = '';
  child.stdin.on('data', chunk => { input += chunk.toString(); });
  const spawnProcess = vi.fn(() => {
    if (!wait) queueMicrotask(() => {
      if (failure) { child.emit('error', failure); return; }
      child.stdout.write(output);
      child.stderr.write(diagnostic);
      child.emit('close', code);
    });
    return child;
  });
  return { child, spawnProcess, input: () => input };
}

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('deployment image preparation before requesting a password', () => {
  it('uses an already imported image without any pull operation', () => {
    const run = dockerResults([{ status: 0 }, { status: 0 }]);
    const log = vi.fn();
    ensureCaddyImage({ run, log });
    expect(run.mock.calls).toHaveLength(2);
    expect(run).toHaveBeenNthCalledWith(2, 'docker', ['image', 'inspect', image], expect.objectContaining({ stdio: 'ignore' }));
    expect(log).toHaveBeenCalledWith(expect.stringContaining('跳过下载'));
  });

  it('shows real Docker pull diagnostics and checks that the download made the image available', () => {
    const run = dockerResults([{ status: 0 }, { status: 1 }, { status: 0 }, { status: 0 }]);
    ensureCaddyImage({ run, log: vi.fn() });
    expect(run).toHaveBeenNthCalledWith(3, 'docker', ['pull', image], expect.objectContaining({ stdio: 'inherit', timeout: 180_000 }));
    expect(run).toHaveBeenNthCalledWith(4, 'docker', ['image', 'inspect', image], expect.anything());
  });

  it('stops on a failed pull and offers offline import without requesting a password', async () => {
    const run = dockerResults([{ status: 0 }, { status: 1 }, { status: 1 }]);
    const question = vi.fn();
    await expect(confirmAndPrepare({
      existingConfig: false, question,
      prepareImage: () => ensureCaddyImage({ run, log: vi.fn() }), log: vi.fn(),
    })).rejects.toThrow(/还没有读取密码或修改配置[\s\S]*docker load/);
    expect(question).not.toHaveBeenCalled();
    expect(run).toHaveBeenCalledTimes(3);
  });

  it('identifies a timed-out download separately', () => {
    const run = dockerResults([{ status: 0 }, { status: 1 }, { status: null, error: { code: 'ETIMEDOUT' } }]);
    expect(() => ensureCaddyImage({ run, log: vi.fn() })).toThrow('镜像下载等待超时');
  });

  it('does not continue when a nominally successful pull left no usable local tag', () => {
    const run = dockerResults([{ status: 0 }, { status: 1 }, { status: 0 }, { status: 1 }]);
    expect(() => ensureCaddyImage({ run, log: vi.fn() })).toThrow('仍未找到本地 Caddy 镜像');
  });

  it('keeps existing settings without checking Docker or accessing the network', async () => {
    const prepareImage = vi.fn();
    const question = vi.fn().mockResolvedValue('');
    const permitted = await confirmAndPrepare({ existingConfig: true, question, prepareImage, shared: true, log: vi.fn() });
    expect(permitted).toBe(false);
    expect(question).toHaveBeenCalledTimes(1);
    expect(prepareImage).not.toHaveBeenCalled();
  });

  it('prepares the image only after an explicit UPDATE for existing settings', async () => {
    const events: string[] = [];
    const question = vi.fn(async () => { events.push('confirm existing settings'); return 'UPDATE'; });
    const prepareImage = vi.fn(() => { events.push('prepare image'); });
    expect(await confirmAndPrepare({ existingConfig: true, question, prepareImage, shared: true, log: vi.fn() })).toBe(true);
    expect(events).toEqual(['confirm existing settings', 'prepare image']);
    expect(prepareImage).toHaveBeenCalledWith(expect.objectContaining({ shared: true }));
  });

  it('does not suggest replacing a shared server container installation on daemon failure', () => {
    const run = dockerResults([{ status: 1 }]);
    expect(() => ensureCaddyImage({ run, shared: true, log: vi.fn() })).toThrow('不要直接重装系统或替换 Docker');
    expect(run).toHaveBeenCalledTimes(1);
  });
});

describe('local-only password hashing and safe failure messages', () => {
  it('passes the password only on stdin and forbids implicit pulls', async () => {
    const fake = fakeHasher();
    expect(await hashPassword(password, { spawnProcess: fake.spawnProcess })).toBe(fakeHash);
    expect(fake.spawnProcess).toHaveBeenCalledWith('docker', [
      'run', '--pull=never', '--rm', '-i', image, 'caddy', 'hash-password', '--algorithm', 'bcrypt',
    ], expect.objectContaining({ stdio: ['pipe', 'pipe', 'pipe'] }));
    expect(JSON.stringify(fake.spawnProcess.mock.calls)).not.toContain(password);
    expect(fake.input()).toBe(password + '\n');
  });

  it('reports invalid successful output without exposing stdout or stderr', async () => {
    const fake = fakeHasher({ output: password + fakeHash, diagnostic: password + fakeHash });
    const error = await hashPassword(password, { spawnProcess: fake.spawnProcess }).catch((caught: Error) => caught);
    expect(error.message).toContain('哈希格式不正确');
    expect(error.message).not.toContain(password);
    expect(error.message).not.toContain(fakeHash);
  });

  it('reports Caddy failure separately from invalid hash output and redacts all raw diagnostics', async () => {
    const fake = fakeHasher({ code: 1, diagnostic: `unexpected ${password} ${fakeHash}` });
    const error = await hashPassword(password, { spawnProcess: fake.spawnProcess }).catch((caught: Error) => caught);
    expect(error.message).toContain('Caddy 密码处理失败（退出码 1）');
    expect(error.message).not.toContain(password);
    expect(error.message).not.toContain(fakeHash);
  });

  it('identifies Docker container startup failure', async () => {
    const fake = fakeHasher({ code: 125, diagnostic: password });
    await expect(hashPassword(password, { spawnProcess: fake.spawnProcess })).rejects.toThrow('Docker 未能启动 Caddy 密码处理容器（退出码 125）');
  });

  it('reports an image disappearing after preflight without enabling network pulls', async () => {
    const fake = fakeHasher({ code: 125, diagnostic: `No such image: ${image} ${password}` });
    await expect(hashPassword(password, { spawnProcess: fake.spawnProcess })).rejects.toThrow('密码处理禁止自动下载');
  });

  it('recognizes Docker daemon permission errors without displaying secret-bearing stderr', async () => {
    const fake = fakeHasher({ code: 125, diagnostic: `permission denied ${password}` });
    const error = await hashPassword(password, { spawnProcess: fake.spawnProcess }).catch((caught: Error) => caught);
    expect(error.message).toContain('Docker 服务连接或权限检查失败');
    expect(error.message).not.toContain(password);
  });

  it('handles failure to spawn Docker without passing through error.message', async () => {
    const fake = fakeHasher({ failure: new Error(`ENOENT ${password}`) });
    const error = await hashPassword(password, { spawnProcess: fake.spawnProcess }).catch((caught: Error) => caught);
    expect(error.message).toContain('Docker 密码处理命令未能启动');
    expect(error.message).not.toContain(password);
  });

  it('ends a stalled hash command and reports a local processing timeout', async () => {
    vi.useFakeTimers();
    const fake = fakeHasher({ wait: true });
    const result = hashPassword(password, { spawnProcess: fake.spawnProcess, timeoutMs: 60_000 });
    const rejected = expect(result).rejects.toThrow('密码处理等待超时');
    await vi.advanceTimersByTimeAsync(60_000);
    await rejected;
    expect(fake.child.kill).toHaveBeenCalledTimes(1);
  });
});
