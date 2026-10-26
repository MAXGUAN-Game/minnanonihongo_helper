import { useSyncExternalStore } from 'react';

export type Preferences = { locale: 'zh-CN' | 'ja-JP'; immersive: boolean; collapsed: boolean; dictationMode: 'text' | 'audio'; vocabularyMode: 'text' | 'audio'; speakingMode: 'text' | 'audio'; autoAdvanceOnEnter: boolean };
const defaults: Preferences = { locale: 'zh-CN', immersive: false, collapsed: false, dictationMode: 'text', vocabularyMode: 'text', speakingMode: 'audio', autoAdvanceOnEnter: false };
let current = defaults;
try {
  const saved = JSON.parse(localStorage.getItem('nihongo-ui-v130') || '{}');
  current = { locale: saved.locale === 'ja-JP' ? 'ja-JP' : 'zh-CN', immersive: saved.immersive === true, collapsed: saved.collapsed === true, dictationMode: saved.dictationMode === 'audio' ? 'audio' : 'text', vocabularyMode: saved.vocabularyMode === 'audio' ? 'audio' : 'text', speakingMode: saved.speakingMode === 'text' ? 'text' : 'audio', autoAdvanceOnEnter: saved.autoAdvanceOnEnter === true };
} catch { /* Storage can be unavailable in private browsing. */ }
const listeners = new Set<() => void>();
export function getPreferences() { return current; }
export function setPreferences(patch: Partial<Preferences>) {
  current = { ...current, ...patch };
  try { localStorage.setItem('nihongo-ui-v130', JSON.stringify(current)); } catch { /* Session preferences still work. */ }
  listeners.forEach(listener => listener());
}
export function usePreferences() {
  return useSyncExternalStore(listener => { listeners.add(listener); return () => { listeners.delete(listener); }; }, () => current, () => defaults);
}
export function useTranslation() {
  const { locale } = usePreferences();
  return (zh: string, ja: string) => locale === 'ja-JP' ? ja : zh;
}
