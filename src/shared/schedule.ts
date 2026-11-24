import { z } from 'zod';

const categories = ['japanese', 'jp', 'japanese_italki', 'fitness', 'game', 'graphics', 'ta', 'english', 'english_human', 'japanese_drama', 'american_drama', 'routine'] as const;
const event = z.object({
  id: z.string().min(1).max(200), day: z.number().int().min(0).max(6),
  start: z.number().int().min(0).max(1439), end: z.number().int().min(1).max(1440),
  category: z.enum(categories), title: z.string().min(1).max(80), notes: z.string().max(1000),
}).passthrough().refine(item => item.end > item.start, 'Invalid schedule duration');
const events = z.array(event).max(2000).refine(items => new Set(items.map(item => item.id)).size === items.length, 'Duplicate schedule IDs');
export const scheduleStateSchema = z.object({
  version: z.literal(2), activeWeek: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), events,
  view: z.object({ filter: z.enum(['all', ...categories]), showRoutines: z.boolean(), foldRoutines: z.boolean().optional() }).passthrough(),
  legacyWeeks: z.record(z.string(), z.object({ events }).passthrough()).optional(),
}).passthrough();
export type ScheduleState = z.infer<typeof scheduleStateSchema>;
export type ScheduleDocument = { revision: string | null; state: ScheduleState | null };
