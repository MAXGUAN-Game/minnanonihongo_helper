import type { PracticeCurrent } from '../shared/ai-practice';
import { ClientApiError } from './api';

type Loader = (requestId: string, signal: AbortSignal) => Promise<PracticeCurrent>;
type Restorer = (signal: AbortSignal) => Promise<PracticeCurrent[]>;
export type PrefetchStatus = { count: number; loading: boolean; error: string };

/** Only future questions live here. Taking one opens a slot immediately. */
export class PracticePrefetch {
  private queue: PracticeCurrent[] = [];
  private controllers = new Map<AbortController, string>();
  private requestIds: string[] = [];
  private failure: Error | null = null;
  private completed: PracticeCurrent | null = null;
  private emptyResponses = 0;
  private active = false;
  private restored = false;
  private restoring: AbortController | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retries = 0;
  private listeners = new Set<() => void>();
  private waiters = new Set<() => void>();

  constructor(private readonly load: Loader, private readonly restore?: Restorer, private readonly concurrency = 1) {
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 2) throw new RangeError('Prefetch concurrency must be 1 or 2');
  }
  get status(): PrefetchStatus { return { count: this.queue.length, loading: this.controllers.size > 0 || !!this.restoring || !!this.retryTimer, error: this.failure?.message ?? '' }; }
  subscribe(listener: () => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  private notify() { this.listeners.forEach(listener => listener()); this.waiters.forEach(wake => wake()); }
  start() { this.active = true; this.fill(); }
  retry() { if (this.retryTimer) clearTimeout(this.retryTimer); this.retryTimer = null; this.failure = null; this.retries = 0; this.start(); this.notify(); }
  pause() {
    this.active = false;
    this.restoring?.abort(); this.restoring = null;
    if (this.retryTimer) clearTimeout(this.retryTimer); this.retryTimer = null;
    const controllers = [...this.controllers]; this.controllers.clear();
    for (const [controller, id] of controllers) { this.requestIds.push(id); controller.abort(); }
    this.notify();
  }
  discardWord(wordId: string) {
    // Cancel an in-flight draw as it may have selected this word before mastery was saved.
    this.pause(); this.requestIds = []; this.failure = null;
    this.queue = this.queue.filter(value => value.question?.content.kind !== 'vocabulary' || value.question.content.wordId !== wordId);
    this.start(); this.notify();
  }
  private fill() {
    if (!this.active || this.failure || this.completed || this.queue.length + this.controllers.size >= 5) return;
    if (!this.restored && this.restore) {
      if (this.restoring) return;
      const controller = new AbortController(); this.restoring = controller;
      const timer = setTimeout(() => controller.abort(), 10000);
      this.notify();
      const aborted = new Promise<never>((_, reject) => controller.signal.addEventListener('abort', () => reject(new DOMException('Cancelled', 'AbortError')), { once: true }));
      void Promise.race([Promise.resolve().then(() => this.restore!(controller.signal)), aborted]).then(values => {
        if (!this.active || this.restoring !== controller) return;
        const ids = new Set(this.queue.map(value => value.question?.id));
        for (const value of values) if (value.question && !value.attempt && !ids.has(value.question.id) && this.queue.length < 5) { this.queue.push(value); ids.add(value.question.id); }
      }).catch(() => { /* If restoration is unavailable, fresh generation still works. */ }).finally(() => {
        clearTimeout(timer);
        if (this.restoring !== controller) return;
        this.restoring = null; this.restored = true; this.notify(); this.fill();
      });
      return;
    }
    while (this.controllers.size < this.concurrency && this.queue.length + this.controllers.size < 5) this.produce();
  }
  private produce() {
    const controller = new AbortController();
    const requestId = this.requestIds.shift() ?? crypto.randomUUID();
    this.controllers.set(controller, requestId);
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let abort: () => void;
    const cancelled = new Promise<never>((_, reject) => {
      abort = () => reject(new DOMException('Cancelled', 'AbortError'));
      controller.signal.addEventListener('abort', abort, { once: true });
    });
    const expired = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => {
        reject(new ClientApiError('后续题目准备超时，请重试。', 504, 'PRACTICE_TIMEOUT'));
        controller.abort();
      }, 75000);
    });
    this.notify();
    void Promise.race([Promise.resolve().then(() => this.load(requestId, controller.signal)), expired, cancelled]).then(value => {
      if (!this.active || !this.controllers.has(controller)) return;
      if (value.question === undefined && !value.completed) throw new ClientApiError('后续题目未完整返回，请重试。', 502, 'PREFETCH_INCOMPLETE_RESPONSE');
      if (value.completed) { this.retries = 0; this.completed = value; }
      else if (value.question) { if (!this.failure) this.retries = 0; this.emptyResponses = 0; this.queue.push(value); }
      else if (++this.emptyResponses >= 5) throw new ClientApiError('后续题目未完整返回，请重试。', 502, 'PREFETCH_INCOMPLETE_RESPONSE');
    }).catch(failure => {
      if (!this.active || !this.controllers.has(controller)) return;
      this.requestIds.push(requestId);
      const transient = failure instanceof ClientApiError
        ? !['PRACTICE_AUTH_FAILED', 'PRACTICE_NOT_CONFIGURED', 'PREFETCH_INCOMPLETE_RESPONSE'].includes(failure.code ?? '') && (failure.status === 408 || failure.status === 429 || failure.status >= 500)
        : failure instanceof TypeError;
      // A terminal configuration error must not be overwritten by another lane.
      if (this.failure && !this.retryTimer) return;
      this.failure = failure instanceof Error ? failure : new Error(String(failure));
      if (!transient) { if (this.retryTimer) clearTimeout(this.retryTimer); this.retryTimer = null; return; }
      if (!this.retryTimer) {
        const delay = [1500, 5000, 15000, 30000][Math.min(this.retries++, 3)];
        this.retryTimer = setTimeout(() => { this.retryTimer = null; if (this.active) { this.failure = null; this.notify(); this.fill(); } }, delay);
      }
    }).finally(() => {
      clearTimeout(timeout);
      controller.signal.removeEventListener('abort', abort);
      if (!this.controllers.delete(controller)) return;
      this.notify(); this.fill();
    });
  }
  async take(signal: AbortSignal): Promise<PracticeCurrent> {
    signal.throwIfAborted();
    // Join the producer's current retry/backoff; consuming a ready question must
    // not reset its budget or start another full retry sequence in the UI.
    if (!this.active || (this.failure && !this.retryTimer && !this.controllers.size)) this.retry();
    else this.start();
    for (;;) {
      signal.throwIfAborted();
      const next = this.queue.shift();
      if (next) { this.notify(); this.fill(); return next; }
      if (this.completed) return this.completed;
      if (this.failure && !this.retryTimer && !this.controllers.size) throw this.failure;
      if (!this.active) throw new DOMException('Cancelled', 'AbortError');
      await new Promise<void>((resolve, reject) => {
        const cleanup = () => { this.waiters.delete(wake); signal.removeEventListener('abort', abort); };
        const wake = () => { cleanup(); resolve(); };
        const abort = () => { cleanup(); reject(new DOMException('Cancelled', 'AbortError')); };
        this.waiters.add(wake); signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
      });
    }
  }
}
