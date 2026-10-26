import type { PracticeAttempt, PracticeQuestion } from '../shared/ai-practice';
import type { VocabularyMastery, VocabularyWordProgress } from '../shared/vocabulary';

export function vocabularyMastery(wordIds: string[], questions: PracticeQuestion[], attempts: PracticeAttempt[], marks: VocabularyMastery[] = []): VocabularyWordProgress[] {
  const overrides = new Map(marks.map(mark => [mark.wordId, mark]));
  const wordsByQuestion = new Map(questions.flatMap(question => question.content.kind === 'vocabulary' ? [[question.id, question.content.wordId] as const] : []));
  const correctQuestions = new Map<string, Set<string>>();
  for (const attempt of attempts) {
    if (attempt.kind !== 'vocabulary' || !attempt.correct) continue;
    const wordId = wordsByQuestion.get(attempt.questionId);
    if (!wordId) continue;
    const mark = overrides.get(wordId);
    // Unchecking starts a new learning cycle without deleting answer history.
    if (mark && !mark.mastered && attempt.createdAt <= mark.updatedAt) continue;
    const correct = correctQuestions.get(wordId) ?? new Set<string>();
    correct.add(attempt.questionId);
    correctQuestions.set(wordId, correct);
  }
  return wordIds.map(wordId => {
    const correctCount = correctQuestions.get(wordId)?.size ?? 0;
    return { wordId, correctCount, mastered: overrides.get(wordId)?.mastered === true || correctCount >= 2 };
  });
}
