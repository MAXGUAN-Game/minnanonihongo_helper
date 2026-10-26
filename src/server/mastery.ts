import type { PracticeAttempt, PracticeQuestion } from '../shared/ai-practice';

/** First assessed answer only; reviewing an answer cannot overwrite its evidence. */
export function lessonMastery(lessonId: number, questions: PracticeQuestion[], attempts: PracticeAttempt[]) {
  const eligible = new Map(questions.filter(q => q.grammarSourceLessonId === lessonId).map(q => [q.id, q]));
  const first = new Map<string, PracticeAttempt>();
  // Serialized submissions can still share one millisecond. The independent
  // answer was committed before its assisted retries; UUID order is unrelated.
  for (const attempt of [...attempts].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || Number(a.usedHint) - Number(b.usedHint) || a.id.localeCompare(b.id))) {
    if (eligible.has(attempt.questionId) && !first.has(attempt.questionId)) first.set(attempt.questionId, attempt);
  }
  const independent = [...first.values()].filter(a => !a.usedHint).sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
  function part(kind: PracticeAttempt['kind']) {
    const sample = independent.filter(a => a.kind === kind).slice(0, 100);
    const values = sample.map(a => a.kind === 'speaking' ? (a.result.meaningScore + a.result.grammarScore) / 70 : Number(a.correct));
    const passed = sample.filter(a => a.kind === 'speaking' ? a.result.targetGrammarUsed && a.result.meaningScore + a.result.grammarScore >= 56 : a.correct).length;
    return { count: sample.length, score: sample.length ? Math.round(100 * (1 + values.reduce((sum, x) => sum + x, 0)) / (2 + sample.length)) : null,
      provisional: sample.length < 10, accuracy: sample.length ? passed / sample.length : null };
  }
  const dictation = part('dictation'), dialogue = part('dialogue'), speaking = part('speaking');
  const listening = !dictation.provisional && !dialogue.provisional ? Math.round((dictation.score! + dialogue.score!) / 2) : null;
  const pronunciation = independent.filter(a => a.kind === 'speaking').slice(0, 100)
    .flatMap(a => a.kind === 'speaking' && a.result.pronunciationScore !== null ? [a.result.pronunciationScore] : []);
  return { algorithmVersion: 1, lessonId, dictation, dialogue, speaking, listening,
    overall: listening !== null && !speaking.provisional ? Math.round((listening + speaking.score!) / 2) : null,
    pronunciation: { count: pronunciation.length, score: pronunciation.length ? Math.round(100 * pronunciation.reduce((sum, x) => sum + x, 0) / (30 * pronunciation.length)) : null } };
}
