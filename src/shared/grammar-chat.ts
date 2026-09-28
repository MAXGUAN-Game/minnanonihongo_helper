import type { Lesson, Scenario, Session } from './types';

export const GRAMMAR_CHAT_MAX_TURNS = 200;
export const isGrammarChat = (session: Pick<Session, 'mode'> | null | undefined) => session?.mode === 'grammar';

// A separate learning mode, derived from the versioned lesson content. It does
// not add generated exercises to the textbook's two authored scenarios.
export function getGrammarChatScenario(lesson: Lesson, grammarId?: string): Scenario | undefined {
  const focus = grammarId ? lesson.grammar.find(grammar => grammar.id === grammarId) : undefined;
  if (grammarId && !focus) return undefined;
  return {
    id: `l${lesson.id}-grammar-chat`,
    title: '语法自由聊',
    goal: focus ? `一起练：${focus.title}` : `聊聊第 ${lesson.id} 课的语法`,
    setting: 'AI 是耐心的日语老师，用户是初学者。用户可以用中文问语法、请你举例，或用日语自由交流。围绕所选语法逐句练习，不预设情境或交换师生角色。',
    opening: {
      jp: '一緒に練習しましょう。',
      kana: 'いっしょにれんしゅうしましょう。',
      zh: focus ? `这次聊「${focus.title}」。可以用中文问我，也可以试着说一句日语。` : '可以用中文问本课语法，也可以请我举例，或试着说一句日语。',
    },
    targetGrammarIds: focus ? [focus.id] : lesson.grammar.map(grammar => grammar.id),
    successCriteria: [],
  };
}
