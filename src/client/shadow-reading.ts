import type { Example } from '../shared/types';

const numeralDigits: Record<string, string> = { '〇':'0', '零':'0', '一':'1', '二':'2', '三':'3', '四':'4', '五':'5', '六':'6', '七':'7', '八':'8', '九':'9' };
function writtenInteger(value: string): string {
  const digits = value.replace(/[〇零一二三四五六七八九]/g, char => numeralDigits[char]);
  if (/^\d+$/.test(digits)) return digits;
  // Only canonical integers below 10,000: malformed or larger-unit forms stay
  // literal. This equates 四十分 with 40分 without guessing either pronunciation.
  if (!/^(?:[1-9]?千)?(?:[1-9]?百)?(?:[1-9]?十)?[1-9]?$/.test(digits)) return value;
  let total = 0;
  const remainder = digits.replace(/([1-9]?)(千|百|十)/g, (_match, digit: string, unit: string) => {
    total += Number(digit || 1) * ({'千':1000, '百':100, '十':10}[unit] ?? 0); return '';
  });
  return String(total + Number(remainder || 0));
}

export function shadowNormalize(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase().replace(/[ァ-ヶ]/g, char => String.fromCharCode(char.charCodeAt(0) - 0x60))
    .replace(/[\d〇零一二三四五六七八九十百千万億兆]+/g, writtenInteger).replace(/[\p{P}\p{Z}\s]/gu, '');
}
type Piece = { text: string; end: number; normalized: string; reading?: string };

/** Align visible kanji runs to the supplied reading using intervening kana as anchors.
 * Uncertain alignments simply fall back to matching written Japanese; they never
 * estimate progress from elapsed time or audio volume. */
function readingPieces(example: Example): Piece[] {
  const pieces: Piece[] = [];
  let offset = 0;
  for (const text of example.jp.match(/[\p{Script=Han}々〆ヵヶ\d]+|[^\p{Script=Han}々〆ヵヶ\d]/gu) ?? []) {
    offset += text.length; const normalized = shadowNormalize(text);
    if (normalized) pieces.push({ text, end: offset, normalized });
  }
  const kana = shadowNormalize(example.kana);
  const memo = new Map<string, string[] | null>();
  const align = (index: number, position: number): string[] | null => {
    if (index === pieces.length) return position === kana.length ? [] : null;
    const key = `${index}:${position}`; if (memo.has(key)) return memo.get(key)!;
    const value = pieces[index].normalized;
    if (/^[\p{Script=Hiragana}ーa-z]+$/u.test(value)) {
      if (kana.startsWith(value, position)) { const rest = align(index + 1, position + value.length); if (rest) return [value, ...rest]; }
    } else {
      // A whole kanji/number run highlights only after its entire reading matched.
      for (let end = position + 1; end <= kana.length; end++) {
        const rest = align(index + 1, end); if (rest) return [kana.slice(position, end), ...rest];
      }
    }
    memo.set(key, null); return null;
  };
  const readings = align(0, 0);
  if (readings) pieces.forEach((piece, index) => { piece.reading = readings[index]; });
  return pieces;
}

export function shadowProgress(example: Example, transcript: string): { jpEnd: number; kanaEnd: number; complete: boolean } {
  const pieces = readingPieces(example);
  const heard = shadowNormalize(transcript);
  const target = shadowNormalize(example.jp), kana = shadowNormalize(example.kana);
  const common = (a: string, b: string) => { let index = 0; while (index < a.length && index < b.length && a[index] === b[index]) index++; return index; };
  const writtenPrefix = common(target, heard);
  let phonetic = heard;
  for (const piece of [...pieces].sort((a, b) => b.normalized.length - a.normalized.length)) {
    if (piece.reading && piece.reading !== piece.normalized) phonetic = phonetic.replaceAll(piece.normalized, piece.reading);
  }
  const kanaPrefix = common(kana, phonetic);
  let jpEnd = 0, writtenOffset = 0, kanaOffset = 0;
  for (const piece of pieces) {
    writtenOffset += piece.normalized.length;
    kanaOffset += piece.reading?.length ?? Number.POSITIVE_INFINITY;
    if (writtenOffset <= writtenPrefix || kanaOffset <= kanaPrefix) jpEnd = piece.end;
  }
  const complete = !!target && (writtenPrefix === target.length || (!!kana && kanaPrefix === kana.length && pieces.every(piece => piece.reading)));
  if (complete) jpEnd = example.jp.length;
  let kanaEnd = 0, normalizedOffset = 0;
  for (const char of example.kana) { normalizedOffset += shadowNormalize(char).length; if (normalizedOffset <= kanaPrefix) kanaEnd += char.length; else break; }
  if (complete) kanaEnd = example.kana.length;
  return { jpEnd, kanaEnd, complete };
}
