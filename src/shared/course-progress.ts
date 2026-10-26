export type LessonProgress = { lessonId: number; score: number };
export type CourseCardTier = 'locked' | 'bronze' | 'silver' | 'gold' | 'diamond';

export function courseCardTier(score: number): CourseCardTier {
  if (score <= 0) return 'locked';
  if (score < 30) return 'bronze';
  if (score < 70) return 'silver';
  if (score < 100) return 'gold';
  return 'diamond';
}
