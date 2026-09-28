import { useCallback, useEffect, useRef, useState } from 'react';

import type { VoiceSettings } from '../shared/voice';

export function useSpeech(onError: (message: string) => void) {
  const [speaking, setSpeaking] = useState(false);
  const voices = useRef<SpeechSynthesisVoice[]>([]);
  const token = useRef(0);
  const utterances = useRef<SpeechSynthesisUtterance[]>([]);
  const activeRequest = useRef<AbortController | null>(null);
  const cancelPlayback = useRef<(() => void) | null>(null);
  const callbacks = useRef({ onError }); callbacks.current = { onError };
  const stop = useCallback(() => {
    token.current++;
    activeRequest.current?.abort(); activeRequest.current = null;
    cancelPlayback.current?.(); cancelPlayback.current = null;
    if ('speechSynthesis' in window) window.speechSynthesis.cancel();
    utterances.current = []; setSpeaking(false);
  }, []);
  useEffect(() => {
    const update = () => { if ('speechSynthesis' in window) voices.current = window.speechSynthesis.getVoices(); };
    update();
    if ('speechSynthesis' in window) window.speechSynthesis.addEventListener('voiceschanged', update);
    const hidden = () => { if (document.hidden) stop(); };
    document.addEventListener('visibilitychange', hidden);
    window.addEventListener('voice-settings-changed', stop);
    return () => {
      stop();
      if ('speechSynthesis' in window) window.speechSynthesis.removeEventListener('voiceschanged', update);
      document.removeEventListener('visibilitychange', hidden);
      window.removeEventListener('voice-settings-changed', stop);
    };
  }, [stop]);
  const say = useCallback((text: string | string[], lang: 'ja-JP' | 'zh-CN' = 'ja-JP', rate = 1) => {
    stop();
    const current = token.current;
    const lines = (Array.isArray(text) ? text : [text]).map(line => line.trim()).filter(Boolean);
    if (!lines.length) return;
    let playbackRate = rate;
    const systemSay = (remaining: string[]) => {
      if (current !== token.current) return;
      if (!('speechSynthesis' in window)) { setSpeaking(false); callbacks.current.onError('这个浏览器不能朗读，请使用新版 Edge 或 Chrome。'); return; }
      voices.current = window.speechSynthesis.getVoices();
      const voice = voices.current.find(v => v.localService && v.lang.toLowerCase() === lang.toLowerCase()) || voices.current.find(v => v.localService && v.lang.startsWith(lang.slice(0, 2)));
      if (!voice) { setSpeaking(false); callbacks.current.onError(`未找到这个设备的${lang === 'ja-JP' ? '日语' : '中文'}声音。Windows 可到设置 → 时间和语言 → 语音添加语音包；其他设备请检查系统语音设置，然后重新打开浏览器。`); return; }
      setSpeaking(true);
      utterances.current = remaining.map((line, index) => {
        const u = new SpeechSynthesisUtterance(line); u.lang = lang; u.voice = voice; u.rate = playbackRate;
        u.onend = () => { if (current === token.current && index === remaining.length - 1) { setSpeaking(false); utterances.current = []; } };
        u.onerror = event => { if (current !== token.current) return; setSpeaking(false); if (!['interrupted', 'canceled'].includes(event.error)) callbacks.current.onError('朗读未成功。请重试，或在设置里检查系统声音。'); };
        return u;
      });
      utterances.current.forEach(u => window.speechSynthesis.speak(u));
    };
    if (lang === 'zh-CN') { systemSay(lines); return; }
    const request = new AbortController(); activeRequest.current = request;
    setSpeaking(true);
    let index = 0;
    void (async () => {
      try {
        // Read on demand so a saved voice choice takes effect on the very next tap.
        const response = await fetch('/api/voice/settings', { signal: request.signal });
        if (!response.ok) throw new Error('无法读取语音设置。');
        const settings = await response.json() as VoiceSettings;
        if (current !== token.current) return;
        if (typeof settings.speed === 'number' && settings.speed >= .8 && settings.speed <= 1.2) playbackRate = rate * settings.speed;
        if (settings.provider === 'system') { systemSay(lines); return; }
        if (settings.provider !== 'minimax') throw new Error('语音服务设置无效。');
        for (index = 0; index < lines.length; index++) {
          if (current !== token.current) return;
          const clip = await fetch('/api/voice/synthesize', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: lines[index], rate, speaker: index % 2 ? 'secondary' : 'primary' }),
            signal: request.signal,
          });
          if (!clip.ok) {
            const failure = await clip.json().catch(() => ({}));
            throw new Error(typeof failure.error === 'string' ? failure.error : '云端语音暂时没有响应。');
          }
          const blob = await clip.blob();
          if (current !== token.current) return;
          await new Promise<void>((resolve, reject) => {
            const url = URL.createObjectURL(blob);
            const audio = new Audio(url);
            let settled = false;
            const finish = (error?: Error) => {
              if (settled) return; settled = true;
              audio.onended = null; audio.onerror = null;
              audio.pause(); audio.removeAttribute('src'); audio.load();
              URL.revokeObjectURL(url);
              if (cancelPlayback.current === cancel) cancelPlayback.current = null;
              if (error) reject(error); else resolve();
            };
            const cancel = () => finish();
            cancelPlayback.current = cancel;
            audio.onended = () => finish();
            audio.onerror = () => finish(new Error('音频未能播放。'));
            audio.play().catch(() => finish(new Error('浏览器未能播放云端语音，请再次点击朗读。')));
          });
        }
        if (current === token.current) setSpeaking(false);
      } catch (error) {
        if (current !== token.current || request.signal.aborted) return;
        callbacks.current.onError(`${error instanceof Error ? error.message : '云端语音暂时不可用。'} 已改用本机朗读，可在设置里重新试听。`);
        systemSay(lines.slice(index));
      } finally { if (activeRequest.current === request) activeRequest.current = null; }
    })();
  }, [stop]);
  return { say, stop, speaking };
}
export type Speech = ReturnType<typeof useSpeech>;

export async function encodeWav(blob: Blob): Promise<Blob> {
  const context = new AudioContext();
  try {
    const decoded = await context.decodeAudioData(await blob.arrayBuffer());
    const offline = new OfflineAudioContext(1, Math.ceil(decoded.duration * 16000), 16000);
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

export function useRecorder(onText: (text: string, ms: number) => void, onError: (message: string) => void) {
  const [status, setStatus] = useState<'idle' | 'asking' | 'recording' | 'transcribing'>('idle');
  const recorder = useRef<MediaRecorder | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const pendingStop = useRef(false);
  const starting = useRef(false);
  const alive = useRef(true);
  const timeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const request = useRef<AbortController | null>(null);
  const callbacks = useRef({ onText, onError }); callbacks.current = { onText, onError };
  const release = () => { stream.current?.getTracks().forEach(track => track.stop()); stream.current = null; if (timeout.current) clearTimeout(timeout.current); };
  const stop = useCallback(() => { pendingStop.current = true; if (recorder.current?.state === 'recording') recorder.current.stop(); }, []);
  useEffect(() => { alive.current = true; return () => { alive.current = false; pendingStop.current = true; request.current?.abort(); if (recorder.current?.state === 'recording') recorder.current.stop(); release(); }; }, []);
  const start = async () => {
    if (starting.current || recorder.current?.state === 'recording' || status === 'transcribing') return;
    starting.current = true; pendingStop.current = false; setStatus('asking');
    try {
      if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) throw new Error(window.isSecureContext ? '浏览器无法录音，请使用新版 Edge 或 Chrome。' : '录音需要安全连接，请使用 https:// 网站地址，或在本机用 localhost 打开。');
      stream.current = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
      if (pendingStop.current || !alive.current) { release(); if (alive.current) setStatus('idle'); return; }
      const mimeType = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'].find(type => MediaRecorder.isTypeSupported(type));
      const rec = new MediaRecorder(stream.current, mimeType ? { mimeType } : undefined); recorder.current = rec;
      const chunks: Blob[] = []; rec.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
      rec.onerror = () => { release(); if (alive.current) { setStatus('idle'); callbacks.current.onError('录音中断，请重新开始。'); } };
      rec.onstop = async () => {
        release(); recorder.current = null; if (!alive.current) return;
        setStatus('transcribing');
        try {
          const wav = await encodeWav(new Blob(chunks, { type: rec.mimeType })); if (!alive.current) return;
          request.current = new AbortController();
          const response = await fetch('/api/speech/transcribe', { method: 'POST', body: wav, headers: { 'Content-Type': 'audio/wav' }, signal: request.current.signal });
          const result = await response.json(); if (!response.ok) throw new Error(result.error || '识别失败，请重试。');
          if (alive.current) callbacks.current.onText(result.text, result.durationMs);
        } catch (error) { if (alive.current && !(error instanceof DOMException && error.name === 'AbortError')) callbacks.current.onError(error instanceof Error ? error.message : '录音未成功，请重试。'); }
        finally { if (alive.current) setStatus('idle'); }
      };
      rec.start(); setStatus('recording'); timeout.current = setTimeout(stop, 30000);
    } catch (error) { release(); if (alive.current) { setStatus('idle'); callbacks.current.onError(error instanceof DOMException && error.name === 'NotAllowedError' ? '麦克风未获允许。点地址栏的权限图标开启，或先用文字回答。' : error instanceof Error ? error.message : '麦克风无法使用。'); } }
    finally { starting.current = false; }
  };
  return { status, start, stop };
}
