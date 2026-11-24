export function japaneseVoice(voices: SpeechSynthesisVoice[], name: 'Haruka' | 'Ichiro') {
  return voices.find(voice => voice.localService && /^ja(?:-|_)/i.test(voice.lang) && new RegExp(`\\b${name}\\b`, 'i').test(voice.name));
}
export async function systemVoices(): Promise<SpeechSynthesisVoice[]> {
  if (!('speechSynthesis' in window)) return [];
  const initial = window.speechSynthesis.getVoices();
  if (initial.length) return initial;
  return new Promise(resolve => {
    const finish = () => {
      clearTimeout(timer);
      window.speechSynthesis.removeEventListener('voiceschanged', changed);
      resolve(window.speechSynthesis.getVoices());
    };
    const changed = () => { if (window.speechSynthesis.getVoices().length) finish(); };
    const timer = setTimeout(finish, 1500);
    window.speechSynthesis.addEventListener('voiceschanged', changed);
    changed();
  });
}

// Feed the native Japanese engine the same written form as the approved
// Haruka sample. Keep time counters together; do not flatten the sentence to kana.
export function nativeJapaneseText(text: string) {
  const digits: Record<string, number> = { 零: 0, 〇: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  const number = (value: string): number => {
    value = value.normalize('NFKC');
    if (/^\d{1,2}$/.test(value)) return Number(value);
    if (/^[零〇一二三四五六七八九]$/.test(value)) return digits[value];
    const ten = /^([一二三四五六七八九]?)十([一二三四五六七八九]?)$/.exec(value);
    return ten ? (ten[1] ? digits[ten[1]] : 1) * 10 + (ten[2] ? digits[ten[2]] : 0) : NaN;
  };
  return text.replace(/([零〇一二三四五六七八九十\d０-９]+)時(?!間)(?:([零〇一二三四五六七八九十\d０-９]+)分)?/g, (whole, hour: string, minute?: string) => {
    const h = number(hour), m = minute === undefined ? undefined : number(minute);
    if (!Number.isInteger(h) || h > 24 || (m !== undefined && (!Number.isInteger(m) || m > 59))) return whole;
    return `${h}時${m === undefined ? '' : `${m}分`}`;
  });
}
