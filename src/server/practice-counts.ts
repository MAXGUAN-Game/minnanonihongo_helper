import type { PracticeQuestion, PracticeAttempt } from '../shared/ai-practice';
import type { PracticeCredit } from '../shared/practice-rank';
export function passedQuestionIds(questions: PracticeQuestion[], attempts: PracticeAttempt[], credits: PracticeCredit[] = []) {
  const eligible = new Map(questions.map(question => [question.id, question]));
  const passed = new Set<string>();
  for (const attempt of attempts) {
    const question = eligible.get(attempt.questionId);
    if (!question || question.lessonId !== attempt.lessonId || question.topic !== attempt.topic || question.review !== attempt.review || question.content.kind !== attempt.kind) continue;
    if (attempt.kind !== 'speaking' ? attempt.correct : attempt.inputMode === 'text' ? (attempt.result.meaningScore + attempt.result.grammarScore) * 100 / 70 > 90 : attempt.totalScore !== null && attempt.totalScore > 90) passed.add(question.id);
  }
  for (const credit of credits) if (credit.type === 'skip' && eligible.has(credit.questionId)) passed.add(credit.questionId);
  return passed;
}
