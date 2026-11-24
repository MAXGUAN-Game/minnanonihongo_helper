import { useCallback, useEffect, useRef, useState } from 'react';
import type { VoiceSettings, VoiceSpeaker, PlayerVoiceEngine } from '../shared/voice';
import { isOfficialTextbookAudioUrl } from '../content/textbook-audio';
import { japaneseVoice, nativeJapaneseText, systemVoices } from './japanese-voice';

export type PlaybackStatus = 'idle' | 'loading' | 'playing' | 'paused' | 'blocked' | 'buffering' | 'error';
type SpeechText = string | { jp: string; kana: string };

export function useSpeech(onError: (message: string) => void) {
  const engines = useRef(new Map<string, PlayerVoiceEngine>());
  const mediaSources = useRef(new Set<string>());
  const systemOnlySources = useRef(new Set<string>());
  const [, refreshEngines] = useState(0);
  const [playbackRate, setRate] = useState(1);
  const rateRef = useRef(1);
  const [status, setStatus] = useState<PlaybackStatus>('idle');
  const [label, setLabel] = useState('');
  const [sourceId, setSourceId] = useState<string>();
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState<number | null>(null);
  const [canSeek, setCanSeek] = useState(false);
  const [seekUnavailableReason, setSeekUnavailableReason] = useState('音频准备好后可快退或快进。');
  const source = useRef<string | undefined>(undefined);
  const hasSource = useRef(false);
  const phase = useRef<PlaybackStatus>('idle');
  const token = useRef(0);
  const epoch = useRef(0);
  const paused = useRef(false);
  const voices = useRef<SpeechSynthesisVoice[]>([]);
  const utterances = useRef<SpeechSynthesisUtterance[]>([]);
  const activeRequest = useRef<AbortController | null>(null);
  const activeAudio = useRef<HTMLAudioElement | null>(null);
  const playActive = useRef<((restart?: boolean) => void) | null>(null);
  const pauseActive = useRef<(() => void) | null>(null);
  const cancelPlayback = useRef<(() => void) | null>(null);
  const lastAction = useRef<(() => void) | null>(null);
  const restartSystem = useRef<(() => void) | null>(null);
  const sequence = useRef(false);
  const waiters = useRef<Set<() => void>>(new Set());
  const callbacks = useRef({ onError }); callbacks.current = { onError };
  const update = useCallback((next: PlaybackStatus) => { phase.current = next; setStatus(next); }, []);
  const wake = useCallback(() => { for (const resolve of waiters.current) resolve(); waiters.current.clear(); }, []);
  const resetTimeline = useCallback(() => { setPosition(0); setDuration(null); setCanSeek(false); setSeekUnavailableReason('音频准备好后可快退或快进。'); }, []);
  const stop = useCallback(() => {
    epoch.current++; token.current++; paused.current = false; hasSource.current = false; source.current = undefined;
    activeRequest.current?.abort(); activeRequest.current = null;
    cancelPlayback.current?.(); cancelPlayback.current = null;
    activeAudio.current = null; playActive.current = null; pauseActive.current = null;
    restartSystem.current = null;
    if ('speechSynthesis' in window) window.speechSynthesis.cancel();
    utterances.current = []; wake(); update('idle'); setLabel(''); setSourceId(undefined); resetTimeline();
  }, [wake, update, resetTimeline]);
  const stopSource = useCallback((id: string) => { if (source.current === id) stop(); }, [stop]);
  const waitUntilReady = useCallback(async (current: number) => {
    while (current === token.current && paused.current) await new Promise<void>(resolve => waiters.current.add(resolve));
    return current === token.current;
  }, []);

  const playAudio = useCallback((url: string, current: number, owned: boolean, retain = false, sharedAudio?: HTMLAudioElement) => new Promise<void>((resolve, reject) => {
    // Keep publisher MP3s as direct media sources: no CORS fetch or proxy.
    const audio = sharedAudio ?? new Audio(url); activeAudio.current = audio;
    if (sharedAudio) { audio.src = url; audio.load(); }
    audio.playbackRate = rateRef.current; audio.preservesPitch = true;
    audio.preload = 'auto';
    let disposed = false, settled = false, failed = false;
    let playGeneration = 0;
    let lastPosition = 0;
    let restorePosition: number | null = null;
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    const currentAudio = () => !disposed && current === token.current && activeAudio.current === audio;
    const clearWatchdog = () => { if (watchdog) clearTimeout(watchdog); watchdog = undefined; };
    const settle = (error?: Error) => { if (settled) return; settled = true; if (error) reject(error); else resolve(); };
    const timeline = () => {
      if (!currentAudio()) return;
      const known = audio.readyState >= 1 && Number.isFinite(audio.duration) && audio.duration > 0;
      if (restorePosition !== null && known) {
        const target = Math.max(0, Math.min(restorePosition, audio.duration));
        restorePosition = null;
        try { audio.currentTime = target; } catch { /* A later retry can still start the file. */ }
      }
      if (restorePosition === null && Number.isFinite(audio.currentTime)) lastPosition = Math.max(0, audio.currentTime);
      setPosition(lastPosition); setDuration(known ? audio.duration : null); setCanSeek(known && !failed);
      setSeekUnavailableReason(failed ? '请先重试播放，再快退或快进。' : known ? '' : '正在读取音频时长，稍后可快退或快进。');
    };
    const dispose = () => {
      if (disposed) return;
      disposed = true; playGeneration++; clearWatchdog();
      audio.onended = audio.onerror = audio.onloadedmetadata = audio.ondurationchange = audio.ontimeupdate = null;
      audio.onwaiting = audio.onstalled = audio.onplaying = audio.oncanplay = audio.onprogress = audio.onseeking = audio.onseeked = null;
      audio.pause(); audio.removeAttribute('src'); audio.load();
      if (owned) URL.revokeObjectURL(url);
      if (activeAudio.current === audio) {
        activeAudio.current = null; playActive.current = null; pauseActive.current = null; setCanSeek(false);
        setSeekUnavailableReason('重播音频后可快退或快进。');
      }
      if (cancelPlayback.current === cancel) cancelPlayback.current = null;
    };
    const cancel = () => { dispose(); settle(); };
    const fail = (message: string) => {
      if (!currentAudio() || failed) return;
      if (restorePosition === null && Number.isFinite(audio.currentTime)) lastPosition = audio.currentTime;
      failed = true; playGeneration++; clearWatchdog(); audio.pause();
      if (retain) {
        update('error'); timeline(); callbacks.current.onError(message);
      } else dispose();
      settle(new Error(message));
    };
    const watch = () => {
      clearWatchdog();
      watchdog = setTimeout(() => {
        if (currentAudio() && !paused.current) fail('音频缓冲等待太久。请检查网络，再点“重试播放”；会尽量接着刚才的位置播放。');
      }, 30000);
    };
    const waiting = () => {
      if (!currentAudio() || failed || paused.current || phase.current === 'blocked' || audio.ended) return;
      update('buffering'); watch();
    };
    const playing = () => {
      if (!currentAudio() || failed) return;
      if (paused.current) { audio.pause(); update('paused'); return; }
      clearWatchdog(); timeline(); update('playing');
    };
    const ready = () => {
      timeline();
      if (currentAudio() && !failed && !paused.current && !audio.paused && audio.readyState >= 3 && phase.current !== 'blocked') playing();
    };
    const play = (restart = false) => {
      if (!currentAudio() || paused.current) return;
      const attempt = ++playGeneration;
      if (restart) {
        // A pending reload must also honor a newer "from beginning" action.
        restorePosition = 0; lastPosition = 0;
        try { audio.currentTime = 0; } catch { /* Apply when metadata arrives. */ }
        timeline();
      }
      if (failed) {
        failed = false; restorePosition = lastPosition;
        // A native media error requires load(); changing currentTime alone does
        // not reset HTMLMediaElement.error. Restore time after new metadata.
        audio.load(); timeline();
      }
      update('loading'); watch();
      // Invoke play synchronously in the click/Space gesture, including retries.
      void audio.play().then(() => {
        if (!currentAudio() || attempt !== playGeneration) return;
        if (paused.current) { audio.pause(); update('paused'); }
        else if (audio.readyState < 3) waiting(); else playing();
      }).catch(error => {
        if (!currentAudio() || attempt !== playGeneration) return;
        clearWatchdog();
        if (paused.current) { update('paused'); return; }
        if (error?.name === 'NotAllowedError') update('blocked');
        else if (error?.name === 'AbortError') { paused.current = true; update('paused'); }
        else fail('音频未能播放。请点“重试播放”，或尝试其他音轨。');
      });
    };
    const pause = () => { playGeneration++; clearWatchdog(); audio.pause(); };
    cancelPlayback.current = cancel; playActive.current = play; pauseActive.current = pause;
    audio.onloadedmetadata = audio.ondurationchange = timeline;
    audio.ontimeupdate = () => { timeline(); if (currentAudio() && phase.current === 'buffering' && audio.readyState >= 3 && !audio.paused) playing(); };
    audio.onwaiting = audio.onstalled = audio.onseeking = waiting;
    audio.oncanplay = audio.onseeked = ready;
    audio.onplaying = playing;
    audio.onprogress = () => { timeline(); if (currentAudio() && !failed && !paused.current && ['loading', 'buffering'].includes(phase.current)) watch(); };
    audio.onerror = () => fail(audio.error?.code === 2 ? '音频下载中断。请检查网络后点“重试播放”。' : '音频加载失败。请重试，或从出版社原声入口检查这条音轨。');
    audio.onended = () => {
      if (!currentAudio() || failed) return;
      clearWatchdog(); timeline();
      if (retain) { update('idle'); settle(); }
      else { dispose(); settle(); }
    };
    timeline();
    if (paused.current) update('paused'); else play();
  }), [update]);

  const say = useCallback((text: SpeechText | SpeechText[], lang: 'ja-JP' | 'zh-CN' = 'ja-JP', rate = 1, id?: string, speakers?: VoiceSpeaker | VoiceSpeaker[], onComplete?: () => void) => {
    stop();
    if (id) mediaSources.current.delete(id);
    if (id) { if (lang === 'zh-CN') systemOnlySources.current.add(id); else systemOnlySources.current.delete(id); }
    const engine = id ? engines.current.get(id) : undefined;
    const current = token.current;
    // Retain both forms: approved native voices use the written sentence;
    // the existing cloud/generic system paths keep their supplied kana.
    const lines = (Array.isArray(text) ? text : [text]).map(line => typeof line === 'string'
      ? { text: line.trim() } : { text: line.jp.trim(), ...(lang === 'ja-JP' && line.kana.trim() ? { kana: line.kana.trim() } : {}) }).filter(line => line.text);
    sequence.current = lines.length > 1;
    if (!lines.length) return;
    lastAction.current = () => say(text, lang, rate, id, speakers, onComplete);
    const speakerFor = (index: number) => Array.isArray(speakers) ? speakers[index] : speakers;
    const fixedDialogue = lines.some((_, index) => ['dialogue-a', 'dialogue-b'].includes(speakerFor(index) ?? ''));
    hasSource.current = true; source.current = id; setSourceId(id); setLabel(lang === 'ja-JP' ? '日语朗读' : '中文讲解');
    let playbackRate = rate;
    const systemSay = (remaining: typeof lines, native?: { female: SpeechSynthesisVoice; male?: SpeechSynthesisVoice }) => {
      if (current !== token.current) return;
      setCanSeek(false); setDuration(null); setPosition(0); setSeekUnavailableReason('系统朗读不支持按秒跳转，可暂停或从头播放。');
      if (!('speechSynthesis' in window)) { update('error'); callbacks.current.onError('这个浏览器不能朗读，请使用新版 Edge 或 Chrome。'); return; }
      voices.current = window.speechSynthesis.getVoices();
      const voice = native?.female || voices.current.find(v => v.localService && v.lang.toLowerCase() === lang.toLowerCase()) || voices.current.find(v => v.localService && v.lang.startsWith(lang.slice(0, 2)));
      if (!voice) { update('error'); callbacks.current.onError(`未找到这个设备的${lang === 'ja-JP' ? '日语' : '中文'}声音。请在设备设置中添加语音包，然后重新打开浏览器。`); return; }
      let sentenceIndex = 0;
      let generation = 0;
      const enqueueFrom = (start: number) => {
        const ownGeneration = ++generation;
        const enqueueLine = (index: number) => {
          if (current !== token.current || generation !== ownGeneration) return;
          if (paused.current) {
            update('paused');
            void waitUntilReady(current).then(ready => { if (ready) enqueueLine(index); });
            return;
          }
          sentenceIndex = index;
          const line = remaining[index];
          const u = new SpeechSynthesisUtterance(native ? nativeJapaneseText(line.text) : line.kana || line.text);
          u.lang = lang; u.voice = native && ['dialogue-a', 'secondary'].includes(speakerFor(index) ?? '') ? native.male || voice : voice; u.rate = playbackRate * rateRef.current;
          const active = () => current === token.current && generation === ownGeneration && utterances.current[0] === u;
          u.onend = () => {
            if (!active()) return;
            utterances.current = [];
            if (index + 1 < remaining.length) enqueueLine(index + 1);
            else { restartSystem.current = null; update('idle'); onComplete?.(); }
          };
          u.onerror = event => {
            if (!active()) return;
            generation++; utterances.current = []; restartSystem.current = null; update('error');
            if (!['interrupted', 'canceled'].includes(event.error)) callbacks.current.onError('朗读未成功。请重试，或在设置里检查系统声音。');
          };
          // Keep only one native utterance in flight, including voice switches.
          utterances.current = [u];
          window.speechSynthesis.resume(); update('playing'); window.speechSynthesis.speak(u);
        };
        enqueueLine(start);
      };
      restartSystem.current = () => {
        generation++;
        window.speechSynthesis.cancel();
        enqueueFrom(sentenceIndex);
      };
      enqueueFrom(0);
    };
    if (lang === 'zh-CN') { systemSay(lines); return; }
    const request = new AbortController(); activeRequest.current = request; update('loading');
    let index = 0;
    let selectedProvider: VoiceSettings['provider'] | undefined;
    void (async () => {
      try {
        const response = await fetch('/api/voice/settings', { signal: request.signal });
        if (!response.ok) throw new Error('无法读取语音设置。');
        const settings = await response.json() as VoiceSettings;
        if (engine && engine !== 'default') settings.provider = engine;
        if (current !== token.current) return;
        selectedProvider = settings.provider;
        if (typeof settings.speed === 'number' && settings.speed >= .8 && settings.speed <= 1.2) playbackRate = rate * settings.speed;
        if (settings.provider === 'haruka') {
          const available = await systemVoices();
          if (current !== token.current) return;
          const haruka = japaneseVoice(available, 'Haruka');
          if (!haruka) {
            update('error'); callbacks.current.onError('此设备未安装 Haruka，请在声音设置中选择其他声音，或先安装日语语音。'); return;
          }
          const male = japaneseVoice(available, 'Ichiro');
          if (fixedDialogue && !male) {
            update('error'); callbacks.current.onError('本机缺少 Ichiro 日语男声，暂时无法播放男女对话。请安装该声音，或在声音设置中选择 MiniMax。'); return;
          }
          setLabel('日语朗读 · Haruka');
          systemSay(lines, { female: haruka, male }); return;
        }
        if (settings.provider === 'system') {
          if (fixedDialogue) throw new Error('男女对话需要 MiniMax 或 Haruka，请在语音设置中选择。');
          await systemVoices();
          if (current !== token.current) return;
          systemSay(lines); return;
        }
        if (settings.provider !== 'minimax') throw new Error('语音服务设置无效。');
        // Keep a dialogue on one media element so later turns retain the
        // browser's playback permission instead of becoming new auto-players.
        const dialogueAudio = fixedDialogue ? new Audio() : undefined;
        for (index = 0; index < lines.length; index++) {
          if (!await waitUntilReady(current)) return;
          update('loading');
          const clip = await fetch('/api/voice/synthesize', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: lines[index].kana || lines[index].text, rate, speaker: speakerFor(index) ?? (index % 2 ? 'secondary' : 'primary'), ...(engine === 'minimax' ? { provider: 'minimax' } : {}) }), signal: request.signal,
          });
          if (!clip.ok) { const failure = await clip.json().catch(() => ({})); throw new Error(typeof failure.error === 'string' ? failure.error : '云端语音暂时没有响应。'); }
          const blob = await clip.blob();
          if (current !== token.current) return;
          await playAudio(URL.createObjectURL(blob), current, true, false, dialogueAudio);
        }
        if (current === token.current) { update('idle'); onComplete?.(); }
      } catch (error) {
        if (current !== token.current || request.signal.aborted) return;
        if (engine && engine !== 'default') {
          update('error'); callbacks.current.onError(error instanceof Error ? error.message : '当前播放器的语音引擎不可用，请选择其他引擎。'); return;
        }
        if (selectedProvider === 'haruka') {
          update('error'); callbacks.current.onError('Haruka 播放失败，请重试或在声音设置中选择其他声音。'); return;
        }
        if (fixedDialogue) {
          update('error'); callbacks.current.onError(`${error instanceof Error ? error.message : '对话音频暂时不可用。'} 请重试播放，A为男性、B为女性。`); return;
        }
        callbacks.current.onError(`${error instanceof Error ? error.message : '云端语音暂时不可用。'} 已改用本机朗读，可在设置里重新试听。`);
        systemSay(lines.slice(index));
      } finally { if (activeRequest.current === request) activeRequest.current = null; }
    })();
  }, [stop, update, waitUntilReady, playAudio]);
  const playUrl = useCallback((url: string, name = '音频', id?: string) => {
    stop();
    if (id) mediaSources.current.add(id);
    sequence.current = false;
    let parsed: URL;
    try { parsed = new URL(url, location.href); } catch { callbacks.current.onError('音频地址无效。'); return; }
    const local = parsed.origin === location.origin && ['http:', 'https:', 'blob:'].includes(parsed.protocol);
    if (!local && !isOfficialTextbookAudioUrl(parsed.href)) { callbacks.current.onError('这个音频地址不受支持。'); return; }
    lastAction.current = () => playUrl(url, name, id);
    hasSource.current = true; source.current = id; setSourceId(id); setLabel(name);
    // Retained media handles its errors locally, including errors after retry.
    void playAudio(parsed.href, token.current, false, true).catch(() => {});
  }, [stop, playAudio]);
  const pause = useCallback(() => {
    if (['idle', 'error'].includes(phase.current)) return;
    epoch.current++; paused.current = true;
    pauseActive.current?.();
    if (utterances.current.length) window.speechSynthesis.pause();
    update('paused');
  }, [update]);
  const resume = useCallback(() => {
    if (!['paused', 'blocked'].includes(phase.current)) return;
    epoch.current++; paused.current = false;
    if (playActive.current) playActive.current();
    else if (utterances.current.length) { window.speechSynthesis.resume(); update('playing'); }
    else update('loading');
    wake();
  }, [update, wake]);
  const replay = useCallback(() => {
    if (sequence.current) lastAction.current?.();
    else if (activeAudio.current && playActive.current) {
      epoch.current++; paused.current = false;
      playActive.current(phase.current !== 'error'); wake();
    } else lastAction.current?.();
  }, [wake]);
  const seekBy = useCallback((delta: number) => {
    const audio = activeAudio.current;
    if (!audio || audio.readyState < 1 || !Number.isFinite(audio.duration) || audio.duration <= 0 || !Number.isFinite(delta) || phase.current === 'error') return;
    epoch.current++;
    const wasPaused = paused.current || phase.current === 'idle' || phase.current === 'blocked';
    if (wasPaused) { paused.current = true; pauseActive.current?.(); }
    try {
      const target = Math.max(0, Math.min(audio.duration, audio.currentTime + delta));
      audio.currentTime = target; setPosition(target);
      if (wasPaused) update('paused');
    } catch { callbacks.current.onError('这个位置暂时不能跳转，请等待缓冲后再试。'); }
  }, [update]);
  const togglePlayback = useCallback(() => {
    if (!hasSource.current) return;
    if (phase.current === 'paused' || phase.current === 'blocked') resume();
    else if (phase.current === 'idle' || phase.current === 'error') replay();
    else pause();
  }, [pause, resume, replay]);
  const getEpoch = useCallback(() => epoch.current, []);
  const setPlaybackRate = useCallback((value: number) => {
    if (![.75, 1, 1.25].includes(value)) return;
    rateRef.current = value; setRate(value);
    if (activeAudio.current) activeAudio.current.playbackRate = value;
    else if (utterances.current.length) {
      const wasPaused = paused.current;
      restartSystem.current?.();
      if (wasPaused) { paused.current = true; window.speechSynthesis.pause(); update('paused'); }
    }
  }, [update]);
  const sayAuto = useCallback((text: SpeechText | SpeechText[], expectedEpoch: number, lang: 'ja-JP' | 'zh-CN' = 'ja-JP', rate = 1, id?: string) => {
    if (epoch.current !== expectedEpoch || document.hidden) return false;
    say(text, lang, rate, id); return true;
  }, [say]);

  useEffect(() => {
    const changed = () => { if ('speechSynthesis' in window) voices.current = window.speechSynthesis.getVoices(); };
    changed();
    if ('speechSynthesis' in window) window.speechSynthesis.addEventListener('voiceschanged', changed);
    const hidden = () => { if (document.hidden) { epoch.current++; pause(); } };
    const handledKeys = new Set<string>();
    const consume = (event: KeyboardEvent) => {
      event.preventDefault();
      if (event.code !== 'Space') event.stopImmediatePropagation();
    };
    const keydown = (event: KeyboardEvent) => {
      if (!['Space', 'F1', 'F2', 'F3', 'F4', 'Escape'].includes(event.code)) return;
      if (event.repeat) { if (handledKeys.has(event.code)) consume(event); return; }
      if (event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) return;
      const target = event.target instanceof Element ? event.target : null;
      // Function keys are player commands even in editors and during IME input.
      // Space keeps normal typing, recording-button and form-control behavior.
      if (event.code === 'Space' && (event.defaultPrevented || event.isComposing || event.keyCode === 229 || target?.closest('input,textarea,select,[contenteditable]:not([contenteditable="false"]),[role="textbox"],[role="slider"]'))) return;
      const triggerSource = target?.closest('[data-audio-source]')?.getAttribute('data-audio-source');
      const currentTrigger = source.current !== undefined && triggerSource === source.current;
      if (event.code === 'Space' && !target?.closest('.audio-controls') && !currentTrigger && target?.closest('button,a,summary,[role="button"],[role="checkbox"],[role="switch"],[role="tab"]')) return;
      if (!hasSource.current) {
        if (event.code === 'Escape' || event.code === 'Space') return;
        consume(event); handledKeys.add(event.code);
        // Before first playback (or after Stop), start the focused player, or
        // the only visible player. Never guess between multiple examples.
        if (!['F1', 'F4'].includes(event.code)) return;
        const scope = target?.closest('.audio-controls') ?? document;
        const action = event.code === 'F1' ? 'toggle' : 'replay';
        const buttons = [...scope.querySelectorAll<HTMLButtonElement>(`.audio-controls button[data-audio-action="${action}"]:not(:disabled)`)]
          .filter(button => button.getClientRects().length && getComputedStyle(button).visibility === 'visible');
        if (buttons.length !== 1) return;
        buttons[0].click(); return;
      }
      consume(event); handledKeys.add(event.code);
      if (event.code === 'F2') seekBy(-2);
      else if (event.code === 'F3') seekBy(2);
      else if (event.code === 'F4') replay();
      else if (event.code === 'Escape') stop();
      else togglePlayback();
    };
    const keyup = (event: KeyboardEvent) => { if (handledKeys.delete(event.code)) consume(event); };
    const captureKeydown = (event: KeyboardEvent) => { if (event.code !== 'Space') keydown(event); };
    const spaceKeydown = (event: KeyboardEvent) => { if (event.code === 'Space') keydown(event); };
    const blur = () => { handledKeys.clear(); };
    document.addEventListener('visibilitychange', hidden);
    window.addEventListener('keydown', captureKeydown, true);
    window.addEventListener('keydown', spaceKeydown); window.addEventListener('keyup', keyup, true); window.addEventListener('blur', blur);
    window.addEventListener('voice-settings-changed', stop); window.addEventListener('nihongo-recording-start', stop);
    return () => {
      stop();
      if ('speechSynthesis' in window) window.speechSynthesis.removeEventListener('voiceschanged', changed);
      document.removeEventListener('visibilitychange', hidden);
      window.removeEventListener('keydown', captureKeydown, true);
      window.removeEventListener('keydown', spaceKeydown); window.removeEventListener('keyup', keyup, true); window.removeEventListener('blur', blur);
      window.removeEventListener('voice-settings-changed', stop); window.removeEventListener('nihongo-recording-start', stop);
    };
  }, [stop, pause, togglePlayback, seekBy, replay]);
  const setSourceEngine = useCallback((id: string, engine: PlayerVoiceEngine) => {
    if (source.current === id) { stop(); source.current = id; setSourceId(id); }
    if (engine === 'default') engines.current.delete(id); else engines.current.set(id, engine);
    refreshEngines(value => value + 1);
  }, [stop]);
  const clearSourceEngine = useCallback((id: string) => { engines.current.delete(id); mediaSources.current.delete(id); systemOnlySources.current.delete(id); }, []);
  const getSourceEngine = (id: string): PlayerVoiceEngine => engines.current.get(id) ?? 'default';
  const isMediaSource = (id: string) => mediaSources.current.has(id);
  const isSystemOnlySource = (id: string) => systemOnlySources.current.has(id);
  return { setSourceEngine, clearSourceEngine, getSourceEngine, isMediaSource, isSystemOnlySource, say, sayAuto, stop, stopSource, pause, resume, replay, playUrl, seekBy, togglePlayback, getEpoch, status, paused: status === 'paused', speaking: ['playing', 'loading', 'buffering'].includes(status), label, sourceId, position, duration, canSeek, seekUnavailableReason, playbackRate, setPlaybackRate };
}
export type Speech = ReturnType<typeof useSpeech>;
