import { VocabularyWord } from './VocabularyWord';
import type { VocabularyLessonProgress } from '../shared/vocabulary';
import { translate } from './i18n';
import { AudioAnswer } from './AudioAnswer';
import { getPreferences, usePreferences, setPreferences, useTranslation } from './preferences';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowRight, Headphones, Mic, Play, RotateCcw, Volume2 } from 'lucide-react';
import type { PracticeAttempt, PracticeCurrent, PracticeKind, PracticeQuestion } from '../shared/ai-practice';
import type { AudioAssessmentSettings } from '../shared/audio-assessment';
import type { Speech } from './speech';
import { useRecorder } from './speech';
import { api, ClientApiError } from './api';
import { Button, Sentence } from './ui';
import { AudioControls } from './AudioControls';
import { RecordingControls } from './RecordingControls';
import { PracticePrefetch } from './practice-prefetch';

type Props = { lessonId: number; kind: PracticeKind; speech: Speech; notice: (message: string) => void; furigana: boolean };
const names = { vocabulary: '单词造句', dictation: '单句听力', dialogue: '对话听力', speaking: 'AI口语练习' };
const generationRetryDelays = [1000, 2000, 4000];
function isPassingAnswer(attempt: PracticeAttempt) {
  return attempt.kind === 'speaking' ? attempt.result.targetGrammarUsed && attempt.result.meaningScore + attempt.result.grammarScore >= 56 : attempt.correct;
}
function PracticeFocus({ question }: { question: PracticeQuestion }) {
  const t = useTranslation();
  const vocabulary = question.content.kind === 'vocabulary';
  const lessonId = vocabulary ? question.lessonId : question.grammarSourceLessonId;
  return <p className="tiny-note practice-focus">{t('考点', '学習ポイント')}：<span lang="ja">{question.content.kind === 'vocabulary' ? question.content.word : question.grammarTitle}</span> · {t(`所属单元：第${lessonId}单元`, `出典：第${lessonId}課`)}</p>;
}
function PracticeReference({ question, attempt, speech, furigana }: { question: PracticeQuestion; attempt: Extract<PracticeAttempt, { kind: 'speaking' }>; speech: Speech; furigana: boolean }) {
  const t = useTranslation();
  return <details key={attempt.id} open onToggle={event => { if (!event.currentTarget.open) speech.stop(); }}><summary>{t('查看参考表达', '参考表現を見る')}</summary><PracticeFocus question={question}/><Sentence example={attempt.result.reference} speech={speech} furigana={furigana}/></details>;
}
function waitForRetry(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(new DOMException('Cancelled', 'AbortError')); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
  });
}
export function PracticeScoreFeedback({ attempt }: { attempt: Extract<PracticeAttempt, { kind: 'speaking' }> }) {
  const t = useTranslation();
  const result = attempt.result;
  if (attempt.inputMode === 'text') return <section className="audio-assessment-result" aria-label={t('文字表达评分', '文章表現の評価')}>
    <h3>{t('文字表达参考分', '文章表現の参考スコア')} · {result.meaningScore + result.grammarScore}/70</h3>
    <div className="ai-score-parts"><span>{t('意思表达', '意味の表現')} {result.meaningScore}/40</span><span>{t('语法', '文法')} {result.grammarScore}/30</span></div>
    <p>{result.summaryZh}</p><p>{result.grammarFeedbackZh}</p>
    {result.corrections.map((item, i) => <p key={i}>{item.explanation} <span lang="ja">{item.original} → {item.corrected.jp}</span></p>)}
    <p className="tiny-note">{t('拼写模式不评估发音。', '入力モードでは発音を評価しません。')}{attempt.usedHint && t('本次为借助提示重练。', '今回はヒントを利用した再練習です。')}</p>
    <details><summary>{t('已提交的句子', '提出した文')}</summary><p lang="ja">{attempt.answer}</p></details>
  </section>;
  return <section className="audio-assessment-result" aria-label={translate("AI口语评分")}>
    <h3>{translate("AI练习参考分")}{attempt.totalScore !== null ? ` · ${attempt.totalScore}/100` : ' · 本次发音无法可靠评分'}</h3>
    <div className="ai-score-parts"><span>{translate("意思表达")}{result.meaningScore}/40</span><span>{translate("语法")}{result.grammarScore}/30</span><span>{translate("发音")}{result.pronunciationScore === null ? translate('暂无法判断') : `${result.pronunciationScore}/30`}</span></div>
    <p>{result.summaryZh}</p><p>{translate("语法与表达：")}{result.grammarFeedbackZh}</p><p>{translate("发音与节奏：")}{result.pronunciation.feedbackZh}</p>
    {result.corrections.map((item, i) => <p key={i}>{item.explanation} <span lang="ja">{item.original} → {item.corrected.jp}</span></p>)}
    {result.pronunciation.issues.map((item, i) => <p key={i}><span lang="ja">{item.word}（{item.expectedKana}）</span>：{item.issueZh} {item.practiceTipZh}</p>)}
    <p className="tiny-note">{attempt.usedHint ? translate('本次为借助提示重练。') : translate('本次未查看答案。')}{translate("分析用时")}{(attempt.latencyMs / 1000).toFixed(1)}{translate("秒。")}{attempt.totalScore === null && translate('可以靠近麦克风重录。')}</p>
    <details><summary>{translate("AI听到的内容")}</summary><p lang="ja">{result.text}</p></details>
  </section>;
}

function AISpeaking({ question, initial, speech, notice, furigana, suspended, onResult, onBusy }: {
  question: PracticeQuestion; initial: PracticeAttempt | null; speech: Speech; notice: (message: string) => void; furigana: boolean; suspended: boolean; onResult: (attempt: PracticeAttempt) => void; onBusy: (busy: boolean) => void;
}) {
  const [settings, setSettings] = useState<AudioAssessmentSettings | null>(null);
  const [settingsRevision, setSettingsRevision] = useState(0);
  const [result, setResult] = useState(initial?.kind === 'speaking' ? initial : null);
  const [pending, setPending] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState('');
  const controller = useRef<AbortController | null>(null);
  const alive = useRef(true);
  const attempted = useRef(new Set<string>());
  const ids = useRef(new Map<string, string>());
  const recorder = useRecorder(() => {}, notice, { lessonId: question.lessonId, itemId: question.id, context: 'ai-speak' }, { transcribe: false, persist: false });
  useEffect(() => { onBusy(pending || recorder.status !== 'idle' || recorder.saving); return () => onBusy(false); }, [pending, recorder.status, recorder.saving, onBusy]);
  useEffect(() => { alive.current = true; return () => { alive.current = false; controller.current?.abort(); speech.stop(); }; }, []);
  useEffect(() => {
    const request = new AbortController(); const timeout = setTimeout(() => { request.abort(); if (alive.current) setError(translate('读取听音设置超时，请重新检查。')); }, 10000);
    void api<AudioAssessmentSettings>('/speaking/audio-settings', { signal: request.signal }).then(value => { if (!request.signal.aborted) { setSettings(value); setError(''); } })
      .catch(() => { if (alive.current && !request.signal.aborted) setError(translate('读取听音设置失败，请重新检查。')); }).finally(() => clearTimeout(timeout));
    return () => { request.abort(); clearTimeout(timeout); };
  }, [settingsRevision]);
  useEffect(() => { if (suspended) { recorder.stop(); controller.current?.abort(); controller.current = null; setPending(false); } }, [suspended]);
  useEffect(() => {
    if (!pending) return; const started = Date.now(); setElapsed(0);
    const timer = setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 1000); return () => clearInterval(timer);
  }, [pending]);
  async function assess(recordingId: string) {
    if (controller.current || suspended || !settings?.hasApiKey) return;
    const request = new AbortController(); controller.current = request; attempted.current.add(recordingId);
    let id = ids.current.get(recordingId); if (!id) { id = crypto.randomUUID(); ids.current.set(recordingId, id); }
    setPending(true); setError(''); speech.stop();
    const timeout = setTimeout(() => { request.abort(); if (alive.current && controller.current === request) { controller.current = null; setPending(false); setError(translate('等待评分超过135秒，录音仍保留，请重试评分。')); } }, 135000);
    try {
      const value = await api<Extract<PracticeAttempt, { kind: 'speaking' }>>(`/ai-practice/questions/${question.id}/assess-audio?clientAssessmentId=${id}`, {
        method: 'POST', signal: request.signal, headers: { 'Content-Type': 'audio/wav' }, body: await recorder.getWav(),
      });
      if (alive.current && !request.signal.aborted) { setResult(value); onResult(value); window.dispatchEvent(new Event('nihongo-recordings-changed')); }
    } catch (failure) { if (alive.current && !request.signal.aborted) setError((failure as Error).message); }
    finally { clearTimeout(timeout); if (controller.current === request) { controller.current = null; if (alive.current) setPending(false); } }
  }
  const recordingId = recorder.clip?.recordingId;
  useEffect(() => { if (recordingId && !suspended && settings?.hasApiKey && !attempted.current.has(recordingId)) void assess(recordingId); }, [recordingId, suspended, settings?.hasApiKey]);
  function start() { controller.current?.abort(); controller.current = null; setPending(false); setResult(null); setError(''); speech.stop(); void recorder.start(); }
  return <>
    {!settings && <p role="status">{translate("正在检查听音设置……")}</p>}
    {settings && !settings.hasApiKey && <p>{translate("请到")}<a href="#settings">{translate("学习设置")}</a>{translate("配置「AI听录音」的百炼密钥。")}</p>}
    {settings?.hasApiKey && <p className="tiny-note">{translate("录完自动听音评分。最长30秒。")}</p>}
    <RecordingControls recorder={recorder} speech={speech} centered disabled={suspended || recorder.saving || !settings?.hasApiKey} onStart={start}/>
    {recorder.saving && <p role="status">{translate("正在保存录音……")}</p>}
    {pending && <div className="row-actions"><p role="status">{translate("AI正在听录音……")}{elapsed}{translate("秒")}</p><Button secondary onClick={() => { controller.current?.abort(); controller.current = null; setPending(false); setError(translate('已停止等待。录音仍保留，可以重试评分。')); }}>{translate("停止等待")}</Button></div>}
    {error && <div role="alert" className="notice-inline"><p>{error}</p>{!settings ? <Button secondary onClick={() => setSettingsRevision(n => n + 1)}>{translate("重新检查听音设置")}</Button> : recordingId && <Button secondary disabled={suspended || pending || recorder.saving} onClick={() => void assess(recordingId)}><RotateCcw size={16}/>{translate("重试评分")}</Button>}</div>}
    {result && <><PracticeScoreFeedback attempt={result}/>
      <PracticeReference question={question} attempt={result} speech={speech} furigana={furigana}/>

      <Button secondary disabled={suspended || recorder.saving || recorder.status !== 'idle'} onClick={start}>{translate("再练本题")}</Button>
    </>}
  </>;
}

export function AIPractice({ lessonId, kind, speech, notice, furigana }: Props) {
  const preferences = usePreferences();
  const t = useTranslation();
  const pool = useMemo(() => new PracticePrefetch((clientRequestId, signal) => api<PracticeCurrent>('/ai-practice/prefetch', {
    method: 'POST', signal, body: JSON.stringify({ lessonId, kind, clientRequestId }),
  })), [lessonId, kind]);
  const [marking, setMarking] = useState(false);
  const markingRef = useRef(false);
  const [markedWord, setMarkedWord] = useState<string | null>(null);
  const nextCandidate = useRef<PracticeCurrent | null>(null);
  const [current, setCurrent] = useState<PracticeCurrent>({ question: null, attempt: null });
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState<'generate' | 'answer' | null>(null);
  const [generationRetry, setGenerationRetry] = useState(0);
  const [speakingBusy, setSpeakingBusy] = useState(false);
  const [error, setError] = useState('');
  const [elapsed, setElapsed] = useState(0);
  const [answer, setAnswer] = useState('');
  const [picked, setPicked] = useState<number | null>(null);
  const request = useRef<AbortController | null>(null);
  const generationId = useRef<string | null>(null);
  const answerId = useRef<{ answer: string; id: string } | null>(null);
  const composing = useRef(false);
  const answerInput = useRef<HTMLTextAreaElement>(null);
  const focusAnswer = useRef(false);
  const advanceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    nextCandidate.current = null;
    return () => { pool.pause(); };
  }, [pool]);
  useEffect(() => { if (current.question) pool.start(); }, [pool, current.question?.id]);
  useEffect(() => {
    const word = current.question?.content;
    if (word?.kind !== 'vocabulary') return;
    let controller: AbortController | undefined;
    const refreshMastery = () => {
      controller?.abort(); controller = new AbortController(); const signal = controller.signal;
      void api<VocabularyLessonProgress>(`/lessons/${lessonId}/vocabulary`, { signal }).then(value => {
        if (!signal.aborted) setMarkedWord(value.mastery?.some(item => item.wordId === word.wordId && item.mastered) ? word.wordId : null);
      }).catch(() => {});
    };
    refreshMastery(); window.addEventListener('practice-assessed', refreshMastery);
    return () => { controller?.abort(); window.removeEventListener('practice-assessed', refreshMastery); };
  }, [lessonId, current.question?.id]);
  useEffect(() => {
    if (!preferences.autoAdvanceOnEnter && advanceTimer.current) { clearTimeout(advanceTimer.current); advanceTimer.current = null; }
  }, [preferences.autoAdvanceOnEnter]);
  useEffect(() => { if (!pending && current.question && focusAnswer.current) { answerInput.current?.focus(); focusAnswer.current = false; } }, [current.question?.id, pending]);
  useEffect(() => {
    let disposed = false;
    alive.current = true; const controller = new AbortController(); request.current = controller;
    const timeout = setTimeout(() => controller.abort(), 10000);
    void api<PracticeCurrent>(`/ai-practice/current?lessonId=${lessonId}&kind=${kind}`, { signal: controller.signal }).then(value => {
      if (!disposed && alive.current && !controller.signal.aborted) { setCurrent(value); if (value.attempt?.kind === 'dictation' || value.attempt?.kind === 'vocabulary') setAnswer(value.attempt.answer); if (value.attempt?.kind === 'speaking' && value.attempt.inputMode === 'text') setAnswer(value.attempt.answer ?? value.attempt.result.text); if (value.attempt?.kind === 'dialogue') setPicked(Number(value.attempt.answer)); }
    }).catch(failure => { if (!disposed && alive.current) setError(controller.signal.aborted ? translate('读取练习超时，请重新进入AI练习。') : failure.message); })
      .finally(() => { clearTimeout(timeout); if (request.current === controller) request.current = null; if (!disposed && alive.current) setLoading(false); });
    return () => { disposed = true; alive.current = false; controller.abort(); request.current?.abort(); if (advanceTimer.current) clearTimeout(advanceTimer.current); speech.stop(); };
  }, [lessonId, kind]);
  useEffect(() => { if (!pending) return; const started = Date.now(); setElapsed(0); const timer = setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 1000); return () => clearInterval(timer); }, [pending]);
  async function run<T>(operation: 'generate' | 'answer', path: string, body: unknown, accept: (value: T) => void, work?: (signal: AbortSignal) => Promise<T>) {
    if (request.current || loading) return;
    const controller = new AbortController(); request.current = controller; setPending(operation); setGenerationRetry(0); setError(''); speech.stop();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      for (let retries = 0; ; retries++) {
        controller.signal.throwIfAborted();
        timeout = setTimeout(() => { controller.abort(); if (alive.current && request.current === controller) { request.current = null; setPending(null); setGenerationRetry(0); setError(translate('等待超过40秒，请重试。当前题目仍保留。')); } }, 40000);
        try {
          const value = await (work ? work(controller.signal) : api<T>(path, { method: 'POST', signal: controller.signal, body: JSON.stringify(body) }));
          if (alive.current && !controller.signal.aborted) accept(value);
          break;
        } catch (failure) {
          clearTimeout(timeout);
          if (operation !== 'generate' || controller.signal.aborted || !alive.current || retries >= generationRetryDelays.length ||
            !(failure instanceof ClientApiError) || !['PRACTICE_INVALID_RESPONSE', 'PRACTICE_UNAVAILABLE', 'PRACTICE_TIMEOUT'].includes(failure.code ?? '')) throw failure;
          setGenerationRetry(retries + 1);
          await waitForRetry(generationRetryDelays[retries], controller.signal);
        }
      }
    }
    catch (failure) { if (alive.current && !controller.signal.aborted) setError((failure as Error).message); }
    finally { clearTimeout(timeout); if (request.current === controller) { request.current = null; if (alive.current) { setPending(null); setGenerationRetry(0); } } }
  }
  async function takeNext(signal: AbortSignal): Promise<PracticeCurrent> {
    for (;;) {
      signal.throwIfAborted();
      nextCandidate.current ??= await pool.take(signal);
      signal.throwIfAborted();
      const candidate = nextCandidate.current;
      if (!candidate.question) { nextCandidate.current = null; return candidate; }
      const activated = await api<PracticeCurrent>(`/ai-practice/questions/${candidate.question.id}/activate`, {
        method: 'POST', signal, body: JSON.stringify({ lessonId, kind }),
      });
      signal.throwIfAborted(); nextCandidate.current = null;
      if (activated.question || activated.completed) return activated;
      // Vocabulary can become mastered while its next question is waiting.
    }
  }
  function generate() {
    if (request.current || loading || markingRef.current) return;
    if (advanceTimer.current) { clearTimeout(advanceTimer.current); advanceTimer.current = null; }
    generationId.current ??= crypto.randomUUID();
    void run<PracticeCurrent>('generate', '/ai-practice/questions', { lessonId, kind, clientRequestId: generationId.current }, value => {
      focusAnswer.current = true;
      setCurrent(value); setMarkedWord(null); generationId.current = null; answerId.current = null; setAnswer(''); setPicked(null);
    }, current.question ? takeNext : undefined);
  }
  async function submit(value: string, advance = false) {
    if (!current.question || !value.trim() || request.current || markingRef.current || markedWord) return;
    if (advanceTimer.current) return;
    focusAnswer.current = true;
    if (answerId.current?.answer !== value) answerId.current = { answer: value, id: crypto.randomUUID() };
    let correct = false;
    await run<PracticeAttempt>('answer', `/ai-practice/questions/${current.question.id}/answer`, { answer: value, clientAttemptId: answerId.current.id }, attempt => {
      window.dispatchEvent(new Event('practice-assessed')); setCurrent(old => ({ ...old, attempt }));
      correct = isPassingAnswer(attempt);
    });
    if (advance && correct && alive.current && getPreferences().autoAdvanceOnEnter) advanceTimer.current = setTimeout(() => { advanceTimer.current = null; if (alive.current && getPreferences().autoAdvanceOnEnter) generate(); }, 350);
  }
  async function markMastered() {
    const word = current.question?.content;
    if (word?.kind !== 'vocabulary' || request.current || markingRef.current || speakingBusy) return;
    if (advanceTimer.current) { clearTimeout(advanceTimer.current); advanceTimer.current = null; }
    const controller = new AbortController(); request.current = controller;
    markingRef.current = true; setMarking(true); setError(''); speech.stop();
    let saved = false;
    try {
      await api(`/lessons/${lessonId}/vocabulary/${encodeURIComponent(word.wordId)}/mastery`, { method: 'PATCH', signal: controller.signal, body: JSON.stringify({ mastered: true }) });
      if (controller.signal.aborted) return;
      saved = true; setMarkedWord(word.wordId); pool.discardWord(word.wordId); nextCandidate.current = null;
      window.dispatchEvent(new Event('practice-assessed'));
    } catch (failure) { if (!controller.signal.aborted) setError((failure as Error).message); }
    finally { if (request.current === controller) request.current = null; markingRef.current = false; if (alive.current) setMarking(false); }
    if (saved && alive.current && !controller.signal.aborted) generate();
  }
  function changeAnswer(value: string) {
    if (advanceTimer.current) { clearTimeout(advanceTimer.current); advanceTimer.current = null; }
    setAnswer(value);
  }
  const question = current.question; const content = question?.content;
  const sourceId = question ? `ai-practice:${question.id}` : '';
  const listeningAttempt = current.attempt && current.attempt.kind !== 'speaking' ? current.attempt : null;
  const canAdvanceOnEnter = !!current.attempt && current.attempt.questionId === question?.id && current.attempt.inputMode !== 'audio'
    && current.attempt.answer?.trim() === answer.trim() && isPassingAnswer(current.attempt);
  const answerLabel = kind === 'speaking' ? t('用日语写出你的回答', '日本語で回答を書いてください') : kind === 'vocabulary' ? t('用这个词造一个句子', 'この単語で文を作ってください') : t('你听到的完整日语句子', '聞こえた日本語の文');
  const spellingForm = question && (<form onSubmit={event => { event.preventDefault(); submit(answer); }}><label className="dictation-label" htmlFor={`dictation-${question.id}`}>{answerLabel}</label><textarea ref={answerInput} aria-label={answerLabel} onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }} onKeyDown={event => {
            if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing || composing.current || event.keyCode === 229) return;
            event.preventDefault(); if (!event.repeat) {
              if (canAdvanceOnEnter) generate();
              else void submit(answer, preferences.autoAdvanceOnEnter);
            }
          }} id={`dictation-${question.id}`} lang="ja" rows={3} value={answer} maxLength={2000} onChange={event => changeAnswer(event.target.value)} placeholder={preferences.immersive ? undefined : translate("在这里写出整句话……")} disabled={pending !== null || marking || !!markedWord}/><p className="tiny-note practice-instruction">{t('按回车提交，答对后再按回车下一题；Shift+Enter 换行。', 'Enterで回答し、正解後にもう一度Enterで次の問題へ。Shift+Enterで改行。')}</p><div className="row-actions spelling-actions"><Button disabled={pending !== null || marking || !!markedWord || !answer.trim()} type="submit">{kind === 'dictation' ? translate('检查听写') : t('检查句子', '文を確認')}</Button><label className="toggle-row auto-advance-toggle"><input type="checkbox" role="switch" checked={preferences.autoAdvanceOnEnter} onChange={event => setPreferences({ autoAdvanceOnEnter: event.target.checked })}/><span>{t('回车答对自动下一题', 'Enterで正解したら次の問題へ')}</span></label></div></form>);
  return <div className="ai-practice">
    <nav className="study-navigation" aria-label={translate("AI练习换题")}><span className="tiny-note">{kind === 'vocabulary' ? t('本课单词 · 仅练未掌握单词', 'この課の単語 · 未習得のみ練習') : translate("无限练习 · 本课70%／上一课20%／上上课10%")}</span><Button aria-label={question ? translate('下一题') : translate('开始练习')} disabled={loading || pending !== null || current.completed || marking} onClick={generate}><span className="immersion-text">{pending === 'generate' ? translate('正在出题……') : question ? translate('下一题') : translate('开始练习')}</span><ArrowRight size={18}/></Button></nav>
    {loading && <p role="status">{translate("正在恢复练习……")}</p>}
    {pending && <div className="row-actions"><p role="status">{pending === 'generate' ? generationRetry ? `${t('正在自动重试出题', '問題を自動再生成中')} ${generationRetry}/${generationRetryDelays.length}` : translate('AI正在生成新题') : translate('正在检查答案')}…… {elapsed}{translate("秒")}</p>{pending === 'generate' && <Button secondary onClick={() => { request.current?.abort(); request.current = null; pool.pause(); setPending(null); setGenerationRetry(0); }}>{t('停止出题', '生成を停止')}</Button>}</div>}

    {error && <div className="notice-inline" role="alert"><p>{error}</p>{generationId.current && <Button secondary disabled={loading || pending !== null} onClick={generate}><RotateCcw size={16}/>{translate("重试出题")}</Button>}</div>}
    <section className="study-card" aria-label={translate(names[kind])}>
      <div className="card-label">{kind === 'speaking' ? <Mic size={18}/> : <Headphones size={18}/>} {translate(names[kind])}</div>
      {current.completed && <p role="status">{t('本单元单词已全部掌握！可在单词表中取消勾选，重新练习。', 'この課の単語をすべて習得しました。単語表でチェックを外すと再練習できます。')}</p>}
      {!question && !current.completed && <><h2>{translate("每次练一道新题")}</h2><p>{translate("点击上方「开始练习」。AI按课程语法随机出题，进度保存在服务器。")}</p></>}
      {question && <>
        {content?.kind === 'speaking' ? <><h2>{translate("用日语表达：")}{content.goalZh}</h2>
          <label>{t('回答模式', '回答方法')}<select aria-label={t('回答模式', '回答方法')} value={preferences.speakingMode} disabled={pending !== null || speakingBusy} onChange={event => { speech.stop(); setPreferences({ speakingMode: event.target.value as 'text' | 'audio' }); }}><option value="audio">{t('录音', '録音')}</option><option value="text">{t('拼写', '入力')}</option></select></label>
          {preferences.speakingMode === 'audio' ? <AISpeaking key={question.id} question={question} initial={current.attempt} speech={speech} notice={notice} furigana={furigana} suspended={pending === 'generate'} onBusy={setSpeakingBusy} onResult={attempt => (window.dispatchEvent(new Event('practice-assessed')), setCurrent(old => ({ ...old, attempt })))}/> : <>
            <p className="tiny-note">{t('按中文目标写日语，意思40分、语法30分。超过63分计入单元进度（换算后超过90分）。', '中国語の課題を日本語で表現してください。意味40点・文法30点。63点超で進捗に加算します（換算後90点超）。')}</p>
            {spellingForm}
            {current.attempt?.kind === 'speaking' && <><PracticeScoreFeedback attempt={current.attempt}/><PracticeReference question={question} attempt={current.attempt} speech={speech} furigana={furigana}/></>}
          </>}
        </> : content && <>
          {content.kind === 'vocabulary' ? <div className="vocabulary-practice-title"><h2><VocabularyWord key={question.id} word={content.word} wordId={content.wordId} lessonId={lessonId} speech={speech}/></h2><label className="toggle-row"><input type="checkbox" role="switch" aria-label={t('已掌握', '習得済み')} checked={markedWord === content.wordId} disabled={pending !== null || marking || speakingBusy || markedWord === content.wordId} onChange={() => void markMastered()}/><span>{t('已掌握', '習得済み')}</span></label></div> : <h2 className="practice-instruction">{content.kind === 'dictation' ? translate('完整写出你听到的句子') : translate('听对话，选出正确答案')}</h2>}
          {content.kind === 'vocabulary' && <p className="vocabulary-question-detail"><span lang="ja">{content.reading}</span>{content.partOfSpeech && <> · {content.partOfSpeech}</>}</p>}
          {content.kind !== 'vocabulary' && <AudioControls speech={speech} sourceId={sourceId} disabled={pending !== null || marking || !!markedWord} onPlay={() => speech.say(content.kind === 'dictation' ? content.sentence.jp : content.lines.map(line => line.jp), 'ja-JP', 1, sourceId, content.kind === 'dialogue' ? content.lines.map((_, i) => i % 2 ? 'dialogue-b' : 'dialogue-a') : undefined)}/>}
          {(content.kind === 'dictation' || content.kind === 'vocabulary') && <label>{t('回答模式', '回答方法')}<select aria-label={t('回答模式', '回答方法')} value={content.kind === 'vocabulary' ? preferences.vocabularyMode : preferences.dictationMode} disabled={pending !== null || marking || speakingBusy} onChange={event => setPreferences({ [content.kind === 'vocabulary' ? 'vocabularyMode' : 'dictationMode']: event.target.value as 'text' | 'audio' })}><option value="text">{t('拼写', '入力')}</option><option value="audio">{t('录音', '録音')}</option></select></label>}
          {(content.kind === 'dictation' || content.kind === 'vocabulary') ? (content.kind === 'vocabulary' ? preferences.vocabularyMode : preferences.dictationMode) === 'audio' ? <AudioAnswer key={question.id} questionId={question.id} speech={speech} notice={notice} suspended={pending !== null || marking || !!markedWord} onBusy={setSpeakingBusy} onResult={attempt => setCurrent(old => ({ ...old, attempt }))}/> : spellingForm : <>
            <h3>{content.questionZh}</h3><div className="answer-choices">{content.options.map((option, i) => <button key={i} disabled={pending !== null || marking || !!markedWord} aria-pressed={picked === i} className={listeningAttempt && picked === i ? listeningAttempt.correct ? 'correct' : 'try-again' : ''} onClick={() => { setPicked(i); submit(String(i)); }}><span>{String.fromCharCode(65 + i)}</span>{option}</button>)}</div>
          </>}
          {listeningAttempt && <div className={`answer-feedback ${listeningAttempt.correct ? 'success' : ''}`} role="status"><strong>{listeningAttempt.correct ? translate('答对了。') : translate('再练一下。')}</strong> {listeningAttempt.feedbackZh}{listeningAttempt.usedHint && <p className="tiny-note">{translate("本次为查看答案后的重练。")}</p>}</div>}
          {listeningAttempt && <PracticeFocus question={question}/>}
          {listeningAttempt && (content.kind === 'vocabulary' ? listeningAttempt.reference && <Sentence example={listeningAttempt.reference} speech={speech} furigana={furigana}/> : content.kind === 'dictation' ? <div className="listening-transcript"><Sentence example={content.sentence} speech={speech} furigana={furigana}/></div> : <details key={listeningAttempt.id} open onToggle={event => { if (!event.currentTarget.open) speech.stop(); }}><summary>{translate("查看对话原文与中文")}</summary>{content.lines.map((line, i) => <div className="dialogue-line" key={i}><span aria-label={i % 2 ? 'B（女）' : 'A（男）'}>{i % 2 ? 'B（女）' : 'A（男）'}</span><Sentence example={line} speech={speech} furigana={furigana} speaker={i % 2 ? 'dialogue-b' : 'dialogue-a'}/></div>)}</details>)}
        </>}
      </>}
    </section>
  </div>;
}
