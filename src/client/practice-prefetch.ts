import type { PracticeCurrent } from '../shared/ai-practice';
import { ClientApiError } from './api';

type Loader = (requestId: string, signal: AbortSignal) => Promise<PracticeCurrent>;
export type PrefetchStatus = { count: number; loading: boolean; error: string };

/** Only future questions live here. Taking one opens a slot immediately. */
export class PracticePrefetch {
  private queue: PracticeCurrent[] = [];
  private controller: AbortController | null = null;
  private requestId: string | null = null;
  private failure: Error | null = null;
  private completed: PracticeCurrent | null = null;
  private emptyResponses = 0;
  private active = false;
  private listeners = new Set<() => void>();
  private waiters = new Set<() => void>();

  constructor(private readonly load: Loader) {}
  get status(): PrefetchStatus { return { count: this.queue.length, loading: !!this.controller, error: this.failure?.message ?? '' }; }
  subscribe(listener: () => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  private notify() { this.listeners.forEach(listener => listener()); this.waiters.forEach(wake => wake()); }
  start() { this.active = true; this.fill(); }
  retry() { this.failure = null; this.start(); this.notify(); }
  pause() {
    this.active = false;
    const controller = this.controller; this.controller = null;
    controller?.abort(); this.notify();
  }
  discardWord(wordId: string) {
    // Cancel an in-flight draw as it may have selected this word before mastery was saved.
    this.pause(); this.requestId = null; this.failure = null;
    this.queue = this.queue.filter(value => value.question?.content.kind !== 'vocabulary' || value.question.content.wordId !== wordId);
    this.start(); this.notify();
  }
  private fill() {
    if (!this.active || this.controller || this.failure || this.completed || this.queue.length >= 5) return;
    const controller = new AbortController(); this.controller = controller;
    const requestId = this.requestId ??= crypto.randomUUID();
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
      }, 40000);
    });
    this.notify();
    void Promise.race([Promise.resolve().then(() => this.load(requestId, controller.signal)), expired, cancelled]).then(value => {
      if (!this.active || this.controller !== controller) return;
      if (value.question === undefined && !value.completed) throw new ClientApiError('后续题目未完整返回，请重试。', 502, 'PRACTICE_INVALID_RESPONSE');
      this.requestId = null;
      if (value.completed) this.completed = value;
      else if (value.question) { this.emptyResponses = 0; this.queue.push(value); }
      else if (++this.emptyResponses >= 5) throw new ClientApiError('后续题目未完整返回，请重试。', 502, 'PRACTICE_INVALID_RESPONSE');
    }).catch(failure => {
      if (this.active && this.controller === controller) this.failure = failure instanceof Error ? failure : new Error(String(failure));
    }).finally(() => {
      clearTimeout(timeout);
      controller.signal.removeEventListener('abort', abort);
      if (this.controller !== controller) return;
      this.controller = null; this.notify(); this.fill();
    });
  }
  async take(signal: AbortSignal): Promise<PracticeCurrent> {
    signal.throwIfAborted(); this.retry();
    for (;;) {
      signal.throwIfAborted();
      const next = this.queue.shift();
      if (next) { this.notify(); this.fill(); return next; }
      if (this.completed) return this.completed;
      if (this.failure) throw this.failure;
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
