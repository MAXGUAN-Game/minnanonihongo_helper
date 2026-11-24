import { useSyncExternalStore, type ReactNode } from 'react';
import catalog from '../content/localization.json';
import overrides from '../content/localization-overrides.json';
import templateSources from '../content/localization-templates.json';

export type Locale = 'zh-CN' | 'ja-JP' | 'en-US';
type Entry = { ja: string; en: string };
const translations: Record<string, Entry> = {...catalog,...overrides};
const templates=templateSources.map(source=>({source,pattern:new RegExp('^'+source.split(/⟪\d+⟫/).map(part=>part.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('(.+?)')+'$')}));
const dynamic = new Map<string, string>();
const pending = new Map<string, { text: string; locale: Exclude<Locale, 'zh-CN'> }>();
const failed = new Map<string, { text: string; locale: Exclude<Locale, 'zh-CN'> }>();
const inflight = new Set<string>();
const produced = { 'ja-JP':new Set<string>(), 'en-US':new Set<string>() };
const listeners = new Set<() => void>();
let revision = 0, timer: ReturnType<typeof setTimeout> | undefined, running = false;
const emit = () => { revision++; listeners.forEach(fn => fn()); };
export function useLocalizationRevision() { return useSyncExternalStore(fn => { listeners.add(fn); return () => { listeners.delete(fn); }; }, () => revision, () => 0); }
export function translationFailed() { return failed.size > 0; }
export function retryTranslations() { for (const [key,value] of failed) pending.set(key,value); failed.clear(); void flush(); emit(); }
async function flush() {
  if (running || !pending.size) return;
  running = true;
  const locale = pending.values().next().value!.locale;
  const batch = [...pending].filter(([,v])=>v.locale===locale).slice(0,20);
  batch.forEach(([key])=>{pending.delete(key);inflight.add(key);});
  try {
    const response = await fetch('/api/localization', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ locale, texts:batch.map(([,v])=>v.text) }), signal:AbortSignal.timeout(65000) });
    if (!response.ok) throw Error('Translation unavailable');
    const body = await response.json() as { translations: string[] };
    if (body.translations.length !== batch.length || body.translations.some(s=>typeof s!=='string'||!s.trim())) throw Error('Invalid translations');
    batch.forEach(([key],i)=>dynamic.set(key,body.translations[i]));
  } catch { batch.forEach(([key,value])=>failed.set(key,value)); }
  finally { batch.forEach(([key])=>inflight.delete(key)); running = false; emit(); if(pending.size) void flush(); }
}
export function localizedText(text: string, locale: Locale, japanese?: string): string {
  if (locale === 'zh-CN' || !text.trim()) return text;
  const override=(overrides as Record<string,Entry>)[text];
  if(override){const result=override[locale==='en-US'?'en':'ja'];produced[locale].add(result);return result;}
  if(produced[locale].has(text))return text;
  if (locale === 'ja-JP' && japanese) { produced[locale].add(japanese); return japanese; }
  const entry = translations[text];
  if (entry) { const result=entry[locale === 'ja-JP' ? 'ja' : 'en']; produced[locale].add(result);return result; }
  for(const template of templates){
    const match=template.pattern.exec(text),target=translations[template.source];
    if(match&&target){const result=target[locale==='en-US'?'en':'ja'].replace(/⟪(\d+)⟫/g,(_,index)=>{
      const value=match[Number(index)+1];const known=translations[value];return known?known[locale==='en-US'?'en':'ja']:value;
    });produced[locale].add(result);return result;}
  }
  // Text outside the translation catalog may be a Japanese exercise target.
  // Callers preserve targets explicitly; kana-containing unknown strings are not guessed.
  if (!/[\u3400-\u9fff]/u.test(text)) return text;
  const key=locale+'\0'+text;
  if(dynamic.has(key)){const result=dynamic.get(key)!;produced[locale].add(result);return result;}
  if(!pending.has(key)&&!failed.has(key)&&!inflight.has(key)){ pending.set(key,{text,locale}); if(!timer)timer=setTimeout(()=>{timer=undefined;void flush();},40); }
  return failed.has(key) ? (locale==='en-US'?'Translation unavailable':'翻訳を取得できません') : (locale==='en-US'?'Translating…':'翻訳中…');
}
export function localizeValue(value: ReactNode, locale: Locale): ReactNode {
  if(typeof value==='string')return localizedText(value,locale);
  if(Array.isArray(value))return value.map(item=>localizeValue(item,locale));
  return value;
}
