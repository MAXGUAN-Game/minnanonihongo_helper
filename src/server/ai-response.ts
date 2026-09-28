import { aiResponseSchema } from './schemas';

export class PrivateReplyError extends Error {}
const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

function correction(value: unknown): unknown {
  if (!isObject(value)) return value;
  const example = value.corrected;
  const grammarId = value.grammarId;
  return {
    goal: value.goal, original: value.original, explanation: value.explanation,
    corrected: isObject(example) ? { jp: example.jp, kana: example.kana, zh: example.zh } : example,
    ...(grammarId == null || (typeof grammarId === 'string' && !grammarId.trim()) ? {} : { grammarId }),
  };
}

// Provider formatting is more variable than our saved data. Normalize only
// harmless packaging and optional metadata, then apply the strict storage
// schema. Never synthesize missing speech, translations or correction text.
export function parseProviderReply(content: string, apiKey: string) {
  if (apiKey && content.includes(apiKey)) throw new PrivateReplyError('private content');
  const trimmed = content.trim();
  const fence = /^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i.exec(trimmed);
  const value: unknown = JSON.parse(fence ? fence[1]! : trimmed);
  if (apiKey && JSON.stringify(value).includes(apiKey)) throw new PrivateReplyError('private content');
  if (!isObject(value)) throw new Error('response must be an object');
  return aiResponseSchema.parse({
    replyJa: value.replyJa,
    replyZh: value.replyZh,
    hintZh: value.hintZh ?? '',
    completedGoals: value.completedGoals ?? [],
    corrections: Array.isArray(value.corrections) ? value.corrections.map(correction) : value.corrections ?? [],
    endSession: value.endSession ?? false,
  });
}
