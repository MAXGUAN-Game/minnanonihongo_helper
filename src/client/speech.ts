import { useCallback, useEffect, useRef, useState } from 'react';
import type { Recording } from '../shared/recordings';
export { useSpeech, type Speech, type PlaybackStatus } from './playback';

export async function encodeWav(blob: Blob): Promise<Blob> {
  const context = new AudioContext();
  try {
    const decoded = await context.decodeAudioData(await blob.arrayBuffer());
    // MediaRecorder's 30-second timer can fire a little late on mobile. Keep
    // the original local preview, but cap the server WAV to exactly 30 seconds.
    const offline = new OfflineAudioContext(1, Math.min(30 * 16000, Math.ceil(decoded.duration * 16000)), 16000);
    const source = offline.createBufferSource(); source.buffer = decoded; source.connect(offline.destination); source.start();
    const rendered = await offline.startRendering(); const samples = rendered.getChannelData(0);
    const rms = Math.sqrt(samples.reduce((sum, sample) => sum + sample * sample, 0) / samples.length);
    if (decoded.duration < .25 || rms < .002) throw new Error('没有听到清楚的声音。请靠近麦克风，再说一次。');
    const buffer = new ArrayBuffer(44 + samples.length * 2); const view = new DataView(buffer);
    const ascii = (offset: number, value: string) => [...value].forEach((c, i) => view.setUint8(offset + i, c.charCodeAt(0)));
    ascii(0, 'RIFF'); view.setUint32(4, buffer.byteLength - 8, true); ascii(8, 'WAVE'); ascii(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true); view.setUint32(24, 16000, true); view.setUint32(28, 32000, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true); ascii(36, 'data'); view.setUint32(40, samples.length * 2, true);
    samples.forEach((sample, i) => { const s = Math.max(-1, Math.min(1, sample)); view.setInt16(44 + i * 2, s < 0 ? s * 32768 : s * 32767, true); });
    return new Blob([buffer], { type: 'audio/wav' });
  } finally { await context.close(); }
}

export type RecordingContext = { lessonId: number; itemId: string; context: 'speak' | 'conversation' };
export type RecordedClip = { url: string; recordingId?: string; durationMs: number; saved: boolean };
type RecordingDraft = { generation: number; clientId: string; context?: RecordingContext; raw: Blob; wav?: Promise<Blob>; transcript?: string; savedId?: string };

export function useRecorder(onText: (text: string, ms: number, recordingId?: string) => void, onError: (message: string) => void, context?: RecordingContext) {
  const [status, setStatus] = useState<'idle' | 'asking' | 'recording' | 'transcribing'>('idle');
  const [clip, setClip] = useState<RecordedClip | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [transcribeError, setTranscribeError] = useState('');
  const phase = useRef(status);
  const recorder = useRef<MediaRecorder | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const pendingStop = useRef(false);
  const alive = useRef(true);
  const generation = useRef(0);
  const timeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const requests = useRef<Set<AbortController>>(new Set());
  const savingDraft = useRef<RecordingDraft | null>(null);
  const draft = useRef<RecordingDraft | null>(null);
  const clipUrl = useRef<string | null>(null);
  const callbacks = useRef({ onText, onError, context }); callbacks.current = { onText, onError, context };
  const update = useCallback((value: typeof status) => { phase.current = value; setStatus(value); }, []);
  const current = (value: RecordingDraft) => alive.current && value.generation === generation.current && draft.current === value;
  const release = useCallback(() => {
    stream.current?.getTracks().forEach(track => track.stop()); stream.current = null;
    if (timeout.current) clearTimeout(timeout.current); timeout.current = null;
  }, []);
  const stop = useCallback(() => { pendingStop.current = true; if (recorder.current?.state === 'recording') recorder.current.stop(); }, []);
  const cancel = useCallback(() => {
    generation.current++; pendingStop.current = true;
    for (const request of requests.current) request.abort(); requests.current.clear();
    if (recorder.current?.state === 'recording') recorder.current.stop(); recorder.current = null;
    release(); draft.current = null; savingDraft.current = null;
    if (clipUrl.current) URL.revokeObjectURL(clipUrl.current); clipUrl.current = null;
    if (alive.current) { update('idle'); setClip(null); setSaving(false); setSaveError(''); setTranscribeError(''); }
  }, [release, update]);
  const contextKey = context ? JSON.stringify([context.lessonId, context.context, context.itemId]) : '';
  useEffect(() => { alive.current = true; return () => { alive.current = false; cancel(); }; }, [cancel]);
  useEffect(() => { cancel(); }, [contextKey, cancel]);
  async function requestJSON<T>(path: string, init: RequestInit, value: RecordingDraft): Promise<T> {
    const controller = new AbortController(); requests.current.add(controller);
    try {
      if (!current(value)) throw new DOMException('Canceled', 'AbortError');
      const response = await fetch(path, { ...init, signal: controller.signal });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || '操作未成功，请重试。');
      return result as T;
    } finally { requests.current.delete(controller); }
  }
  function wavFor(value: RecordingDraft) {
    if (!value.wav) value.wav = encodeWav(value.raw).then(wav => {
      if (current(value)) setClip(previous => previous ? { ...previous, durationMs: Math.round((wav.size - 44) / 32) } : previous);
      return wav;
    }).catch(error => { value.wav = undefined; throw error; });
    return value.wav;
  }
  async function syncTranscript(value: RecordingDraft) {
    if (value.savedId && value.transcript !== undefined && current(value)) {
      await requestJSON(`/api/recordings/${encodeURIComponent(value.savedId)}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ transcript: value.transcript }),
      }, value);
      if (current(value)) window.dispatchEvent(new Event('nihongo-recordings-changed'));
    }
  }
  async function save(value: RecordingDraft) {
    if (!value.context || !current(value) || savingDraft.current === value) return;
    savingDraft.current = value; setSaving(true); setSaveError('');
    try {
      const wav = await wavFor(value); if (!current(value)) return;
      const query = new URLSearchParams({ lessonId: String(value.context.lessonId), context: value.context.context, itemId: value.context.itemId, clientRecordingId: value.clientId });
      const result = await requestJSON<Recording>(`/api/recordings?${query}`, { method: 'POST', headers: { 'Content-Type': 'audio/wav' }, body: wav }, value);
      if (!current(value)) return;
      value.savedId = result.id;
      setClip(previous => previous ? { ...previous, recordingId: result.id, durationMs: result.durationMs, saved: true } : previous);
      window.dispatchEvent(new Event('nihongo-recordings-changed'));
      await syncTranscript(value);
    } catch (error) {
      if (current(value) && (error as Error).name !== 'AbortError') setSaveError(value.savedId ? '录音已保存，文字同步失败。请重试保存。' : `录音还未保存。${error instanceof Error ? error.message : '请重试保存。'}`);
    } finally { if (savingDraft.current === value) savingDraft.current = null; if (current(value)) setSaving(false); }
  }
  async function transcribe(value: RecordingDraft) {
    if (!current(value)) return;
    update('transcribing'); setTranscribeError('');
    try {
      const wav = await wavFor(value); if (!current(value)) return;
      const result = await requestJSON<{ text: string; durationMs: number }>('/api/speech/transcribe', { method: 'POST', headers: { 'Content-Type': 'audio/wav' }, body: wav }, value);
      if (!current(value)) return;
      if (typeof result.text !== 'string') throw new Error('识别返回的文字无效，请重新识别。');
      value.transcript = result.text;
      callbacks.current.onText(result.text, result.durationMs, value.savedId);
      try { await syncTranscript(value); } catch { if (current(value)) setSaveError('录音已保存，文字同步失败。请重试保存。'); }
    } catch (error) {
      if (current(value) && (error as Error).name !== 'AbortError') {
        const message = error instanceof Error ? error.message : '识别未成功，请重试。';
        setTranscribeError(message); callbacks.current.onError(message);
      }
    } finally { if (current(value)) update('idle'); }
  }
  const start = async () => {
    if (phase.current !== 'idle') return;
    window.dispatchEvent(new Event('nihongo-recording-start'));
    cancel(); pendingStop.current = false;
    const thisGeneration = generation.current;
    const recordingContext = callbacks.current.context ? { ...callbacks.current.context } : undefined;
    update('asking');
    try {
      if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) throw new Error(window.isSecureContext ? '浏览器无法录音，请使用新版 Edge 或 Chrome。' : '录音需要安全连接，请使用 https:// 网站地址，或在本机用 localhost 打开。');
      const acquired = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
      if (thisGeneration !== generation.current || pendingStop.current || !alive.current) {
        acquired.getTracks().forEach(track => track.stop());
        if (alive.current && thisGeneration === generation.current) update('idle'); return;
      }
      stream.current = acquired;
      const mimeType = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'].find(type => MediaRecorder.isTypeSupported(type));
      const rec = new MediaRecorder(acquired, mimeType ? { mimeType } : undefined); recorder.current = rec;
      const chunks: Blob[] = []; const startedAt = Date.now();
      rec.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
      rec.onerror = () => { if (thisGeneration === generation.current && alive.current) { cancel(); callbacks.current.onError('录音中断，请重新开始。'); } };
      rec.onstop = () => {
        if (!alive.current || thisGeneration !== generation.current) return;
        release(); recorder.current = null;
        const raw = new Blob(chunks, { type: rec.mimeType });
        if (!raw.size) { update('idle'); callbacks.current.onError('没有收到录音，请重新开始。'); return; }
        const url = URL.createObjectURL(raw); clipUrl.current = url;
        const value: RecordingDraft = { generation: thisGeneration, clientId: crypto.randomUUID(), context: recordingContext, raw };
        draft.current = value;
        setClip({ url, durationMs: Date.now() - startedAt, saved: false });
        // Save and recognition deliberately run independently; either can be
        // retried with the same captured WAV while the local preview survives.
        void save(value); void transcribe(value);
      };
      rec.start(); update('recording'); timeout.current = setTimeout(stop, 30000);
    } catch (error) {
      if (!alive.current || thisGeneration !== generation.current) return;
      release(); update('idle');
      callbacks.current.onError(error instanceof DOMException && error.name === 'NotAllowedError' ? '麦克风未获允许。点地址栏的权限图标开启，或先用文字回答。' : error instanceof Error ? error.message : '麦克风无法使用。');
    }
  };
  const retrySave = () => { if (draft.current) void save(draft.current); };
  const retryTranscribe = () => { if (draft.current && phase.current === 'idle') void transcribe(draft.current); };
  return { status, start, stop, cancel, clear: cancel, clip, saving, saveError, transcribeError, retrySave, retryTranscribe };
}
