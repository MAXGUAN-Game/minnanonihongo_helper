import { afterEach, describe, expect, it, vi } from 'vitest';
import { PracticePrefetch } from '../src/client/practice-prefetch';
import { ClientApiError } from '../src/client/api';
import type { PracticeCurrent, PracticeQuestion } from '../src/shared/ai-practice';

const question = (id: number): PracticeCurrent => ({ question: { id: String(id) } as PracticeQuestion, attempt: null });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
const pools: PracticePrefetch[] = [];
function create(load: (id: string, signal: AbortSignal) => Promise<PracticeCurrent>) { const pool = new PracticePrefetch(load); pools.push(pool); return pool; }
afterEach(() => { pools.splice(0).forEach(pool => pool.pause()); vi.useRealTimers(); });

describe('five-question background buffer', () => {
  it('stops at five future questions and immediately replenishes a consumed slot', async () => {
    const load = vi.fn(async () => question(load.mock.calls.length));
    const pool = create(load); pool.start(); pool.start();
    await vi.waitFor(() => expect(pool.status).toEqual({ count: 5, loading: false, error: '' }));
    expect(load).toHaveBeenCalledTimes(5);
    expect((await pool.take(new AbortController().signal)).question?.id).toBe('1');
    await vi.waitFor(() => expect(pool.status.count).toBe(5));
    expect(load).toHaveBeenCalledTimes(6);
    pool.start(); expect(load).toHaveBeenCalledTimes(6);
  });
  it('waits for the existing pending question instead of generating a duplicate or waiting for all five', async () => {
    const first = deferred<PracticeCurrent>(), second = deferred<PracticeCurrent>();
    const load = vi.fn().mockImplementationOnce(() => first.promise).mockImplementation(() => second.promise);
    const pool = create(load); pool.start();
    const next = pool.take(new AbortController().signal);
    await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(1));
    first.resolve(question(1)); expect((await next).question?.id).toBe('1');
    await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(2));
    expect(pool.status).toEqual({ count: 0, loading: true, error: '' });
  });
  it('preserves ready questions after failure and retries with the same request identifier', async () => {
    const load = vi.fn(async (_id: string, _signal: AbortSignal) => {
      if (load.mock.calls.length === 3) throw new ClientApiError('Unavailable', 503, 'PRACTICE_UNAVAILABLE');
      return question(load.mock.calls.length);
    });
    const pool = create(load); pool.start();
    await vi.waitFor(() => expect(pool.status).toEqual({ count: 2, loading: false, error: 'Unavailable' }));
    pool.start(); expect(load).toHaveBeenCalledTimes(3);
    expect((await pool.take(new AbortController().signal)).question?.id).toBe('1');
    await vi.waitFor(() => expect(pool.status.count).toBe(5));
    expect(load.mock.calls[2][0]).toBe(load.mock.calls[3][0]);
    expect(load).toHaveBeenCalledTimes(7);
  });
  it('aborts a waiting consumer without aborting or draining its background producer', async () => {
    const ready = deferred<PracticeCurrent>();
    const load = vi.fn(async () => ready.promise);
    const pool = create(load); pool.start();
    const controller = new AbortController();
    const next = pool.take(controller.signal); const rejected = expect(next).rejects.toMatchObject({ name: 'AbortError' });
    controller.abort(); await rejected;
    expect(pool.status.loading).toBe(true);
    pool.pause();
  });
  it('ignores late responses after pause, then resumes the same request safely', async () => {
    const stale = deferred<PracticeCurrent>(), resumed = deferred<PracticeCurrent>();
    const load = vi.fn().mockImplementationOnce(() => stale.promise).mockImplementation(() => resumed.promise);
    const pool = create(load); pool.start(); await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(1));
    pool.pause(); expect(load.mock.calls[0][1].aborted).toBe(true);
    pool.start(); await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(2));
    expect(load.mock.calls[1][0]).toBe(load.mock.calls[0][0]);
    stale.resolve(question(1)); await Promise.resolve();
    expect(pool.status).toEqual({ count: 0, loading: true, error: '' });
    pool.pause();
  });
  it('stops after all vocabulary is mastered and discards stale mastered responses', async () => {
    const completed = { question: null, attempt: null, completed: true };
    const load = vi.fn().mockResolvedValueOnce({ question: null, attempt: null }).mockResolvedValue(completed);
    const pool = create(load); pool.start();
    expect(await pool.take(new AbortController().signal)).toEqual(completed);
    expect(load).toHaveBeenCalledTimes(2);
    expect(await pool.take(new AbortController().signal)).toEqual(completed);
    expect(load).toHaveBeenCalledTimes(2);
  });
  it('pauses after a timeout even if the provider ignores AbortSignal', async () => {
    vi.useFakeTimers();
    const load = vi.fn(() => new Promise<PracticeCurrent>(() => {}));
    const pool = create(load); pool.start();
    await vi.advanceTimersByTimeAsync(40000);
    expect(pool.status).toEqual({ count: 0, loading: false, error: '后续题目准备超时，请重试。' });
    await vi.advanceTimersByTimeAsync(120000); expect(load).toHaveBeenCalledTimes(1);
  });
  it('bounds repeated empty responses instead of generating forever', async () => {
    const load = vi.fn(async () => ({ question: null, attempt: null }));
    const pool = create(load); pool.start();
    await vi.waitFor(() => expect(pool.status.error).toBe('后续题目未完整返回，请重试。'));
    expect(load).toHaveBeenCalledTimes(5); expect(pool.status.loading).toBe(false);
  });
});
