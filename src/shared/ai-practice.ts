import { z } from 'zod';
import { audioAssessmentResultSchema } from './audio-assessment';

const text = z.string().trim().min(1).max(1000);
const example = z.object({ jp: text, kana: text, zh: text }).strict();
export const practiceKindSchema = z.enum(['dictation', 'dialogue', 'speaking', 'vocabulary']);
export type PracticeKind = z.infer<typeof practiceKindSchema>;
export const practiceContentSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('vocabulary'), wordId: text, word: text, reading: text, meaning: text, partOfSpeech: text.optional() }).strict(),
  z.object({ kind: z.literal('dictation'), sentence: example }).strict(),
  z.object({ kind: z.literal('dialogue'), lines: z.array(example).min(4).max(6), questionZh: text,
    options: z.array(text).length(4), answerIndex: z.number().int().min(0).max(3), explanationZh: text }).strict()
    .refine(value => new Set(value.options).size === 4, '选项不能重复'),
  z.object({ kind: z.literal('speaking'), goalZh: text, reference: example }).strict(),
]);
export type PracticeContent = z.infer<typeof practiceContentSchema>;
export const practiceQuestionSchema = z.object({
  id: z.uuid(), lessonId: z.number().int().min(1).max(50), grammarSourceLessonId: z.number().int().min(1).max(50),
  grammarId: text, grammarTitle: text, content: practiceContentSchema,
  fingerprints: z.array(z.string().regex(/^[a-f0-9]{64}$/)).max(3),
  model: text, createdAt: z.iso.datetime({ offset: true }),
}).strict();
export type PracticeQuestion = z.infer<typeof practiceQuestionSchema>;
export const practiceScoreResultSchema = audioAssessmentResultSchema.extend({
  meaningScore: z.number().int().min(0).max(40), grammarScore: z.number().int().min(0).max(30),
  pronunciationScore: z.number().int().min(0).max(30).nullable(), targetGrammarUsed: z.boolean(),
}).strict().refine(value => value.pronunciation.status === 'uncertain' ? value.pronunciationScore === null : value.pronunciationScore !== null)
  .refine(value => value.targetGrammarUsed || value.grammarScore <= 15, '未使用目标语法时语法分最多15分');
export type PracticeScoreResult = z.infer<typeof practiceScoreResultSchema>;
export const practiceTextScoreSchema = audioAssessmentResultSchema.omit({ text: true, pronunciation: true }).extend({
  meaningScore: z.number().int().min(0).max(40), grammarScore: z.number().int().min(0).max(30), targetGrammarUsed: z.boolean(),
}).strict().refine(value => value.targetGrammarUsed || value.grammarScore <= 15, '未使用目标语法时语法分最多15分');
const attemptBase = { id: z.uuid(), questionId: z.uuid(), lessonId: z.number().int().min(1).max(50),
  createdAt: z.iso.datetime({ offset: true }), usedHint: z.boolean(), latencyMs: z.number().int().nonnegative(), inputMode: z.enum(['text', 'audio']).optional(), audioHash: z.string().regex(/^[a-f0-9]{64}$/).optional() };
export const practiceAttemptSchema = z.discriminatedUnion('kind', [
  z.object({ ...attemptBase, kind: z.enum(['dictation', 'dialogue', 'vocabulary']), reference: example.optional(), answer: z.string().max(2000), correct: z.boolean(), feedbackZh: text }).strict(),
  z.object({ ...attemptBase, kind: z.literal('speaking'), answer: z.string().trim().min(1).max(2000).optional(), recordingId: z.uuid().optional(), audioHash: z.string().regex(/^[a-f0-9]{64}$/).optional(), result: practiceScoreResultSchema,
    totalScore: z.number().int().min(0).max(100).nullable() }).strict().refine(value => value.totalScore === (value.result.pronunciationScore === null ? null : value.result.meaningScore + value.result.grammarScore + value.result.pronunciationScore))
    .refine(value => value.inputMode === 'text' ? !!value.answer && value.result.text === value.answer && value.result.pronunciationScore === null && !value.audioHash && !value.recordingId : value.answer === undefined),
]);
export type PracticeAttempt = z.infer<typeof practiceAttemptSchema>;
export const practicePositionSchema = z.object({ lessonId: z.number().int().min(1).max(50), kind: practiceKindSchema, questionId: z.uuid() }).strict();
export type PracticePosition = z.infer<typeof practicePositionSchema>;
export type PracticeCurrent = { question: PracticeQuestion | null; attempt: PracticeAttempt | null; completed?: boolean };
