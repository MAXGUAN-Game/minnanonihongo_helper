import Fastify from 'fastify';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { z } from 'zod';
import { course, getLesson, lessons } from '../content';
import { getGrammarChatScenario, GRAMMAR_CHAT_MAX_TURNS, isGrammarChat } from '../shared/grammar-chat';
import type { Bootstrap, Lesson, Progress, ReviewItem, Session, SpeechStatus } from '../shared/types';
import { requestTurn, type AIFetch } from './ai';
import { ApiError, attemptInputSchema, backupSchema, progressSchema, reviewInputSchema, sessionInputSchema, settingsPatchSchema, userTurnSchema, type Attempt, type Backup } from './schemas';
import { Store } from './store';
import { registerVoiceRoutes } from './voice';
import { authorizeRequest, deploymentConfig, type Deployment } from './deployment';
import { registerRecordingRoutes } from './recordings';
import type { SpeakingAssessment } from '../shared/recordings';

export type AppOptions = { dataDir?: string; deployment?: Deployment; aiFetch?: AIFetch; voiceFetch?: typeof fetch; speechStatus?: () => SpeechStatus | Promise<SpeechStatus> };
const intervals = [1, 3, 7, 14, 30];
const afterDays = (days: number) => new Date(Date.now() + days * 86400000).toISOString();
const now = () => new Date().toISOString();
const missingSpeech: SpeechStatus = { ready: false, modelReady: false, binaryReady: false, message: '语音识别尚未准备好，可以先输入文字练习。' };
function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) throw new ApiError(400, 'INVALID_INPUT', '提交的内容不完整或格式不正确，请检查后重试。');
  return result.data;
}
function lessonFor(id: number): Lesson {
  const lesson = getLesson(id);
  if (!lesson) throw new ApiError(404, 'LESSON_NOT_FOUND', '没有找到这节课。');
  return lesson;
}
function hasItem(lesson: Lesson, id: string) { return [...lesson.grammar, ...lesson.listening, ...lesson.speaking, ...lesson.scenarios].some(item => item.id === id); }
function validateProgress(progress: Omit<Progress, 'updatedAt'>) {
  const lesson = lessonFor(progress.lessonId);
  const items = { understand: lesson.grammar, listen: lesson.listening, speak: lesson.speaking, conversation: lesson.scenarios }[progress.stage];
  if (progress.cursor > items.length || (progress.itemId && !items.some(item => item.id === progress.itemId))) throw new ApiError(400, 'INVALID_PROGRESS', '学习位置与当前课程不一致。');
}
function validateBackup(backup: Backup) {
  lessonFor(backup.settings.currentLessonId);
  const unique = (values: string[]) => { if (new Set(values).size !== values.length) throw new ApiError(400, 'INVALID_BACKUP', '备份含有重复记录，原数据没有更改。'); };
  unique(backup.progress.map(item => `${item.lessonId}:${item.stage}`));
  unique(backup.attempts.map(item => item.id)); unique(backup.reviews.map(item => item.id)); unique(backup.sessions.map(item => item.id));
  unique(backup.reviews.filter(item => item.sourceId).map(item => item.sourceId!));
  for (const progress of backup.progress) validateProgress(progress);
  for (const attempt of backup.attempts) if (!hasItem(lessonFor(attempt.lessonId), attempt.itemId)) throw new ApiError(400, 'INVALID_BACKUP', '备份中的练习记录不属于这节课。');
  for (const review of backup.reviews) {
    const lesson = lessonFor(review.lessonId);
    if (review.grammarId && !lesson.grammar.some(item => item.id === review.grammarId)) throw new ApiError(400, 'INVALID_BACKUP', '备份中的语法记录不属于这节课。');
  }
  for (const session of backup.sessions) {
    const lesson = lessonFor(session.lessonId);
    const grammarChat = isGrammarChat(session);
    const scenario = grammarChat ? getGrammarChatScenario(lesson, session.grammarId) : lesson.scenarios.find(item => item.id === session.scenarioId);
    const maxTurns = grammarChat ? GRAMMAR_CHAT_MAX_TURNS : 6;
    if (!scenario || scenario.id !== session.scenarioId || session.turns.length !== 1 + session.turnCount * 2 || (session.turnCount === maxTurns && session.status !== 'complete')) throw new ApiError(400, 'INVALID_BACKUP', '备份中的对话结构不完整。');
    unique(session.turns.map(item => item.id));
    if (session.completedGoals.some(goal => !scenario.successCriteria.includes(goal))) throw new ApiError(400, 'INVALID_BACKUP', '备份中的对话目标不属于这个场景。');
    session.turns.forEach((turn, index) => {
      const role = index % 2 ? 'user' : 'assistant';
      const source = index === 0 ? 'lesson' : index % 2 ? 'user' : 'deepseek';
      if (turn.role !== role || turn.source !== source) throw new ApiError(400, 'INVALID_BACKUP', '备份中的对话顺序不正确。');
    });
    const allowedFeedback = grammarChat ? scenario.targetGrammarIds : lesson.grammar.map(grammar => grammar.id);
    if (session.turns[0].text !== scenario.opening.jp || (grammarChat && session.turns[0].translation !== scenario.opening.zh) || session.feedback.some(item => item.grammarId && !allowedFeedback.includes(item.grammarId))) throw new ApiError(400, 'INVALID_BACKUP', '备份中的课程内容不一致。');
  }
  const recordings = backup.version === 2 ? backup.recordings : [];
  const assessments = backup.version === 2 ? backup.assessments : [];
  unique(recordings.map(item => item.id)); unique(assessments.map(item => item.id));
  const invalid = () => { throw new ApiError(400, 'INVALID_BACKUP', '备份中的录音、评分与练习不匹配，原数据没有更改。'); };
  const matchesRecording = (id: string, lessonId: number, context: 'speak' | 'conversation', itemId: string) => recordings.some(record => record.id === id && record.lessonId === lessonId && record.context === context && record.itemId === itemId);
  for (const record of recordings) {
    const lesson = lessonFor(record.lessonId);
    const validItem = record.context === 'speak' ? lesson.speaking.some(item => item.id === record.itemId) : backup.sessions.some(session => session.id === record.itemId && session.lessonId === record.lessonId);
    if (!validItem || Date.parse(record.expiresAt) - Date.parse(record.createdAt) !== 90 * 86400000) invalid();
  }
  for (const assessment of assessments) {
    const lesson = lessonFor(assessment.lessonId);
    if (!lesson.speaking.some(item => item.id === assessment.itemId) || (assessment.recordingId && !matchesRecording(assessment.recordingId, assessment.lessonId, 'speak', assessment.itemId)) || assessment.corrections.some(item => !item.original.trim() || !assessment.text.includes(item.original) || (item.grammarId && !lesson.grammar.some(grammar => grammar.id === item.grammarId)))) invalid();
  }
  for (const attempt of backup.attempts) {
    if (attempt.recordingId && !matchesRecording(attempt.recordingId, attempt.lessonId, 'speak', attempt.itemId)) invalid();
    if (attempt.assessmentId && !assessments.some(item => item.id === attempt.assessmentId && item.lessonId === attempt.lessonId && item.itemId === attempt.itemId && item.recordingId === attempt.recordingId && (attempt.answer === undefined || item.text === attempt.answer))) invalid();
  }
  for (const session of backup.sessions) for (const turn of session.turns) {
    if (turn.recordingId && (turn.role !== 'user' || !matchesRecording(turn.recordingId, session.lessonId, 'conversation', session.id))) invalid();
  }
}
export function buildApp(options: AppOptions = {}) {
  const deployment = options.deployment ?? deploymentConfig({});
  const app = Fastify({ logger: false, bodyLimit: 16 * 1024 * 1024 });
  const dataDir = resolve(options.dataDir ?? resolve(process.cwd(), 'data'));
  const store = new Store(dataDir);
  const aiFetch = options.aiFetch ?? fetch;
  const locks = new Map<string, Promise<void>>();
  async function serialized<T>(id: string, task: () => Promise<T> | T): Promise<T> {
    const previous = locks.get(id) ?? Promise.resolve();
    let release!: () => void;
    const pending = new Promise<void>(done => { release = done; });
    locks.set(id, pending);
    await previous;
    try { return await task(); } finally { release(); if (locks.get(id) === pending) locks.delete(id); }
  }
  const sessions = () => store.all<Session>('sessions');
  const dueReviews = () => store.all<ReviewItem>('reviews').filter(item => Date.parse(item.dueAt) <= Date.now()).sort((a, b) => a.dueAt.localeCompare(b.dueAt));
  function sessionFor(id: string) {
    const session = store.get<Session>('sessions', id);
    if (!session) throw new ApiError(404, 'SESSION_NOT_FOUND', '没有找到这次对话。');
    return session;
  }
  app.addHook('onClose', async () => { await Promise.all(locks.values()); store.close(); });
  app.addHook('onRequest', async (request, reply) => {
    if (request.url.startsWith('/api/') || deployment.mode === 'web') reply.header('Cache-Control', 'no-store');
    authorizeRequest(request, deployment);
  });
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ApiError) return reply.code(error.status).send({ error: error.message, code: error.code });
    if (error instanceof z.ZodError || (error as { statusCode?: number }).statusCode === 400) return reply.code(400).send({ error: '提交的内容格式不正确，请检查后重试。', code: 'INVALID_INPUT' });
    if ((error as { statusCode?: number }).statusCode === 413) return reply.code(413).send({ error: request.url === '/api/restore' ? '备份文件超过 16 MiB，请使用较小的备份文件。' : '提交的内容太大，请缩短后重试。', code: 'PAYLOAD_TOO_LARGE' });
    return reply.code(500).send({ error: '服务暂时没有完成操作，请重试。', code: 'INTERNAL_ERROR' });
  });
  registerVoiceRoutes(app, store.db, dataDir, options.voiceFetch ?? fetch);
  const recordings = registerRecordingRoutes(app, { store, dataDir, aiFetch, serialized });
  app.get('/api/health', async () => deployment.mode === 'web' ? { ok: true, app: 'nihongo-small-steps' } : { ok: true, app: 'nihongo-small-steps', pid: process.pid, root: process.cwd() });
  app.get('/api/bootstrap', async (): Promise<Bootstrap> => {
    const progress = store.all<Progress>('progress');
    const allSessions = sessions();
    const settings = store.settings();
    const active = allSessions.filter(item => item.status === 'active').reverse().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    let speech = missingSpeech;
    try { if (options.speechStatus) speech = await options.speechStatus(); } catch { /* Local text learning stays available. */ }
    const independent = new Set(store.all<Attempt>('attempts').filter(item => item.result === 'good' && !item.usedHint).map(item => `${item.lessonId}:${item.itemId}`)).size;
    return { deployment: deployment.mode, ...(deployment.mode === 'web' ? { publicSite: { icpNumber: deployment.icpNumber || '' } } : {}), settings, progress, dueReviews: dueReviews(), activeSession: active.find(item => item.lessonId === settings.currentLessonId) ?? active[0] ?? null, totals: { sessions: allSessions.filter(item => item.status === 'complete').length, reviews: store.all('reviews').length, independent }, speech };
  });
  app.get('/api/lessons', async () => lessons);
  app.get('/api/course', async () => course);
  app.get<{ Params: { id: string } }>('/api/lessons/:id', async request => lessonFor(parse(z.coerce.number().int().min(1).max(50), request.params.id)));
  app.get('/api/settings', async () => store.settings());
  app.patch('/api/settings', async request => {
    const { apiKey, ...patch } = parse(settingsPatchSchema, request.body);
    if (patch.currentLessonId) lessonFor(patch.currentLessonId);
    store.db.transaction(() => { store.saveSettings({ ...store.settings(), ...patch }); if (apiKey !== undefined) store.setKey(apiKey); })();
    return store.settings();
  });
  app.post('/api/progress', async request => {
    const input = parse(progressSchema.omit({ updatedAt: true }), request.body);
    validateProgress(input);
    const lesson = lessonFor(input.lessonId);
    input.itemId ??= { understand: lesson.grammar, listen: lesson.listening, speak: lesson.speaking, conversation: lesson.scenarios }[input.stage][input.cursor]?.id;
    const progress: Progress = { ...input, updatedAt: now() };
    const progressKey = `${progress.lessonId}:${progress.stage}`;
    const previous = store.get<Progress>('progress', progressKey);
    const sameItem = previous && previous.stage === progress.stage && previous.itemId === progress.itemId && previous.cursor === progress.cursor;
    const ranks = { seen: 0, assisted: 1, independent: 2 };
    if (sameItem && ranks[previous.status] > ranks[progress.status]) progress.status = previous.status;
    store.db.transaction(() => {
      store.save('progress', progressKey, progress);
      if (input.status === 'independent' && input.itemId && !store.all<Attempt>('attempts').some(item => item.lessonId === input.lessonId && item.itemId === input.itemId && item.result === 'good' && !item.usedHint)) {
        const evidence: Attempt = { id: randomUUID(), lessonId: input.lessonId, itemId: input.itemId, result: 'good', usedHint: false, createdAt: now() };
        store.save('attempts', evidence.id, evidence);
      }
    })();
    return progress;
  });
  app.post('/api/attempts', async request => {
    const input = parse(attemptInputSchema, request.body);
    if (!hasItem(lessonFor(input.lessonId), input.itemId)) throw new ApiError(400, 'INVALID_ITEM', '这个练习不属于当前课程。');
    const record = input.recordingId ? recordings.validateLink(input.recordingId, input.lessonId, 'speak', input.itemId) : undefined;
    if (input.assessmentId) {
      const assessment = store.get<SpeakingAssessment>('assessments', input.assessmentId);
      if (!assessment || assessment.lessonId !== input.lessonId || assessment.itemId !== input.itemId || assessment.recordingId !== input.recordingId || (input.answer !== undefined && assessment.text !== input.answer)) throw new ApiError(400, 'ASSESSMENT_MISMATCH', '这个评分不属于当前回答。');
    }
    const attempt: Attempt = { ...input, result: input.usedHint && input.result === 'good' ? 'hint' : input.result, id: randomUUID(), createdAt: now() };
    store.db.transaction(() => {
      store.save('attempts', attempt.id, attempt);
      if (record && input.answer !== undefined) store.save('recordings', record.id, { ...record, confirmedText: input.answer });
    })();
    return attempt;
  });
  app.get<{ Querystring: { due?: string } }>('/api/reviews', async request => {
    if (request.query.due !== undefined && !['0', '1'].includes(request.query.due)) throw new ApiError(400, 'INVALID_INPUT', '复习筛选条件不正确。');
    return request.query.due === '1' ? dueReviews() : store.all<ReviewItem>('reviews').sort((a, b) => a.dueAt.localeCompare(b.dueAt));
  });
  app.post('/api/reviews', async request => {
    const input = parse(reviewInputSchema, request.body);
    const lesson = lessonFor(input.lessonId);
    if (input.grammarId && !lesson.grammar.some(item => item.id === input.grammarId)) throw new ApiError(400, 'INVALID_GRAMMAR', '这个语法点不属于当前课程。');
    if (input.sourceId) {
      const existing = store.all<ReviewItem>('reviews').find(item => item.sourceId === input.sourceId);
      if (existing && existing.lessonId !== input.lessonId) throw new ApiError(409, 'REVIEW_SOURCE_CONFLICT', '这条练习来源已经属于另一节课。');
      if (existing) return existing;
    }
    const item: ReviewItem = { ...input, id: randomUUID(), dueAt: afterDays(1), intervalIndex: 0, createdAt: now() };
    store.save('reviews', item.id, item);
    return item;
  });
  app.post<{ Params: { id: string } }>('/api/reviews/:id/rate', async request => {
    const { rating } = parse(z.object({ rating: z.enum(['again', 'hint', 'good']) }).strict(), request.body);
    const item = store.get<ReviewItem>('reviews', request.params.id);
    if (!item) throw new ApiError(404, 'REVIEW_NOT_FOUND', '没有找到这张复习卡。');
    if (Date.parse(item.dueAt) > Date.now()) throw new ApiError(409, 'REVIEW_NOT_DUE', '这张卡已经安排好了，下次到期再复习。');
    item.intervalIndex = rating === 'again' ? 0 : rating === 'good' ? Math.min(4, item.intervalIndex + 1) : item.intervalIndex;
    item.dueAt = afterDays(intervals[item.intervalIndex]);
    store.save('reviews', item.id, item);
    return item;
  });
  app.post('/api/sessions', async request => {
    const input = parse(sessionInputSchema, request.body);
    const lesson = lessonFor(input.lessonId);
    const grammarChat = input.mode === 'grammar';
    const scenario = grammarChat ? getGrammarChatScenario(lesson, input.grammarId) : lesson.scenarios.find(item => item.id === input.scenarioId);
    if (grammarChat && !scenario) throw new ApiError(400, 'INVALID_GRAMMAR', '这个语法点不属于当前课程。');
    if (!scenario) throw new ApiError(404, 'SCENARIO_NOT_FOUND', '没有找到这个对话场景。');
    if (grammarChat && input.scenarioId !== undefined && input.scenarioId !== scenario.id) throw new ApiError(400, 'INVALID_SCENARIO', '自由聊的课程入口不一致，请重新选择。');
    const session: Session = { id: randomUUID(), ...input, scenarioId: scenario.id, status: 'active', turnCount: 0, turns: [{ id: randomUUID(), role: 'assistant', text: scenario.opening.jp, translation: scenario.opening.zh, source: 'lesson', createdAt: now() }], feedback: [], completedGoals: [], updatedAt: now() };
    store.save('sessions', session.id, session);
    return session;
  });
  app.get<{ Params: { id: string } }>('/api/sessions/:id', async request => sessionFor(request.params.id));
  app.post<{ Params: { id: string } }>('/api/sessions/:id/turn', async request => {
    const input = parse(userTurnSchema, request.body);
    return serialized(request.params.id, async () => {
      const session = sessionFor(request.params.id);
      const existing = session.turns.find(turn => turn.role === 'user' && turn.id === input.clientTurnId);
      if (existing) {
        if (existing.text !== input.text || existing.recordingId !== input.recordingId) throw new ApiError(409, 'IDEMPOTENCY_CONFLICT', '这次发送编号已经用于另一句话，请重新发送。');
        return session;
      }
      if (session.turns.some(turn => turn.id === input.clientTurnId)) throw new ApiError(409, 'IDEMPOTENCY_CONFLICT', '这次发送编号已经存在，请重新发送。');
      if (input.recordingId) recordings.validateLink(input.recordingId, session.lessonId, 'conversation', session.id);
      const grammarChat = isGrammarChat(session);
      const maxTurns = grammarChat ? GRAMMAR_CHAT_MAX_TURNS : 6;
      if (session.status === 'complete' || session.turnCount >= maxTurns) throw new ApiError(409, 'SESSION_COMPLETE', '这次练习已经结束，可以开始新的一轮。');
      const apiKey = store.getKey();
      if (!apiKey) throw new ApiError(503, 'AI_NOT_CONFIGURED', '请先在设置中填写 DeepSeek API 密钥，或继续教材练习。');
      const lesson = lessonFor(session.lessonId);
      const scenario = grammarChat ? getGrammarChatScenario(lesson, session.grammarId) : lesson.scenarios.find(item => item.id === session.scenarioId);
      if (!scenario || scenario.id !== session.scenarioId) throw new ApiError(400, 'INVALID_SCENARIO', '这次练习与当前课程不一致，请重新开始。');
      const result = await requestTurn({ aiFetch, apiKey, model: store.settings().model, lesson, prerequisites: lesson.prerequisiteLessonIds.map(id => { const prerequisite = lessonFor(id); return { id, canDo: prerequisite.canDo }; }), scenario, session, text: input.text, usedHint: input.usedHint });
      const completedGoals = grammarChat ? [] : [...new Set([...session.completedGoals, ...result.completedGoals])];
      const turnCount = session.turnCount + 1;
      const complete = turnCount >= maxTurns || (!grammarChat && turnCount >= 4 && scenario.successCriteria.every(goal => completedGoals.includes(goal)));
      const feedback = [...session.feedback];
      for (const correction of result.corrections) if (feedback.length < 2 && !feedback.some(item => item.original === correction.original && item.corrected.jp === correction.corrected.jp)) feedback.push(correction);
      const updated: Session = { ...session, turnCount, completedGoals, feedback, status: complete ? 'complete' : 'active', updatedAt: now(), turns: [...session.turns, { id: input.clientTurnId, role: 'user', text: input.text, source: 'user', createdAt: now(), ...(input.recordingId ? { recordingId: input.recordingId } : {}) }, { id: randomUUID(), role: 'assistant', text: result.replyJa, translation: result.replyZh, hint: result.hintZh, source: 'deepseek', createdAt: now() }] };
      store.db.transaction(() => {
        store.save('sessions', session.id, updated);
        if (input.recordingId) { const record = recordings.validateLink(input.recordingId, session.lessonId, 'conversation', session.id); store.save('recordings', record.id, { ...record, confirmedText: input.text }); }
      })();
      return updated;
    });
  });
  app.post<{ Params: { id: string } }>('/api/sessions/:id/finish', async request => serialized(request.params.id, () => {
    const session = sessionFor(request.params.id);
    if (session.status === 'active') { session.status = 'complete'; session.updatedAt = now(); store.save('sessions', session.id, session); }
    return session;
  }));
  app.get('/api/backup', async () => { recordings.cleanup(); return store.backup(); });
  app.post('/api/restore', async request => {
    const { backup } = parse(z.object({ backup: backupSchema }).strict(), request.body);
    validateBackup(backup);
    if (locks.size) throw new ApiError(409, 'STORE_BUSY', '请等当前对话发送完成，再恢复备份。');
    recordings.cleanup();
    store.restore(backup);
    recordings.cleanup();
    return { ok: true, settings: store.settings() };
  });
  return app;
}
