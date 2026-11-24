import { api, ClientApiError } from './api';
import type { ScheduleDocument, ScheduleState } from '../shared/schedule';

const key = 'weekly-rhythm-planner-v1';
const recoveryKey = 'weekly-rhythm-planner-unsynced-v1';
export async function openScheduleSync() {
  const initial = await api<ScheduleDocument>('/schedule');
  let revision = initial.revision;
  let canonical = initial.state ? JSON.stringify(initial.state) : null;
  let current = canonical, queued: string | null = null, running = false, disposed = false;
  let status = '已保存到服务器', failed = false;
  let listener: ((message: string, error: boolean) => void) | undefined;
  const report = (message: string, error = false) => {
    status = message; failed = error;
    if (!disposed) listener?.(message, error);
  };
  async function flush() {
    if (running || !queued) return;
    running = true;
    try {
      while (queued) {
        const value = queued; queued = null;
        report('正在保存到服务器…');
        try {
          const saved = await api<ScheduleDocument>('/schedule', { method: 'PUT', body: JSON.stringify({ revision, state: JSON.parse(value) as ScheduleState }) });
          revision = saved.revision; canonical = value;
          try { if (localStorage.getItem(recoveryKey) === value) localStorage.removeItem(recoveryKey); } catch {}
        } catch (error) {
          if (!queued) queued = value;
          report(error instanceof ClientApiError && error.status === 409 ? error.message : '暂未同步到服务器，本机改动已保留。联网后会重试，可先导出备份。', true);
          return;
        }
      }
      report('已保存到服务器');
    } finally { running = false; }
  }
  const retry = () => { if (!failed || status.includes('联网')) void flush(); };
  window.addEventListener('online', retry);
  return {
    storage: {
      getItem(name: string) { return name === key ? current : localStorage.getItem(name); },
      setItem(name: string, value: string) {
        if (name !== key) { localStorage.setItem(name, value); return; }
        current = value;
        try { localStorage.setItem(key, value); } catch {}
        if (value !== canonical) {
          try { localStorage.setItem(recoveryKey, value); } catch {}
          queued = value;
          if (!failed) void flush();
        }
        queueMicrotask(() => report(status, failed));
      },
    },
    setStatusListener(callback: typeof listener) { listener = callback; listener?.(status, failed); },
    dispose() { disposed = true; listener = undefined; window.removeEventListener('online', retry); },
  };
}
