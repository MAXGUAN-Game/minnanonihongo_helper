import { lessons } from '../content';
import { vocabularyForLesson } from '../content/vocabulary';
import type { PracticeAttempt, PracticeQuestion } from '../shared/ai-practice';
import type { LessonProgress } from '../shared/course-progress';
import { courseProgressScore } from '../shared/course-progress';
import type { Progress } from '../shared/types';
import type { VocabularyMastery } from '../shared/vocabulary';
import { moduleProgress } from './module-progress';
import type { Attempt } from './schemas';
import type { Store } from './store';
import type { PracticeCredit } from '../shared/practice-rank';

function byLesson<T extends { lessonId: number }>(items: T[]): Map<number, T[]> {
  const grouped = new Map<number, T[]>();
  for (const item of items) {
    const group = grouped.get(item.lessonId);
    if (group) group.push(item);
    else grouped.set(item.lessonId, [item]);
  }
  return grouped;
}

export function courseProgress(store: Store): LessonProgress[] {
  const questions = byLesson(store.all<PracticeQuestion>('ai_questions'));
  const answers = byLesson(store.all<PracticeAttempt>('ai_attempts'));
  const attempts = byLesson(store.all<Attempt>('attempts'));
  const marks = byLesson(store.all<VocabularyMastery>('vocabulary_mastery'));
  const progress = byLesson(store.all<Progress>('progress'));
  const credits = store.all<PracticeCredit>('practice_credits');
  return lessons.map(lesson => {
    const modules = moduleProgress(lesson.id, vocabularyForLesson(lesson.id).words.map(word => word.id), lesson.grammar.map(grammar => grammar.id),
      questions.get(lesson.id) ?? [], answers.get(lesson.id) ?? [], attempts.get(lesson.id) ?? [], marks.get(lesson.id) ?? [], progress.get(lesson.id) ?? [], credits);
    // Preserve small gains and avoid rounding an unfinished unit up to 100%.
    return { lessonId: lesson.id, score: courseProgressScore(modules.listen.score, modules.speak.score), count: (modules.listen.count + modules.speak.count) / 2 };
  });
}
