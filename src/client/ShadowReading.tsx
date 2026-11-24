import { useEffect, useId, useRef, useState } from 'react';
import { Mic } from 'lucide-react';
import type { Example } from '../shared/types';
import type { Speech } from './speech';
import { localize } from './i18n';
import { useTranslation } from './preferences';
import { AudioControls } from './AudioControls';
import { shadowProgress } from './shadow-reading';
import './shadow-reading.css';

type RecognitionResult = { isFinal: boolean; length: number; [index: number]: { transcript: string } };
type RecognitionEvent = { results: { length: number; [index: number]: RecognitionResult } };
type Recognition = {
  lang: string; continuous: boolean; interimResults: boolean; maxAlternatives: number;
  onstart: (() => void) | null; onresult: ((event: RecognitionEvent) => void) | null;
  onerror: ((event: { error: string }) => void) | null; onend: (() => void) | null;
  start(): void; stop(): void; abort(): void;
};
type SpeechWindow = Window & { SpeechRecognition?: new () => Recognition; webkitSpeechRecognition?: new () => Recognition };

export function ShadowReading({ example, speech, furigana, active = true }: { example: Example; speech: Speech; furigana: boolean; active?: boolean }) {
  const t = useTranslation(); const sourceId = useId(), hintId = useId();
  const available = typeof window !== 'undefined' && !!((window as SpeechWindow).SpeechRecognition || (window as SpeechWindow).webkitSpeechRecognition);
  const [phase, setPhase] = useState<'idle' | 'starting' | 'listening' | 'finishing'>('idle');
  const [transcript, setTranscript] = useState(''); const [error, setError] = useState(''); const [cancelArmed, setCancelArmed] = useState(false);
  const instance = useRef<Recognition | null>(null), generation = useRef(0), alive = useRef(true);
  const gesture = useRef<{ input: number | string; y?: number; cancel: boolean } | null>(null);
  const timeout = useRef<ReturnType<typeof setTimeout> | null>(null), finishTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const heard = useRef(''), prior = useRef(''), emptyEnds = useRef(0);
  const progress = shadowProgress(example, transcript);
  const busy = phase !== 'idle';
  const clearTimers = () => { if (timeout.current) clearTimeout(timeout.current); if (finishTimeout.current) clearTimeout(finishTimeout.current); timeout.current = null; finishTimeout.current = null; };
  function cancel(clear = true) {
    generation.current++; gesture.current = null; clearTimers();
    const recognizer = instance.current; instance.current = null;
    try { recognizer?.abort(); } catch { /* Capture may already have ended. */ }
    if (alive.current) { setPhase('idle'); setCancelArmed(false); if (clear) { heard.current = ''; prior.current = ''; setTranscript(''); } }
  }
  useEffect(() => {
    alive.current = true;
    const hide = () => { if (document.hidden) cancel(); }; const leave = () => cancel();
    window.addEventListener('pagehide', leave); document.addEventListener('visibilitychange', hide);
    return () => { alive.current = false; cancel(); window.removeEventListener('pagehide', leave); document.removeEventListener('visibilitychange', hide); };
  }, []);
  useEffect(() => { cancel(); setError(''); }, [example.jp, example.kana, active]);
  useEffect(() => {
    // Keyboard shortcuts or another player can start audio while the mic is held.
    // Abort recognition so playback cannot be mistaken for the learner's voice.
    if (busy && ['loading', 'playing', 'buffering'].includes(speech.status)) cancel();
  }, [busy, speech.status, speech.sourceId]);

  function begin(input: number | string, y?: number) {
    if (!available || !active || gesture.current) return;
    cancel(); speech.stop(); setError('');
    gesture.current = { input, y, cancel: false }; emptyEnds.current = 0;
    const session = generation.current;
    const Constructor = (window as SpeechWindow).SpeechRecognition ?? (window as SpeechWindow).webkitSpeechRecognition!;
    const startRecognizer = () => {
      if (!gesture.current || session !== generation.current || !alive.current) return;
      const recognizer = new Constructor(); instance.current = recognizer;
      recognizer.lang = 'ja-JP'; recognizer.continuous = true; recognizer.interimResults = true; recognizer.maxAlternatives = 1;
      const current = () => alive.current && session === generation.current && instance.current === recognizer;
      let latest = '';
      recognizer.onstart = () => { if (!current()) return; if (!gesture.current) { try { recognizer.stop(); } catch {} return; } setPhase('listening'); };
      recognizer.onresult = event => {
        if (!current()) return;
        latest = Array.from({ length: event.results.length }, (_, index) => event.results[index][0]?.transcript ?? '').join('');
        heard.current = prior.current + latest; setTranscript(heard.current);
      };
      recognizer.onerror = event => {
        if (!current()) return;
        if (event.error !== 'aborted') setError(event.error === 'not-allowed' || event.error === 'service-not-allowed'
          ? t('请允许麦克风及语音识别后再试。', 'マイクと音声認識を許可して再試行してください。', 'Allow microphone and speech recognition access, then try again.')
          : event.error === 'no-speech' ? t('没有识别到声音，请按住后再读一次。', '音声を認識できませんでした。もう一度読んでください。', 'No speech was detected. Hold and try again.')
          : t('实时语音识别暂不可用，请检查网络后重试。', 'リアルタイム音声認識を利用できません。接続を確認してください。', 'Live speech recognition is unavailable. Check your connection and retry.'));
        cancel(false);
      };
      recognizer.onend = () => {
        if (!current()) return;
        instance.current = null;
        if (gesture.current && active) {
          // Safari may end a recognition segment after a pause despite continuous=true.
          if (!latest.trim() && ++emptyEnds.current > 1) { setError(t('没有识别到声音，请松手后再试。', '音声を認識できません。離してから再試行してください。', 'No speech was detected. Release and try again.')); cancel(false); return; }
          if (latest.trim()) emptyEnds.current = 0;
          prior.current = heard.current; startRecognizer();
        } else { clearTimers(); setPhase('idle'); }
      };
      try { setPhase('starting'); recognizer.start(); }
      catch { setError(t('无法启动实时语音识别，请重试。', '音声認識を開始できません。再試行してください。', 'Could not start live speech recognition. Try again.')); cancel(false); }
    };
    startRecognizer();
    if (gesture.current) timeout.current = setTimeout(() => finish(input), 30000);
  }
  function finish(input: number | string) {
    if (!gesture.current || gesture.current.input !== input) return;
    if (gesture.current.cancel) { cancel(); return; }
    gesture.current = null; setCancelArmed(false);
    if (timeout.current) clearTimeout(timeout.current); timeout.current = null;
    if (!instance.current) { setPhase('idle'); return; }
    setPhase('finishing');
    try { instance.current.stop(); } catch { cancel(false); }
    finishTimeout.current = setTimeout(() => cancel(false), 2500);
  }
  const marked = (value: string, end: number) => <><span className="shadow-matched">{value.slice(0, end)}</span>{value.slice(end)}</>;
  return <div className="shadow-reading">
    <div className="sentence"><div className="sentence-text">
      {furigana && <p className="reading" lang="ja">{marked(example.kana, progress.kanaEnd)}</p>}
      <p className="japanese shadow-sentence" lang="ja">{marked(example.jp, progress.jpEnd)}</p>
      <p className="meaning">{localize(example.zh)}</p>
    </div><AudioControls speech={speech} sourceId={sourceId} disabled={busy} onPlay={() => speech.say(example, 'ja-JP', 1, sourceId)}/></div>
    <div className="shadow-actions">
      <button className={`shadow-mic${busy ? ' listening' : ''}${cancelArmed ? ' cancel-armed' : ''}`} type="button" disabled={!available || !active}
        aria-label={t('按住影子跟读', '押してシャドーイング', 'Hold to shadow read')} aria-pressed={busy} aria-describedby={hintId}
        onPointerDown={event => { if (event.button !== 0 || gesture.current) return; event.preventDefault(); event.currentTarget.focus({ preventScroll: true }); event.currentTarget.setPointerCapture(event.pointerId); begin(event.pointerId, event.clientY); }}
        onPointerMove={event => { const held = gesture.current; if (!held || held.input !== event.pointerId || held.y === undefined) return; held.cancel = held.y - event.clientY >= 60; setCancelArmed(held.cancel); }}
        onPointerUp={event => finish(event.pointerId)} onPointerCancel={() => cancel()} onLostPointerCapture={() => { if (gesture.current) cancel(); }}
        onKeyDown={event => { if (event.code === 'Space' || event.code === 'Enter') { event.preventDefault(); if (!event.repeat) begin(event.code); } if (event.code === 'Escape') { event.preventDefault(); cancel(); } }}
        onKeyUp={event => { if (event.code === 'Space' || event.code === 'Enter') { event.preventDefault(); finish(event.code); } }} onBlur={() => { if (gesture.current) cancel(); }}>
        <Mic size={24}/><span>{t('按住跟读', '押して読む', 'Hold to read')}</span>
      </button>
      <p role="status" className="shadow-status">{cancelArmed ? t('松手取消跟读', '離すとキャンセル', 'Release to cancel') : phase === 'starting' ? t('正在开启麦克风…', 'マイクを開始中…', 'Starting microphone…') : phase === 'listening' ? t('正在跟读…', '聞き取り中…', 'Listening…') : phase === 'finishing' ? t('正在完成识别…', '認識を完了中…', 'Finishing recognition…') : progress.complete ? t('已识别到完整句子', '文全体を認識しました', 'Full sentence recognized') : ''}</p>
    </div>
    <p id={hintId} className="tiny-note">{available ? t('按住麦克风或空格键跟读，上滑松手取消。蓝色表示识别到的文字匹配，不是发音评分。', 'マイクまたはスペースキーを押して読み、上にスライドして離すとキャンセル。青色は認識した文字の一致で、発音評価ではありません。', 'Hold the microphone or Space to read; slide up and release to cancel. Blue shows recognized text matches, not pronunciation accuracy.') : t('当前浏览器不支持实时跟读识别。仍可播放参考音频练习。', 'このブラウザはリアルタイム認識に対応していません。参考音声は再生できます。', 'This browser does not support live recognition. You can still practice with the reference audio.')}</p>
    {error && <p className="notice-inline" role="alert">{error}</p>}
  </div>;
}
