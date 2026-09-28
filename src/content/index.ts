import { lessons1 } from './lessons-01-25';
import { lessons2 } from './lessons-26-50';
export const lessons = [...lessons1, ...lessons2];
export const course = {
  schemaVersion: 1,
  contentVersion: '2e-1.0.0',
  textbookEdition: 2,
  title: '大家的日语 · 初级Ⅰ、Ⅱ · 原创辅助练习',
  lessons,
} as const;
export const getLesson = (id: number) => lessons.find(lesson => lesson.id === id);
