import type { PracticeAttempt, PracticeQuestion } from '../shared/ai-practice';
import type { Attempt } from './schemas';
import type { VocabularyMastery } from '../shared/vocabulary';
import type { Progress, Stage } from '../shared/types';
import { vocabularyMastery } from './vocabulary-mastery';

type Coverage = { score: number; count: number; total: number; provisional: boolean; manual?: boolean };

export function moduleProgress(lessonId: number, wordIds: string[], grammarIds: string[], questions: PracticeQuestion[], attempts: PracticeAttempt[], history: Attempt[], marks: VocabularyMastery[] = [], progress: Progress[] = []) {
  const words = vocabularyMastery(wordIds, questions, attempts, marks).filter(word => word.mastered);
  const grammar = new Set(history.filter(a => grammarIds.includes(a.itemId) && a.result === 'good' && !a.usedHint).map(a => a.itemId));
  const coverage = (stage: Stage, count: number, total: number): Coverage => {
    const manual = progress.find(item => item.lessonId === lessonId && item.stage === stage)?.manualProgress;
    const result: Coverage = { score: total ? Math.min(100, Math.round(100 * count / total)) : 0, count: Math.min(count, total), total, provisional: false };
    if (manual) {
      // Keep actual completion counts intact; only learning since the baseline changes the adjusted percentage.
      result.score = Math.max(0, Math.min(100, Math.round(manual.score + (total ? 100 * (count - manual.baselineCount) / total : 0))));
      result.manual = true;
    }
    return result;
  };
  const eligible = new Map(questions.filter(q => q.lessonId === lessonId).map(q => [q.id, q.content.kind]));
  const listening = new Set<string>(), speaking = new Set<string>();
  for (const attempt of attempts) {
    if (attempt.lessonId !== lessonId || eligible.get(attempt.questionId) !== attempt.kind) continue;
    if ((attempt.kind === 'dictation' || attempt.kind === 'dialogue') && attempt.correct) listening.add(attempt.questionId);
    if (attempt.kind === 'speaking') {
      const score = attempt.inputMode === 'text'
        ? (attempt.result.meaningScore + attempt.result.grammarScore) * 100 / 70
        : attempt.totalScore;
      if (score !== null && score > 90) speaking.add(attempt.questionId);
    }
  }
  return {
    vocabulary: coverage('vocabulary', words.length, wordIds.length),
    understand: coverage('understand', grammar.size, grammarIds.length),
    listen: coverage('listen', listening.size, 100),
    speak: coverage('speak', speaking.size, 100),
  };
}
