import { rankTiers } from './practice-rank';
export type LessonProgress = { lessonId: number; score: number; count?: number };
export type CourseCardTier = typeof rankTiers[number]['id'];
export function courseProgressScore(listen: number, speak: number) {
  const bounded = (value: number) => Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : 0;
  return Math.round((bounded(listen) + bounded(speak)) / 2 * 10) / 10;
}

// Course ranks use capped percentage coverage, never unlimited practice counts.
export function courseRank(value: number) {
  const score = Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : 0;
  const index = Math.min(5, Math.floor(score / 20));
  const tier = rankTiers[index];
  const division = score === 100 ? null : 5 - Math.min(4, Math.floor((score - index * 20) / 4));
  return { ...tier, division, progress: score };
}
export function courseCardTier(score: number): CourseCardTier { return courseRank(score).id; }
