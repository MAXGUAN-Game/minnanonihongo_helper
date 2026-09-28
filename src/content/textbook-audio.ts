import metadata from './textbook-audio.json';

export type TextbookAudioTrack = {
  id: string;
  order: number;
  filename: string;
  url: string;
};

export type TextbookAudioLesson = {
  lessonId: number;
  volume: 1 | 2;
  sourcePage: string;
  tracks: readonly TextbookAudioTrack[];
};

// These are publisher playlist entries, not copied audio or textbook text.
// Track categories are deliberately absent: the publisher supplies filenames
// and order but does not label each file as conversation or an exercise.
export const textbookAudioManifest = metadata as {
  schemaVersion: 1;
  textbookEdition: 2;
  publisher: string;
  retrievedAt: string;
  lessons: TextbookAudioLesson[];
};
export const textbookAudioLessons: readonly TextbookAudioLesson[] = textbookAudioManifest.lessons;
const lessonsById = new Map(textbookAudioLessons.map(lesson => [lesson.lessonId, lesson]));
const officialUrls = new Set(textbookAudioLessons.flatMap(lesson => lesson.tracks.map(track => track.url)));

export function getTextbookAudioLesson(lessonId: number): TextbookAudioLesson | undefined {
  return lessonsById.get(lessonId);
}

// Exact manifest membership also excludes arbitrary files on the same host,
// credential-bearing URLs, paid resources, and lookalike external domains.
export function isOfficialTextbookAudioUrl(value: unknown): value is string {
  return typeof value === 'string' && officialUrls.has(value);
}
