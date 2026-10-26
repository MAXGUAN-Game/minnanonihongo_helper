import type { VocabularyDetail } from './vocabulary-details';
import type { Example } from './types';
export type VocabularyEntry = { id: string; lessonId: number; word: string; reading: string; meaning: string; partOfSpeech: string; detail?: VocabularyDetail };
export type VocabularyLesson = { lessonId: number; complete: boolean; words: VocabularyEntry[] };
export type VocabularyMastery = { wordId: string; lessonId: number; mastered: boolean; updatedAt: string };
export type VocabularyWordProgress = { wordId: string; mastered: boolean; correctCount: number };
export type VocabularyLessonProgress = VocabularyLesson & { mastery: VocabularyWordProgress[] };
export type VocabularyQuestion = { id: string; lessonId: number; wordId: string; createdAt: string };
export type VocabularyAttempt = { id: string; questionId: string; lessonId: number; answer: string; correct: boolean; feedbackZh: string; reference: Example; usedHint: boolean; inputMode: 'text' | 'audio'; audioHash?: string; createdAt: string };
