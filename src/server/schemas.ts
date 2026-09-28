import { z } from 'zod';
import { GRAMMAR_CHAT_MAX_TURNS } from '../shared/grammar-chat';

export const lessonIdSchema = z.number().int().min(1).max(50);
const id = z.string().trim().min(1).max(160);
const short = z.string().trim().min(1).max(1000);
const timestamp = z.iso.datetime({ offset: true });
export const exampleSchema = z.object({ jp: short, kana: z.string().max(1500), zh: short }).strict();
export const correctionSchema = z.object({ goal: short, original: z.string().max(2000), corrected: exampleSchema, explanation: short, grammarId: id.optional() }).strict();
export const settingsSchema = z.object({ currentLessonId: lessonIdSchema, dailyMinutes: z.union([z.literal(15), z.literal(60)]), largeText: z.boolean(), furigana: z.boolean(), autoplay: z.boolean(), model: z.string().trim().min(1).max(100).regex(/^[a-zA-Z0-9._:-]+$/), hasApiKey: z.boolean(), setupComplete: z.boolean() }).strict();
export const settingsPatchSchema = settingsSchema.omit({ hasApiKey: true }).partial().extend({ apiKey: z.string().trim().max(512).optional() }).strict();
export const progressSchema = z.object({ lessonId: lessonIdSchema, stage: z.enum(['understand', 'listen', 'speak', 'conversation']), cursor: z.number().int().min(0).max(10000), status: z.enum(['seen', 'assisted', 'independent']), itemId: id.optional(), updatedAt: timestamp }).strict();
export const attemptInputSchema = z.object({ lessonId: lessonIdSchema, itemId: id, result: z.enum(['again', 'hint', 'good']), answer: z.string().max(2000).optional(), usedHint: z.boolean().optional() }).strict();
export const attemptSchema = attemptInputSchema.extend({ id, createdAt: timestamp }).strict();
export type Attempt = z.infer<typeof attemptSchema>;
export const reviewSchema = z.object({ id, lessonId: lessonIdSchema, goal: short, answer: exampleSchema, grammarId: id.optional(), sourceId: id.optional(), dueAt: timestamp, intervalIndex: z.number().int().min(0).max(4), createdAt: timestamp }).strict();
export const reviewInputSchema = reviewSchema.omit({ id: true, dueAt: true, intervalIndex: true, createdAt: true });
export const turnSchema = z.object({ id, role: z.enum(['assistant', 'user']), text: z.string().trim().min(1).max(3000), translation: z.string().max(3000).optional(), hint: z.string().max(1500).optional(), source: z.enum(['lesson', 'deepseek', 'user']), createdAt: timestamp }).strict();
export const sessionSchema = z.object({ id, lessonId: lessonIdSchema, scenarioId: id, mode: z.enum(['scenario', 'grammar']).optional(), grammarId: id.optional(), status: z.enum(['active', 'complete']), turnCount: z.number().int().min(0).max(GRAMMAR_CHAT_MAX_TURNS), turns: z.array(turnSchema).min(1).max(1 + GRAMMAR_CHAT_MAX_TURNS * 2), feedback: z.array(correctionSchema).max(2), completedGoals: z.array(short).max(20), updatedAt: timestamp }).strict().superRefine((session, ctx) => {
  if (session.mode === 'grammar') {
    if (session.completedGoals.length) ctx.addIssue({ code: 'custom', path: ['completedGoals'], message: '自由聊不记录场景完成目标。' });
  } else {
    if (session.grammarId !== undefined) ctx.addIssue({ code: 'custom', path: ['grammarId'], message: '场景练习不能指定自由聊语法点。' });
    if (session.turnCount > 6 || session.turns.length > 13) ctx.addIssue({ code: 'custom', path: ['turnCount'], message: '场景练习最多六轮。' });
  }
});
export const sessionInputSchema = z.object({ lessonId: lessonIdSchema, scenarioId: id.optional(), mode: z.enum(['scenario', 'grammar']).optional(), grammarId: id.optional() }).strict().superRefine((input, ctx) => {
  if (input.mode !== 'grammar') {
    if (!input.scenarioId) ctx.addIssue({ code: 'custom', path: ['scenarioId'], message: '请选择一个场景。' });
    if (input.grammarId !== undefined) ctx.addIssue({ code: 'custom', path: ['grammarId'], message: '场景练习不能指定自由聊语法点。' });
  }
});
export const userTurnSchema = z.object({ text: z.string().trim().min(1).max(2000), usedHint: z.boolean().default(false), clientTurnId: id }).strict();
export const aiResponseSchema = z.object({ replyJa: z.string().trim().min(1).max(800), replyZh: z.string().trim().min(1).max(1000), hintZh: z.string().max(600), completedGoals: z.array(short).max(20), corrections: z.array(correctionSchema).max(2), endSession: z.boolean() }).strict();
export const backupSchema = z.object({ version: z.literal(1), exportedAt: timestamp, settings: settingsSchema.omit({ hasApiKey: true }), progress: z.array(progressSchema).max(10000), attempts: z.array(attemptSchema).max(100000), reviews: z.array(reviewSchema).max(100000), sessions: z.array(sessionSchema).max(100000) }).strict();
export type Backup = z.infer<typeof backupSchema>;

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}
