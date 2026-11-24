import { useEffect, useRef, useState } from 'react';
import { api } from './api';
export function useKatakanaCredit() {
  const [pending, setPending] = useState(false), [error, setError] = useState('');
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);
  async function record(id: string, mode: 'kana' | 'ai', prompt: string, answer: string) {
    if (request.current) return false;
    const controller = new AbortController(); request.current = controller; setPending(true); setError('');
    const timer = setTimeout(() => controller.abort(), 10000);
    try {
      await api('/katakana/complete', { method: 'POST', signal: controller.signal, body: JSON.stringify({ id, mode, prompt, answer }) });
      if (controller.signal.aborted) return false;
      window.dispatchEvent(new Event('practice-assessed')); return true;
    } catch { if (!controller.signal.aborted) setError('进度保存失败，请按回车重试。'); else setError('保存超时，请按回车重试。'); return false; }
    finally { clearTimeout(timer); request.current = null; setPending(false); }
  }
  return { record, pending, error };
}
