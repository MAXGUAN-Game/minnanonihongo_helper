import { z } from 'zod';

export const vocabularyDetailSchema = z.object({
  romaji: z.string().trim().min(1).max(200),
  attributes: z.array(z.enum(['自动词', '他动词', '自他两用', 'い形容词', 'な形容词'])).max(3),
  explanation: z.string().trim().min(8).max(700),
  example: z.object({ jp: z.string().trim().min(2).max(400), kana: z.string().trim().min(2).max(500),
    romaji: z.string().trim().min(2).max(1000), zh: z.string().trim().min(2).max(400) }).strict(),
}).strict();
export type VocabularyDetail = z.infer<typeof vocabularyDetailSchema>;
export const vocabularyGrammarSchema = z.object({
  structure: z.string().trim().min(1).max(1500),
  points: z.array(z.object({ expression: z.string().min(1).max(300), explanation: z.string().min(1).max(1000) }).strict()).min(1).max(8),
}).strict();
export type VocabularyGrammar = z.infer<typeof vocabularyGrammarSchema>;
