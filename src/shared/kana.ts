const basic = 'あいうえおかきくけこさしすせそたちつてとなにぬねのはひふへほまみむめもやゆよらりるれろわをん';
const voiced = 'がぎぐげござじずぜぞだぢづでどばびぶべぼぱぴぷぺぽ';
const contracted = [...'きしちにひみりぎじびぴ'].flatMap(prefix => [...'ゃゅょ'].map(suffix => prefix + suffix));
export const kanaItems = [...basic, ...voiced, ...contracted].map(hiragana => ({ hiragana,
  katakana: [...hiragana].map(char => String.fromCharCode(char.charCodeAt(0) + 0x60)).join('') }));
export function shuffledKana(previous?: string, random = Math.random) {
  const items = [...kanaItems];
  for (let i = items.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [items[i], items[j]] = [items[j], items[i]]; }
  if (items[0].hiragana === previous) [items[0], items[1]] = [items[1], items[0]];
  return items;
}
