import { z } from 'zod';

const shortText = z.string().trim().min(1).max(1000);
const example = z.object({ jp: shortText, kana: z.string().max(1500), zh: shortText }).strict();
const correction = z.object({
  goal: shortText, original: z.string().trim().min(1).max(2000), corrected: example,
  explanation: shortText, grammarId: z.string().trim().min(1).max(160).optional(),
}).strict();

export const audioAssessmentSettingsSchema = z.object({
  provider: z.literal('qwen'),
  model: z.literal('qwen3.8-omni-flash'),
  workspaceId: z.string().trim().max(100).regex(/^[a-zA-Z0-9-]*$/),
  hasApiKey: z.boolean(),
}).strict();
export type AudioAssessmentSettings = z.infer<typeof audioAssessmentSettingsSchema>;
export const DEFAULT_AUDIO_ASSESSMENT_SETTINGS: AudioAssessmentSettings = {
  provider: 'qwen', model: 'qwen3.8-omni-flash', workspaceId: '', hasApiKey: false,
};
export const audioAssessmentSettingsPatchSchema = audioAssessmentSettingsSchema.omit({ hasApiKey: true }).partial().extend({
  apiKey: z.string().trim().max(512).optional(),
}).strict();
export type AudioAssessmentSettingsPatch = z.infer<typeof audioAssessmentSettingsPatchSchema>;

// Audio feedback is qualitative: these are listening observations, not a calibrated pronunciation exam score.
export const audioAssessmentResultSchema = z.object({
  text: z.string().trim().min(1).max(2000),
  summaryZh: shortText,
  grammarFeedbackZh: shortText,
  corrections: z.array(correction).max(2),
  pronunciation: z.object({
    status: z.enum(['clear', 'needs_practice', 'uncertain']),
    feedbackZh: shortText,
    issues: z.array(z.object({
      word: z.string().trim().min(1).max(100),
      expectedKana: z.string().trim().min(1).max(200),
      issueZh: shortText,
      practiceTipZh: shortText,
    }).strict()).max(2),
  }).strict(),
  reference: example,
}).strict();
export type AudioAssessmentResult = z.infer<typeof audioAssessmentResultSchema>;
export const audioAssessmentSchema = audioAssessmentResultSchema.extend({
  id: z.uuid().toLowerCase(), lessonId: z.number().int().min(1).max(50),
  itemId: z.string().trim().min(1).max(160), recordingId: z.uuid().toLowerCase().optional(),
  createdAt: z.iso.datetime({ offset: true }), source: z.literal('qwen-omni'), kind: z.literal('audio'),
  model: z.literal('qwen3.8-omni-flash'), latencyMs: z.number().int().nonnegative(),
}).strict();
export type AudioAssessment = z.infer<typeof audioAssessmentSchema>;
export const audioAssessmentInputSchema = z.object({
  lessonId: z.number().int().min(1).max(50), itemId: z.string().trim().min(1).max(160),
  recordingId: z.uuid().toLowerCase(), clientAssessmentId: z.uuid().toLowerCase(),
}).strict();
