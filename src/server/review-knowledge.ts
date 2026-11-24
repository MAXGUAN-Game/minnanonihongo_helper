import { getLesson, lessons } from '../content';
import { vocabularyForLesson } from '../content/vocabulary';
import type { PracticeAttempt, PracticeQuestion } from '../shared/ai-practice';
import type { PracticeCredit } from '../shared/practice-rank';
import type { SpeakingAssessment } from '../shared/recordings';
import type { Example, Grammar, Lesson, Progress, Session } from '../shared/types';
import type { VocabularyMastery } from '../shared/vocabulary';
import type { Attempt } from './schemas';
import type { Store } from './store';

/** Read-only evidence index. Merely visiting a lesson or generating a question is not learning evidence. */
export function reviewKnowledge(store: Store) {
  const known = new Map<string, { lesson: Lesson; grammar: Grammar }>();
  const vocabularyWordIds = new Set<string>();
  const observedExamples = new Map<string, Example>();
  const addExample = (example?: Example) => {
    if (example?.jp && example.kana && example.zh) observedExamples.set(example.jp.normalize('NFKC'), example);
  };
  const addGrammar = (lessonId: number, grammarId?: string) => {
    const lesson = getLesson(lessonId), grammar = lesson?.grammar.find(item => item.id === grammarId);
    if (lesson && grammar) known.set(grammar.id, { lesson, grammar });
  };
  const addItem = (lessonId: number, itemId?: string) => {
    const lesson = getLesson(lessonId);
    if (!lesson || !itemId) return;
    addGrammar(lessonId, itemId);
    const listening = lesson.listening.find(item => item.id === itemId);
    for (const id of listening?.grammarIds ?? []) addGrammar(lessonId, id);
    addGrammar(lessonId, lesson.speaking.find(item => item.id === itemId)?.grammarId);
    const scenario = lesson.scenarios.find(item => item.id === itemId);
    for (const id of scenario?.targetGrammarIds ?? []) addGrammar(lessonId, id);
    if (vocabularyForLesson(lessonId).words.some(word => word.id === itemId)) vocabularyWordIds.add(itemId);
  };
  for (const attempt of store.all<Attempt>('attempts')) addItem(attempt.lessonId, attempt.itemId);
  for (const assessment of store.all<SpeakingAssessment>('assessments')) addItem(assessment.lessonId, assessment.itemId);
  const questions = new Map(store.all<PracticeQuestion>('ai_questions').map(question => [question.id, question]));
  const addQuestion = (question?: PracticeQuestion) => {
    if (!question || question.lessonId === 0 || question.topic || ('review' in question && question.review)) return;
    // Vocabulary questions reuse a placeholder grammar ID: it is not evidence of studying that grammar.
    if (question.content.kind === 'vocabulary') {
      const wordId = question.content.wordId;
      if (vocabularyForLesson(question.lessonId).words.some(word => word.id === wordId)) vocabularyWordIds.add(wordId);
    } else {
      addGrammar(question.grammarSourceLessonId, question.grammarId);
      if (question.content.kind === 'dictation') addExample(question.content.sentence);
      else if (question.content.kind === 'speaking') addExample(question.content.reference);
      else for (const line of question.content.lines) addExample(line);
    }
  };
  for (const attempt of store.all<PracticeAttempt>('ai_attempts')) {
    const question = questions.get(attempt.questionId);
    if (question && question.lessonId === attempt.lessonId && question.content.kind === attempt.kind && question.topic === attempt.topic) addQuestion(question);
  }
  for (const credit of store.all<PracticeCredit>('practice_credits')) if (credit.type === 'skip') addQuestion(questions.get(credit.questionId));
  for (const progress of store.all<Progress>('progress')) {
    const lesson = getLesson(progress.lessonId);
    if (!lesson) continue;
    if (progress.stage === 'understand' && progress.manualProgress?.score === 100) {
      for (const grammar of lesson.grammar) addGrammar(lesson.id, grammar.id);
    }
    const meaningful = progress.status === 'assisted' || progress.status === 'independent';
    if (!meaningful) continue;
    if (progress.itemId) addItem(lesson.id, progress.itemId);
    else if (progress.stage === 'understand') addGrammar(lesson.id, lesson.grammar[progress.cursor]?.id);
    else if (progress.stage === 'listen') addItem(lesson.id, lesson.listening[progress.cursor]?.id);
    else if (progress.stage === 'speak') addItem(lesson.id, lesson.speaking[progress.cursor]?.id);
  }
  for (const session of store.all<Session>('sessions')) {
    if (!session.turnCount || !session.turns.some(turn => turn.role === 'user' && turn.text.trim())) continue;
    if (session.mode === 'grammar') addGrammar(session.lessonId, session.grammarId);
    else addItem(session.lessonId, session.scenarioId);
  }
  for (const mastery of store.all<VocabularyMastery>('vocabulary_mastery')) if (mastery.mastered) {
    if (getLesson(mastery.lessonId) && vocabularyForLesson(mastery.lessonId).words.some(word => word.id === mastery.wordId)) vocabularyWordIds.add(mastery.wordId);
  }
  // Stable order makes sampling and evidence tests reproducible without changing persisted IDs.
  const grammar = lessons.flatMap(lesson => lesson.grammar.flatMap(item => known.has(item.id) ? [known.get(item.id)!] : []));
  const knownExamples = new Map<string, Example>();
  for (const { grammar: item } of grammar) for (const example of item.examples) knownExamples.set(example.jp.normalize('NFKC'), example);
  // Historical answers can be numerous; preserve a stable, bounded recent lexical context.
  for (const example of [...observedExamples.values()].slice(-200)) knownExamples.set(example.jp.normalize('NFKC'), example);
  return { lessonIds: [...new Set(grammar.map(item => item.lesson.id))], grammar, vocabularyWordIds: [...vocabularyWordIds].sort(), knownExamples: [...knownExamples.values()] };
}
