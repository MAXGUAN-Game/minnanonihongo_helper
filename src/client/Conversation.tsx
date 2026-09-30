import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, BookOpen, Check, ChevronRight, Mic, Repeat2, Send, Lightbulb, Plus, MessageCircle, Keyboard, Volume2, Headphones, Play } from 'lucide-react';
import type { Lesson, Session, Settings, Correction } from '../shared/types';
import { getGrammarChatScenario, isGrammarChat, GRAMMAR_CHAT_MAX_TURNS } from '../shared/grammar-chat';
import { api, ClientApiError } from './api';
import { Button, Sentence } from './ui';
import { useRecorder, type Speech } from './speech';
import { RecordingControls } from './RecordingControls';
import { AudioControls } from './AudioControls';

type PendingTurn = { text: string; id: string; usedHint: boolean; recordingId?: string };
type Composer = { sessionId: string | null; draft: string; usedHint: boolean; pendingRequest: PendingTurn | null; recordingId?: string };
const emptyComposer = (sessionId: string | null): Composer => ({ sessionId, draft: '', usedHint: false, pendingRequest: null });
const turnAudioSource = (sessionId: string, turnId: string) => `conversation:${sessionId}:${turnId}`;
const cacheKey = (sessionId: string) => `conversation-draft-${sessionId}`;
// Only these server errors guarantee that this turn was not committed. A proxy
// error, unreadable response or unknown code must keep the original request ID.
const rejectedTurnCodes = new Set(['AI_NOT_CONFIGURED', 'AI_AUTH_FAILED', 'AI_BUSY', 'AI_UNAVAILABLE', 'AI_INVALID_RESPONSE', 'INVALID_INPUT', 'INVALID_GRAMMAR', 'INVALID_SCENARIO', 'PAYLOAD_TOO_LARGE', 'IDEMPOTENCY_CONFLICT', 'SESSION_COMPLETE', 'SESSION_NOT_FOUND', 'RECORDING_NOT_FOUND', 'RECORDING_MISMATCH']);
function restoreComposer(session: Session | null): Composer {
  if (!session) return emptyComposer(null);
  const result = emptyComposer(session.id);
  try {
    const raw = localStorage.getItem(cacheKey(session.id));
    const saved: unknown = raw ? JSON.parse(raw) : null;
    if (saved && typeof saved === 'object') {
      const value = saved as Record<string, unknown>;
      if (typeof value.draft === 'string') result.draft = value.draft.slice(0, 2000);
      result.usedHint = value.usedHint === true;
      if (typeof value.recordingId === 'string' && /^[a-zA-Z0-9-]{1,100}$/.test(value.recordingId)) result.recordingId = value.recordingId;
      const request = value.pendingRequest as Partial<PendingTurn> | undefined;
      if (request && typeof request.text === 'string' && request.text.trim() && request.text.length <= 2000 && typeof request.id === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(request.id)) {
        result.pendingRequest = { text: request.text, id: request.id, usedHint: request.usedHint === true };
        if (typeof request.recordingId === 'string' && /^[a-zA-Z0-9-]{1,100}$/.test(request.recordingId)) result.pendingRequest.recordingId = request.recordingId;
      }
    } else {
      // Migrate earlier versions without an empty initial effect overwriting them.
      result.draft = (localStorage.getItem(`draft-${session.id}`) || '').slice(0, 2000);
    }
  } catch { /* An unavailable or damaged cache must not prevent lesson use. */ }
  const request = result.pendingRequest;
  if (request && session.turns.some(turn => turn.role === 'user' && turn.id === request.id && turn.text === request.text)) {
    result.pendingRequest = null;
    if (result.draft.trim() === request.text) { result.draft = ''; result.usedHint = false; result.recordingId = undefined; }
  }
  return result;
}
function saveComposer(value: Composer): boolean {
  if (!value.sessionId) return true;
  try {
    localStorage.setItem(cacheKey(value.sessionId), JSON.stringify(value));
    localStorage.removeItem(`draft-${value.sessionId}`);
    return true;
  } catch { return false; }
}

export function Conversation({ lesson, resume, settings, speech, notice, refresh, addCorrection, deployment = 'local' }: { lesson: Lesson; resume: Session | null; settings: Settings; speech: Speech; notice: (message: string) => void; refresh: () => Promise<void>; addCorrection: (correction: Correction, sourceId: string) => Promise<void>; deployment?: 'local' | 'web' }) {
  const [session, setSession] = useState<Session | null>(() => resume?.lessonId === lesson.id ? resume : null);
  const [composer, setComposer] = useState<Composer>(() => restoreComposer(session));
  const draft = composer.draft;
  const [pending, setPending] = useState(false);
  const [showPicker, setShowPicker] = useState(false);
  const [grammarId, setGrammarId] = useState('');
  const [showChinese, setShowChinese] = useState(false);
  const [showHint, setShowHint] = useState(false);
  const [revealedTurns, setRevealedTurns] = useState<Set<string>>(() => new Set());
  const playedTurns = useRef(new Set(resume?.turns.filter(turn => turn.role === 'assistant').map(turn => turn.id) || []));
  const pickerRef = useRef(false);
  const [recordInfo, setRecordInfo] = useState('');
  const [sendError, setSendError] = useState('');
  const [added, setAdded] = useState<string[]>([]);
  const [retryCorrection, setRetryCorrection] = useState<Correction | null>(null);
  const controller = useRef<AbortController | null>(null);
  const composerRef = useRef(composer);
  const sessionRef = useRef(session);
  const pendingRef = useRef(false);
  const requestGeneration = useRef(0);
  const recordingContext = useRef<{ sessionId: string; draft: string } | null>(null);
  const submittedClip = useRef<string | null>(null);
  const alive = useRef(true);
  const transcript = useRef<HTMLDivElement>(null);
  function updateComposer(value: Composer) { composerRef.current = value; setComposer(value); return saveComposer(value); }
  function setDraft(value: string) { updateComposer({ ...composerRef.current, draft: value }); }
  function markHint() {
    const current = composerRef.current;
    // An uncertain submission must be retried with its original payload. Hints
    // opened after sending belong to the current draft, not that older request.
    updateComposer({ ...current, usedHint: true });
  }
  const recorder = useRecorder((text, ms, recordingId) => {
    const context = recordingContext.current;
    if (!alive.current || !context || context.sessionId !== sessionRef.current?.id) return;
    const current = composerRef.current.draft;
    // A slow transcription must not erase words typed while it was running.
    const next = current === context.draft || !current.trim() ? text : `${current}\n${text}`;
    updateComposer({ ...composerRef.current, draft: next.slice(0, 2000), recordingId });
    setRecordInfo(`识别用了 ${(ms / 1000).toFixed(1)} 秒。请确认文字，再发送。`);
    recordingContext.current = null;
  }, notice, session ? { lessonId: lesson.id, itemId: session.id, context: 'conversation' } : undefined);
  useEffect(() => {
    if (recorder.clip?.recordingId && recorder.clip.url !== submittedClip.current && composerRef.current.sessionId === sessionRef.current?.id) {
      updateComposer({ ...composerRef.current, recordingId: recorder.clip.recordingId });
    }
  }, [recorder.clip?.recordingId]);
  useEffect(() => {
    alive.current = true;
    saveComposer(composerRef.current);
    return () => { alive.current = false; requestGeneration.current++; controller.current?.abort(); saveComposer(composerRef.current); speech.stop(); };
  }, []);
  function selectSession(value: Session | null) {
    requestGeneration.current++; controller.current?.abort(); controller.current = null;
    recordingContext.current = null; recorder.clear(); speech.stop();
    sessionRef.current = value; setSession(value); updateComposer(restoreComposer(value));
    setRevealedTurns(new Set()); pickerRef.current = false;
    value?.turns.filter(turn => turn.role === 'assistant').forEach(turn => playedTurns.current.add(turn.id));
    pendingRef.current = false; setPending(false); setShowPicker(false); setShowHint(false); setShowChinese(false); setRecordInfo(''); setSendError(''); setAdded([]); setRetryCorrection(null);
  }
  useEffect(() => {
    if (sessionRef.current && sessionRef.current.lessonId !== lesson.id) selectSession(null);
    // Finishing this chat may expose an older active chat in the refreshed
    // overview. Keep the result on screen until the learner chooses to leave it.
    if (resume?.lessonId === lesson.id && resume.id !== sessionRef.current?.id && sessionRef.current?.status !== 'complete') selectSession(resume);
  }, [lesson.id, resume?.id]);
  useEffect(() => { setGrammarId(''); }, [lesson.id]);
  useEffect(() => { transcript.current?.scrollTo({ top: transcript.current.scrollHeight, behavior: 'instant' }); }, [session?.turns.length]);
  useEffect(() => {
    const container = transcript.current;
    const controls = container?.querySelector<HTMLElement>('.audio-controls');
    if (!container || !controls) return;
    // Keep the active sentence's controls visible within the transcript only;
    // playing an older reply must not send the page back to the newest reply.
    const bounds = container.getBoundingClientRect();
    const audioBounds = controls.getBoundingClientRect();
    if (audioBounds.bottom > bounds.bottom - 12) container.scrollTop += audioBounds.bottom - bounds.bottom + 12;
    else if (audioBounds.top < bounds.top + 12) container.scrollTop += audioBounds.top - bounds.top - 12;
  }, [speech.sourceId]);
  const last = session?.turns.filter(turn => turn.role === 'assistant').at(-1);
  const grammarMode = session ? isGrammarChat(session) : false;
  const selectedScene = grammarMode ? getGrammarChatScenario(lesson, session?.grammarId) : lesson.scenarios.find(scene => scene.id === session?.scenarioId);
  const resumableSession = session?.status === 'active' ? session : resume?.lessonId === lesson.id && resume.status === 'active' ? resume : null;
  const resumableScene = resumableSession ? isGrammarChat(resumableSession) ? getGrammarChatScenario(lesson, resumableSession.grammarId) : lesson.scenarios.find(scene => scene.id === resumableSession.scenarioId) : undefined;
  const grammarScope = lesson.grammar.filter(item => !session?.grammarId || item.id === session.grammarId);
  const starterGrammar = grammarScope[0]?.title || lesson.grammar[0]?.title || '本课语法';
  const starters = [
    { label: '解释这个句型', text: `请用简单中文解释「${starterGrammar}」，再给我一句日语例句。` },
    { label: '给我一个例子', text: `请用「${starterGrammar}」给我一个生活中的短例句。` },
    { label: '陪我练一句', text: `请用「${starterGrammar}」陪我练一句日语，每次只问一个问题。` },
  ];
  function beginRequest() {
    controller.current?.abort();
    const request = new AbortController(); controller.current = request;
    const generation = ++requestGeneration.current;
    pendingRef.current = true; setPending(true); speech.stop();
    return { request, audioEpoch: speech.getEpoch(), isCurrent: () => alive.current && generation === requestGeneration.current };
  }
  function playNewReply(value: Session, audioEpoch: number) {
    const reply = value.turns.at(-1);
    if (!reply || reply.role !== 'assistant' || playedTurns.current.has(reply.id)) return;
    playedTurns.current.add(reply.id);
    if (settings.autoplay && !pickerRef.current && recorder.status === 'idle' && sessionRef.current?.id === value.id) speech.sayAuto(reply.text, audioEpoch, 'ja-JP', 1, turnAudioSource(value.id, reply.id));
  }
  function endRequest(request: AbortController, isCurrent: () => boolean) {
    if (isCurrent()) { if (controller.current === request) controller.current = null; pendingRef.current = false; setPending(false); }
  }
  function startRecording() {
    if (!sessionRef.current || pendingRef.current || recorder.status !== 'idle') return;
    recordingContext.current = { sessionId: sessionRef.current.id, draft: composerRef.current.draft };
    submittedClip.current = null;
    updateComposer({ ...composerRef.current, recordingId: undefined });
    speech.stop(); void recorder.start();
  }
  function backToChoices() {
    // Keep the active session and its cached composer intact. In particular,
    // returning to the picker must not settle an uncertain turn or finish it.
    recordingContext.current = null; recorder.cancel(); speech.stop();
    pickerRef.current = true;
    saveComposer(composerRef.current); setShowPicker(true);
  }
  function useStarter(text: string) {
    if (composerRef.current.draft.trim() || composerRef.current.pendingRequest || pendingRef.current) return;
    setDraft(text); markHint();
    document.getElementById('answer-draft')?.focus();
  }
  async function start(scenarioId?: string) {
    if (pendingRef.current) return;
    const { request, isCurrent, audioEpoch } = beginRequest();
    try {
      const payload = scenarioId ? { lessonId: lesson.id, scenarioId } : { lessonId: lesson.id, mode: 'grammar', ...(grammarId ? { grammarId } : {}) };
      const value = await api<Session>('/sessions', { method: 'POST', body: JSON.stringify(payload), signal: request.signal });
      if (!isCurrent()) return;
      sessionRef.current = value; setSession(value); updateComposer(restoreComposer(value));
      setRevealedTurns(new Set()); pickerRef.current = false;
      setShowPicker(false); setShowHint(false); setShowChinese(false); setRecordInfo(''); setSendError(''); setAdded([]); setRetryCorrection(null);
      playNewReply(value, audioEpoch);
      await refresh();
    } catch (error) { if (isCurrent() && (error as Error).name !== 'AbortError') notice((error as Error).message); }
    finally { endRequest(request, isCurrent); }
  }
  async function send() {
    const currentSession = sessionRef.current;
    const cached = composerRef.current;
    if (!currentSession || currentSession.status !== 'active' || (!cached.draft.trim() && !cached.pendingRequest) || pendingRef.current || recorder.status !== 'idle' || recorder.saving) return;
    // First settle an uncertain submission with its original ID, even when the
    // user edited the draft meanwhile. The edited draft is kept for the next turn.
    const turn: PendingTurn = cached.pendingRequest || { text: cached.draft.trim(), id: crypto.randomUUID(), usedHint: cached.usedHint, recordingId: cached.recordingId || (recorder.clip?.url !== submittedClip.current ? recorder.clip?.recordingId : undefined) };
    if (!updateComposer({ ...cached, pendingRequest: turn })) {
      updateComposer(cached);
      setSendError('浏览器未能保存发送记录。请允许本地存储后重试；你的回答仍在输入框。'); return;
    }
    setSendError(''); setRecordInfo('');
    const { request, isCurrent, audioEpoch } = beginRequest();
    try {
      let next: Session;
      try {
        next = await api<Session>(`/sessions/${currentSession.id}/turn`, { method: 'POST', body: JSON.stringify({ text: turn.text, usedHint: turn.usedHint, clientTurnId: turn.id, recordingId: turn.recordingId }), signal: request.signal });
      } catch (error) {
        if (!isCurrent() || sessionRef.current?.id !== currentSession.id || (error as Error).name === 'AbortError') return;
        if (error instanceof ClientApiError && error.code && rejectedTurnCodes.has(error.code)) {
          const invalidRecording = error.code === 'RECORDING_NOT_FOUND' || error.code === 'RECORDING_MISMATCH';
          updateComposer({ ...composerRef.current, pendingRequest: null, ...(invalidRecording ? { recordingId: undefined } : {}) });
          if (invalidRecording) { submittedClip.current = recorder.clip?.url || null; setSendError('这段录音已不可关联。文字已保留，请再次确认发送，或重新录一句。'); return; }
          const unavailable = error.code === 'SESSION_COMPLETE' || error.code === 'SESSION_NOT_FOUND';
          setSendError(`${error.message} ${unavailable ? '回答已保留，请刷新页面查看最新对话或开始新一轮。' : error.code.startsWith('AI_') ? '你的回答已保留。' : '回答已保留，可修改后重新发送，也可以结束这轮。'}`);
          if (error.code === 'SESSION_COMPLETE') {
            try {
              const latest = await api<Session>(`/sessions/${currentSession.id}`, { signal: request.signal });
              if (isCurrent() && sessionRef.current?.id === currentSession.id) { sessionRef.current = latest; setSession(latest); }
            } catch { /* The draft is safe; the inline message offers a reload. */ }
          }
        } else {
          setSendError('暂时无法确认上一句是否已收到。请重试上一句，系统会核对发送记录，避免重复计入。');
        }
        return;
      }
      if (!isCurrent() || sessionRef.current?.id !== currentSession.id) return;
      sessionRef.current = next; setSession(next);
      const current = composerRef.current;
      const keepDraft = !!current.draft.trim() && current.draft.trim() !== turn.text;
      updateComposer({ ...current, draft: keepDraft ? current.draft : '', usedHint: keepDraft ? current.usedHint : false, recordingId: keepDraft ? current.recordingId : undefined, pendingRequest: null });
      if (!keepDraft) submittedClip.current = recorder.clip?.url || null;
      setShowHint(false); setShowChinese(false); setSendError('');
      const confirmation = keepDraft ? '上次发送已确认。修改后的文字仍在输入框，请看回复后再发送。' : '';
      setRecordInfo(confirmation);
      window.dispatchEvent(new Event('nihongo-recordings-changed'));
      playNewReply(next, audioEpoch);
      try { await refresh(); }
      catch {
        if (isCurrent()) {
          const message = `本句已发送，回复已保存。进度概览暂时未刷新，稍后刷新页面即可。${confirmation}`;
          setRecordInfo(message);
          if (next.status === 'complete') notice(message);
        }
      }
    }
    finally { endRequest(request, isCurrent); }
  }
  async function finish() {
    const value = sessionRef.current;
    if (!value || pendingRef.current || recorder.status !== 'idle') return;
    if (composerRef.current.pendingRequest) { setSendError('暂时无法确认上一句是否已收到。请先重试上一句，再结束这轮。'); return; }
    const { request, isCurrent } = beginRequest();
    try {
      const next = await api<Session>(`/sessions/${value.id}/finish`, { method: 'POST', body: '{}', signal: request.signal });
      if (!isCurrent() || sessionRef.current?.id !== value.id) return;
      sessionRef.current = next; setSession(next); await refresh();
    } catch (error) { if (isCurrent() && (error as Error).name !== 'AbortError') notice((error as Error).message); }
    finally { endRequest(request, isCurrent); }
  }
  if (!session || showPicker) return <div className="scenario-picker">
    <p className="eyebrow">把这一课，用进对话里</p><h2>练一个场景，或自由聊语法。</h2>
    {resumableSession && <div className="conversation-resume"><div><strong>未结束的对话已保留</strong><p>{resumableScene?.title} · 已聊 {resumableSession.turnCount} 句</p></div><Button secondary onClick={() => { if (resumableSession.id === session?.id) { pickerRef.current = false; setShowPicker(false); } else selectSession(resumableSession); }}>继续刚才的对话 <ChevronRight size={18}/></Button></div>}
    <section className="grammar-chat-card" aria-labelledby="grammar-chat-entry-title">
      <div className="grammar-chat-heading"><span className="tile-icon lavender"><BookOpen/></span><div><p className="eyebrow">围绕第 {lesson.id} 课 · 随时提问</p><h3 id="grammar-chat-entry-title">语法自由聊</h3></div></div>
      <p>问用法、要例句，或让 AI 陪你练一句。可以输入中文。</p>
      <label htmlFor="grammar-chat-scope">这次想聊什么？<select id="grammar-chat-scope" value={grammarId} disabled={pending} onChange={event => setGrammarId(event.target.value)}><option value="">本课全部语法</option>{lesson.grammar.map(item => <option key={item.id} value={item.id}>{item.title}</option>)}</select></label>
      <Button onClick={() => void start()} disabled={pending}><MessageCircle size={20}/>开始语法自由聊 <ChevronRight size={18}/></Button>
    </section>
    <h3 className="scenario-section-title">场景练习</h3><p className="muted scenario-description">每次一句，4–6 轮。遇到卡点，随时用提示。</p>
    <div className="scenario-grid">{lesson.scenarios.map((scene, i) => <button className="scenario-card" key={scene.id} onClick={() => start(scene.id)} disabled={pending}><span className={`tile-icon ${i ? 'lavender' : 'peach'}`}><MessageCircle/></span><strong>{scene.title}</strong><p>{scene.goal}</p><span className="scenario-link">开始练习 <ChevronRight size={18}/></span></button>)}</div>
    {!settings.hasApiKey && <p className="notice-inline">还没有配置 DeepSeek。可先看开场，设置密钥后开始 AI 对话。</p>}
  </div>;
  return <div className="conversation">
    <button className="text-button conversation-back" onClick={backToChoices}><ArrowLeft size={18}/>返回练习选择</button>
    <div className="conversation-title"><div><p className="eyebrow">{grammarMode ? `第 ${lesson.id} 课 · 语法自由聊` : selectedScene?.title}</p><h2>{grammarMode ? session.grammarId ? grammarScope[0]?.title : '围绕本课语法，慢慢聊。' : selectedScene?.goal}</h2></div><span className="pill">{session.status === 'complete' ? '本轮已结束' : grammarMode ? `已聊 ${session.turnCount} 句` : `${session.turnCount} / 6 轮`}</span></div>
    {grammarMode && <details className="grammar-chat-scope"><summary>本次练习的语法 · {grammarScope.length} 个</summary><ul>{grammarScope.map(item => <li key={item.id}>{item.title}</li>)}</ul></details>}
    {grammarMode && session.status === 'active' && session.turnCount >= GRAMMAR_CHAT_MAX_TURNS - 10 && <p className="notice-inline">这次对话快满了。聊到 {GRAMMAR_CHAT_MAX_TURNS} 句后，可以新开一次继续练。</p>}
    <div className="chat-scroll" ref={transcript} role="region" tabIndex={0} aria-label="本轮对话">{session.turns.map(turn => <div className={`chat-row ${turn.role}`} key={turn.id}>
      <span className="speaker-label">{turn.role === 'user' ? '你' : turn.source === 'lesson' ? grammarMode ? '自由聊开场' : '场景开场 · 范句' : 'DeepSeek'}</span>
      <div className="bubble">{turn.role === 'user' || revealedTurns.has(turn.id) ? <p id={`turn-text-${turn.id}`} lang={turn.role === 'user' && grammarMode ? undefined : 'ja'}>{turn.text}</p> : <div className="reply-cover"><Headphones size={26} aria-hidden="true"/><p>先听一句，再看原文</p></div>}
        {showChinese && turn.translation && <p className="bubble-translation" lang="zh-CN">{turn.translation}</p>}
        {turn.role === 'assistant' && <div className="reply-actions"><button className="text-button" aria-expanded={revealedTurns.has(turn.id)} onClick={() => { setRevealedTurns(previous => { const next = new Set(previous); if (next.has(turn.id)) next.delete(turn.id); else next.add(turn.id); return next; }); if (session.status === 'active' && turn.id === last?.id) markHint(); }}>{revealedTurns.has(turn.id) ? '收起原文' : '显示原文'}</button><button className="text-button" data-audio-source={turnAudioSource(session.id, turn.id)} onClick={() => speech.say(turn.text, 'ja-JP', 1, turnAudioSource(session.id, turn.id))}><Volume2 size={17}/>听这句</button></div>}
        {turn.role === 'user' && turn.recordingId && <button className="text-button recording-replay" data-audio-source={turnAudioSource(session.id, turn.id)} onClick={() => speech.playUrl(`/api/recordings/${encodeURIComponent(turn.recordingId!)}/audio`, '我的录音', turnAudioSource(session.id, turn.id))}><Play size={17}/>听我的录音</button>}
        <AudioControls speech={speech} sourceId={turnAudioSource(session.id, turn.id)}/>
      </div>
    </div>)}{pending && <p className="thinking" role="status">正在整理一句适合你的回答……</p>}</div>
      <div className="assist-bar"><Button secondary data-audio-source={last ? turnAudioSource(session.id, last.id) : undefined} onClick={() => last && speech.say(last.text, 'ja-JP', 1, turnAudioSource(session.id, last.id))}><Repeat2 size={18}/>再听一次</Button><Button secondary data-audio-source={last ? turnAudioSource(session.id, last.id) : undefined} onClick={() => last && speech.say(last.text, 'ja-JP', .65, turnAudioSource(session.id, last.id))}>慢一点</Button><Button secondary disabled={pending} aria-pressed={showHint} onClick={() => { setShowHint(!showHint); markHint(); }}><Lightbulb size={18}/>给提示</Button><Button secondary disabled={pending} aria-pressed={showChinese} onClick={() => { setShowChinese(!showChinese); markHint(); }}>{showChinese ? '收起中文' : '看中文'}</Button>{grammarMode && <Button secondary disabled={pending || !last?.translation} data-audio-source={last ? turnAudioSource(session.id, last.id) : undefined} onClick={() => { if (last?.translation) { markHint(); speech.say(last.translation, 'zh-CN', 1, turnAudioSource(session.id, last.id)); } }}><Volume2 size={18}/>听讲解</Button>}</div>
    {session.status === 'active' ? <>
      {showHint && <div className="hint-panel" role="status">{last?.hint || `试着完成：${selectedScene?.goal}。可以用本课的词和短句。`}</div>}
      <div className="answer-zone"><RecordingControls recorder={recorder} speech={speech} disabled={pending} onStart={startRecording}/>
        <p className="tiny-note">录音保存 90 天，可在本课“我的录音”回听或删除。未发送的文字保留在当前浏览器。</p>
        {grammarMode && <div className="grammar-chat-starters" aria-label="提问起点"><p>想从哪里开始？</p><div className="row-actions">{starters.map(starter => <Button key={starter.label} secondary disabled={pending || !!draft.trim() || !!composer.pendingRequest} onClick={() => useStarter(starter.text)}>{starter.label}</Button>)}</div><p className="tiny-note">点一下放入输入框，确认后再发送。</p></div>}
        <label className="answer-label" htmlFor="answer-draft"><Keyboard size={17}/>{grammarMode ? '输入中文提问，或用日语聊一句' : '确认识别文字，或直接输入'}</label><textarea id="answer-draft" value={draft} onChange={event => setDraft(event.target.value)} aria-describedby={sendError ? 'conversation-send-error' : composer.pendingRequest ? 'conversation-pending-turn' : undefined} placeholder={grammarMode ? '例如：这个句型什么时候用？也可以输入日语。' : '用一句简单日语回答……'} maxLength={2000} rows={2} disabled={pending} onKeyDown={event => { if (event.ctrlKey && event.key === 'Enter') { event.preventDefault(); void send(); } }}/>
        {recordInfo && <p className="record-info" role="status">{recordInfo}</p>}
        {sendError && <p id="conversation-send-error" className="conversation-error" role="alert">{sendError}</p>}
        {composer.pendingRequest && !pending && <div id="conversation-pending-turn" className="pending-turn" role="status"><p>待确认的上一句：</p><p lang="ja">{composer.pendingRequest.text}</p><p>{draft.trim() !== composer.pendingRequest.text ? '重试会核对上面这句。修改后的文字保留在输入框，确认后再发送。' : '请点“重试上一句”确认发送结果。'}</p></div>}
        <div className="answer-footer"><button className="text-button" disabled={pending || recorder.status !== 'idle'} onClick={finish}>结束这轮</button><Button onClick={send} disabled={pending || (!draft.trim() && !composer.pendingRequest) || recorder.status !== 'idle' || recorder.saving}><Send size={18}/>{pending ? '等待回复' : composer.pendingRequest ? '重试上一句' : '确认并发送'}</Button></div>
      </div>
    </> : <div className="conversation-result"><span className="result-check"><Check/></span><h2>{grammarMode ? '这次自由聊，先到这里。' : '这轮练习，先到这里。'}</h2><p className="muted">{session.completedGoals.length ? `完成的小目标：${session.completedGoals.join('、')}` : '保留这次尝试，下一次可以继续练。'}</p>{session.feedback.length > 0 ? session.feedback.slice(0, 2).map((correction, i) => <div className="correction-card" key={i}><h3>{correction.goal}</h3><p>{correction.explanation}</p><Sentence example={correction.corrected} speech={speech} furigana={settings.furigana}/><div className="row-actions"><Button secondary onClick={() => { setRetryCorrection(correction); speech.stop(); }}><Mic size={17}/>现在重说</Button><Button secondary disabled={added.includes(String(i))} onClick={async () => { try { await addCorrection(correction, `${session.id}-correction-${i}`); setAdded([...added, String(i)]); } catch (error) { notice((error as Error).message); } }}><Plus size={17}/>{added.includes(String(i)) ? '已加入复习' : '加入复习'}</Button></div></div>) : <p className="notice-inline">本轮没有可展示的 AI 纠错。你也可以把课程里的卡点加入复习。</p>}{retryCorrection && <div className="hint-panel"><strong>先合上提示，说一次：{retryCorrection.goal}</strong><p>说完后自己确认；这不是发音评分。</p><Button secondary onClick={() => { setRetryCorrection(null); notice('又练了一次。下次换个情境试试。'); }}>我重说了 <Check size={17}/></Button></div>}<Button onClick={backToChoices}>{grammarMode ? '再选一个练习' : '换个场景'} <ChevronRight size={18}/></Button></div>}
  </div>;
}
