import type { FastifyInstance } from 'fastify';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { getLesson } from '../content';
import { RECORDING_RETENTION_DAYS, recordingIdSchema, recordingPatchSchema, speakingAssessmentInputSchema, type Recording, type RecordingMetadata, type SpeakingAssessment } from '../shared/recordings';
import type { Session } from '../shared/types';
import type { Store } from './store';
import { ApiError } from './schemas';
import { validateWav } from './speech';
import type { AIFetch } from './ai';
import { requestSpeakingAssessment } from './speaking-assessment';

type Serialize = <T>(id: string, task: () => T | Promise<T>) => Promise<T>;
const uploadQuery = z.object({ lessonId: z.coerce.number().int().min(1).max(50), context: z.enum(['speak', 'conversation']), itemId: z.string().trim().min(1).max(160), clientRecordingId: recordingIdSchema }).strict();
const listQuery = z.object({ lessonId: z.coerce.number().int().min(1).max(50) }).strict();
const date = () => new Date().toISOString();

function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) throw new ApiError(400, 'INVALID_INPUT', '录音或评分信息不完整，请重新选择当前练习。');
  return result.data;
}

export function registerRecordingRoutes(app: FastifyInstance, { store, dataDir, aiFetch, serialized }: { store: Store; dataDir: string; aiFetch: AIFetch; serialized: Serialize }) {
  const pendingAssessments = new Map<string, { fingerprint: string; promise: Promise<SpeakingAssessment> }>();
  const audioDir = path.resolve(dataDir, 'recordings');
  mkdirSync(audioDir, { recursive: true, mode: 0o700 });
  const audioPath = (id: string) => path.join(audioDir, `${parse(recordingIdSchema, id)}.wav`);
  function fileExists(id: string) {
    try { const info = lstatSync(audioPath(id)); return info.isFile() && !info.isSymbolicLink(); } catch { return false; }
  }
  function removeAudio(id: string) { try { unlinkSync(audioPath(id)); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; } }
  function recordingFor(id: string) {
    const record = store.get<RecordingMetadata>('recordings', parse(recordingIdSchema, id));
    if (!record) throw new ApiError(404, 'RECORDING_NOT_FOUND', '没有找到这段录音。');
    return record;
  }
  function validateTarget(lessonId: number, context: 'speak' | 'conversation', itemId: string) {
    const lesson = getLesson(lessonId);
    if (!lesson) throw new ApiError(400, 'INVALID_LESSON', '没有找到这节课。');
    if (context === 'speak') {
      if (!lesson.speaking.some(task => task.id === itemId)) throw new ApiError(400, 'INVALID_ITEM', '这个开口任务不属于当前课程。');
    } else {
      const session = store.get<Session>('sessions', itemId);
      if (!session || session.lessonId !== lessonId) throw new ApiError(400, 'INVALID_RECORDING_CONTEXT', '这段录音的对话与课程不匹配。');
    }
    return lesson;
  }
  function validateLink(id: string, lessonId: number, context: 'speak' | 'conversation', itemId: string) {
    const record = recordingFor(id);
    if (record.lessonId !== lessonId || record.context !== context || record.itemId !== itemId) throw new ApiError(400, 'RECORDING_MISMATCH', '这段录音不属于当前练习。');
    return record;
  }
  function available(record: RecordingMetadata): RecordingMetadata {
    const expired = Date.parse(record.expiresAt) <= Date.now();
    const status = record.audioStatus === 'deleted' ? 'deleted' : expired ? 'expired' : record.audioStatus === 'available' && fileExists(record.id) ? 'available' : 'missing';
    const next = { ...record, audioAvailable: status === 'available', audioStatus: status } as RecordingMetadata;
    if (record.audioStatus !== next.audioStatus || record.audioAvailable !== next.audioAvailable) store.save('recordings', next.id, next);
    return next;
  }
  function publicRecord(record: RecordingMetadata): Recording {
    const next = available(record);
    const assessment = store.all<SpeakingAssessment>('assessments').filter(item => item.recordingId === record.id && (record.confirmedText === undefined || item.text === record.confirmedText)).at(-1);
    return { ...next, ...(assessment ? { assessment } : {}) };
  }
  function cleanup() {
    for (const record of store.all<RecordingMetadata>('recordings')) {
      const current = available(record);
      if (['deleted', 'expired', 'missing'].includes(current.audioStatus)) {
        // Mark unavailable before touching the file, so a disk error never exposes it.
        try { removeAudio(current.id); } catch { /* The next cleanup retries file deletion. */ }
      }
    }
    // Files left by a crash/restore are never served without matching metadata.
    const kept = new Set(store.all<RecordingMetadata>('recordings').filter(item => item.audioStatus === 'available').map(item => `${item.id}.wav`));
    for (const name of readdirSync(audioDir)) {
      if (!/^[0-9a-f-]{36}\.wav(?:\.pending-[0-9a-f-]{36})?$/i.test(name) || kept.has(name)) continue;
      try { unlinkSync(path.join(audioDir, name)); } catch { /* Retry later; do not traverse directories or other paths. */ }
    }
  }
  cleanup();
  const timer = setInterval(() => { try { cleanup(); } catch { /* Disk/database failures are retried; recording requests still check expiry. */ } }, 60 * 60 * 1000); timer.unref();
  app.addHook('onClose', async () => { clearInterval(timer); });
  if (!app.hasContentTypeParser('audio/wav')) app.addContentTypeParser('audio/wav', { parseAs: 'buffer', bodyLimit: 1100000 }, (_request, body, done) => done(null, body));

  app.post('/api/recordings', { bodyLimit: 1100000 }, async request => {
    const input = parse(uploadQuery, request.query);
    validateTarget(input.lessonId, input.context, input.itemId);
    if (!Buffer.isBuffer(request.body)) throw new ApiError(400, 'INVALID_AUDIO', '请提交 WAV 录音。');
    let durationMs: number;
    try { durationMs = validateWav(request.body).durationMs; } catch (error) { throw new ApiError(400, 'INVALID_AUDIO', (error as Error).message); }
    const bytes = request.body;
    const hash = createHash('sha256').update(bytes).digest('hex');
    return serialized(`recording:${input.clientRecordingId}`, () => {
      const existing = store.get<RecordingMetadata>('recordings', input.clientRecordingId);
      if (existing) {
        if (existing.lessonId !== input.lessonId || existing.context !== input.context || existing.itemId !== input.itemId || store.recordingHash(existing.id) !== hash) throw new ApiError(409, 'IDEMPOTENCY_CONFLICT', '这个录音编号已用于其他内容，请重新录音后保存。');
        return publicRecord(existing);
      }
      const createdAt = date();
      const record: RecordingMetadata = { id: input.clientRecordingId, lessonId: input.lessonId, context: input.context, itemId: input.itemId, createdAt, expiresAt: new Date(Date.parse(createdAt) + RECORDING_RETENTION_DAYS * 86400000).toISOString(), durationMs, audioAvailable: true, audioStatus: 'available' };
      const destination = audioPath(record.id);
      const temporary = destination + `.pending-${randomUUID()}`;
      let installed = false;
      try {
        writeFileSync(temporary, bytes, { flag: 'wx', mode: 0o600 });
        renameSync(temporary, destination); installed = true;
        store.db.transaction(() => { store.save('recordings', record.id, record); store.saveRecordingHash(record.id, hash); })();
      } catch {
        try { if (existsSync(temporary)) unlinkSync(temporary); if (installed) unlinkSync(destination); } catch { /* Orphans are removed on cleanup. */ }
        throw new ApiError(503, 'RECORDING_SAVE_FAILED', '录音还没有保存成功。请保留这一段，再试一次。');
      }
      return publicRecord(record);
    });
  });
  app.get('/api/recordings', async request => {
    const query = parse(listQuery, request.query);
    cleanup();
    return store.all<RecordingMetadata>('recordings').filter(item => item.lessonId === query.lessonId).reverse().map(publicRecord);
  });
  app.patch<{ Params: { id: string } }>('/api/recordings/:id', async request => serialized(`recording:${parse(recordingIdSchema, request.params.id)}`, () => {
    const patch = parse(recordingPatchSchema, request.body);
    const record = { ...recordingFor(request.params.id), ...patch };
    store.save('recordings', record.id, record);
    return publicRecord(record);
  }));
  app.delete<{ Params: { id: string } }>('/api/recordings/:id', async request => serialized(`recording:${parse(recordingIdSchema, request.params.id)}`, () => {
    const record: RecordingMetadata = { ...recordingFor(request.params.id), audioAvailable: false, audioStatus: 'deleted' };
    store.save('recordings', record.id, record);
    try { removeAudio(record.id); } catch { throw new ApiError(503, 'RECORDING_DELETE_FAILED', '录音已停止提供播放，但文件删除未完成。请再试一次。'); }
    return publicRecord(record);
  }));
  app.get<{ Params: { id: string } }>('/api/recordings/:id/audio', async (request, reply) => {
    const record = available(recordingFor(request.params.id));
    if (!record.audioAvailable) throw new ApiError(410, 'AUDIO_UNAVAILABLE', record.audioStatus === 'expired' ? '这段录音已超过 90 天，文字和评分仍然保留。' : '这段录音文件已删除或未包含在学习备份中，文字仍然保留。');
    let bytes: Buffer;
    try { bytes = readFileSync(audioPath(record.id)); } catch { throw new ApiError(410, 'AUDIO_UNAVAILABLE', '录音文件暂时不可用，文字仍然保留。'); }
    reply.header('Accept-Ranges', 'bytes').header('Cache-Control', 'private, no-store').header('Content-Type', 'audio/wav').header('X-Content-Type-Options', 'nosniff');
    const range = request.headers.range;
    if (!range) return reply.header('Content-Length', bytes.length).send(bytes);
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    let start = 0, end = bytes.length - 1;
    if (match && (match[1] || match[2])) {
      if (match[1]) { start = Number(match[1]); if (match[2]) end = Math.min(end, Number(match[2])); }
      else { const suffix = Number(match[2]); start = Math.max(0, bytes.length - suffix); if (suffix <= 0) start = bytes.length; }
    } else start = bytes.length;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= bytes.length || end < start) return reply.code(416).header('Content-Range', `bytes */${bytes.length}`).send();
    return reply.code(206).header('Content-Range', `bytes ${start}-${end}/${bytes.length}`).header('Content-Length', end - start + 1).send(bytes.subarray(start, end + 1));
  });
  app.post('/api/speaking/assess', async request => {
    const input = parse(speakingAssessmentInputSchema, request.body);
    const lesson = validateTarget(input.lessonId, 'speak', input.itemId);
    const fingerprint = JSON.stringify([input.lessonId, input.itemId, input.text, input.recordingId ?? null]);
    const pending = pendingAssessments.get(input.clientAssessmentId);
    if (pending) {
      if (pending.fingerprint !== fingerprint) throw new ApiError(409, 'IDEMPOTENCY_CONFLICT', '这个评分编号正在处理另一份回答，请稍后重新提交。');
      return pending.promise;
    }
    const promise = serialized(`assessment:${input.clientAssessmentId}`, async () => {
      if (input.recordingId) validateLink(input.recordingId, input.lessonId, 'speak', input.itemId);
      const existing = store.get<SpeakingAssessment>('assessments', input.clientAssessmentId);
      if (existing) {
        if (existing.lessonId !== input.lessonId || existing.itemId !== input.itemId || existing.text !== input.text || existing.recordingId !== input.recordingId) throw new ApiError(409, 'IDEMPOTENCY_CONFLICT', '这个评分编号已用于另一份回答，请重新提交。');
        return existing;
      }
      const result = await requestSpeakingAssessment({ aiFetch, apiKey: store.getKey(), model: store.settings().model, lesson, task: lesson.speaking.find(task => task.id === input.itemId)!, text: input.text });
      const assessment: SpeakingAssessment = { ...result, id: input.clientAssessmentId, lessonId: input.lessonId, itemId: input.itemId, text: input.text, ...(input.recordingId ? { recordingId: input.recordingId } : {}), createdAt: date(), source: 'deepseek', kind: 'expression', totalScore: result.taskScore + result.grammarScore + result.vocabularyScore };
      store.db.transaction(() => {
        store.save('assessments', assessment.id, assessment);
        if (input.recordingId) { const record = recordingFor(input.recordingId); store.save('recordings', record.id, { ...record, confirmedText: input.text }); }
      })();
      return assessment;
    });
    pendingAssessments.set(input.clientAssessmentId, { fingerprint, promise });
    try { return await promise; } finally { pendingAssessments.delete(input.clientAssessmentId); }
  });
  return { cleanup, validateLink };
}
