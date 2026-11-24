import type { PracticeAttempt } from './ai-practice';

/** Visual feedback follows the same >90% threshold as learning progress. */
export function practiceOutcome(attempt: PracticeAttempt | null | undefined): 'retry' | 'pass' | 'perfect' | undefined {
  if (!attempt) return undefined;
  if (attempt.kind !== 'speaking') return attempt.correct ? 'pass' : 'retry';
  const score = attempt.inputMode === 'text'
    ? attempt.result.meaningScore + attempt.result.grammarScore
    : attempt.totalScore;
  if (score === null) return undefined;
  const maximum = attempt.inputMode === 'text' ? 70 : 100;
  return score === maximum ? 'perfect' : score > maximum * .9 ? 'pass' : 'retry';
}
