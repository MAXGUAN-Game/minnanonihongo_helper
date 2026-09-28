import { z } from 'zod';

const identifier = z.string().trim().min(1).max(160);
const text = z.string().trim().min(1).max(1000);
const date = z.iso.datetime({ offset: true });
export const recordingIdSchema = z.uuid().toLowerCase();
const example = z.object({ jp: text, kana: z.string().max(1500), zh: text }).strict();
const correction = z.object({ goal: text, original: z.string().max(2000), corrected: example, explanation: text, grammarId: identifier.optional() }).strict();

// These scores evaluate the confirmed text, never pronunciation or the waveform.
export const speakingAssessmentResultSchema = z.object({
  taskScore: z.number().int().min(0).max(50),
  grammarScore: z.number().int().min(0).max(30),
  vocabularyScore: z.number().int().min(0).max(20),
  summaryZh: text,
  corrections: z.array(correction).max(2),
  reference: example,
}).strict();
export type SpeakingAssessmentResult = z.infer<typeof speakingAssessmentResultSchema>;
export const speakingAssessmentSchema = speakingAssessmentResultSchema.extend({
  id: recordingIdSchema, lessonId: z.number().int().min(1).max(50), itemId: identifier,
  text: z.string().trim().min(1).max(2000), recordingId: recordingIdSchema.optional(), createdAt: date,
  source: z.literal('deepseek'), kind: z.literal('expression'), totalScore: z.number().int().min(0).max(100),
}).strict().refine(value => value.totalScore === value.taskScore + value.grammarScore + value.vocabularyScore, { message: 'Total score must equal the three expression scores.' });
export type SpeakingAssessment = z.infer<typeof speakingAssessmentSchema>;

export const recordingMetadataSchema = z.object({
  id: recordingIdSchema, lessonId: z.number().int().min(1).max(50),
  context: z.enum(['speak', 'conversation']), itemId: identifier,
  createdAt: date, expiresAt: date, durationMs: z.number().min(250).max(30000),
  transcript: z.string().trim().max(2000).optional(), confirmedText: z.string().trim().max(2000).optional(),
  audioAvailable: z.boolean(), audioStatus: z.enum(['available', 'expired', 'deleted', 'missing']),
}).strict();
export const recordingSchema = recordingMetadataSchema.extend({ assessment: speakingAssessmentSchema.optional() }).strict();
export type RecordingMetadata = z.infer<typeof recordingMetadataSchema>;
export type Recording = z.infer<typeof recordingSchema>;
export const recordingPatchSchema = z.object({ transcript: z.string().trim().max(2000).optional(), confirmedText: z.string().trim().max(2000).optional() }).strict().refine(value => value.transcript !== undefined || value.confirmedText !== undefined);
export const speakingAssessmentInputSchema = z.object({ lessonId: z.number().int().min(1).max(50), itemId: identifier, text: z.string().trim().min(1).max(2000), recordingId: recordingIdSchema.optional(), clientAssessmentId: recordingIdSchema }).strict();
export const RECORDING_RETENTION_DAYS = 90;
