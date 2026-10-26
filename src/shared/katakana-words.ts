export function katakanaToHiragana(word: string) {
  return word.replace(/[ァ-ヶ]/g, char => String.fromCharCode(char.charCodeAt(0) - 0x60));
}
export type KatakanaWord = { word: string; meaningZh: string };
export type KatakanaBatch = { words: KatakanaWord[] };
