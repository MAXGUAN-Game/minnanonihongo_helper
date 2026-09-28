// Refresh public playlist metadata only. Never fetch or package MP3/ZIP files.
// Run manually when the publisher updates its free second-edition playlists.
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const origin = 'https://www.3anet.co.jp';
const books = [
  { volume: 1, goodsId: 485, resource: '230020', firstLesson: 1, expectedTracks: 87 },
  { volume: 2, goodsId: 490, resource: '240020', firstLesson: 26, expectedTracks: 75 },
];
const wait = ms => new Promise(resolveWait => setTimeout(resolveWait, ms));

export function parseLessonTracks(html, { volume, lessonId }) {
  const book = books.find(item => item.volume === volume);
  const block = lessonId - (book?.firstLesson ?? 0) + 1;
  if (!book || !Number.isInteger(lessonId) || block < 1 || block > 25) throw new Error('Invalid textbook lesson.');
  const prefix = `/np/secure/0-0001-01-${book.resource}/0-0001-01-${book.resource}-${block}.exp/`;
  const urls = [...html.matchAll(/<audio\b[^>]*\bsrc\s*=\s*"([^"]+)"/gi)].map(match => new URL(match[1], origin));
  if (urls.length < 1 || urls.length > 10) throw new Error(`Unexpected playlist length for lesson ${lessonId}.`);
  const tracks = urls.map((url, index) => {
    const filename = url.pathname.slice(prefix.length);
    const number = filename.match(new RegExp(`^minna_shokyu_${volume}_([0-9]{3})\\.mp3$`));
    if (url.origin !== origin || url.username || url.password || url.search || url.hash || !url.pathname.startsWith(prefix) || !number || Number(number[1]) < 1 || Number(number[1]) > book.expectedTracks) {
      throw new Error(`Unexpected audio source for lesson ${lessonId}.`);
    }
    return { id: `minna-2e-${volume}-${number[1]}`, order: index + 1, filename, url: url.href };
  });
  if (new Set(tracks.map(track => track.url)).size !== tracks.length) throw new Error(`Duplicate tracks for lesson ${lessonId}.`);
  return { lessonId, volume, sourcePage: `${origin}/np/resrcs/${book.resource}/`, tracks };
}

async function fetchLesson(book, block) {
  let response;
  for (let attempt = 0; attempt < 3; attempt++) {
    response = await fetch(`${origin}/np/resrcs-detail.html`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ goods_id: String(book.goodsId), blockDispOrder: String(block) }),
      signal: AbortSignal.timeout(20000),
    });
    if (response.ok || ![429, 502, 503, 504].includes(response.status) || attempt === 2) break;
    await response.body?.cancel();
    await wait(1000 * (attempt + 1));
  }
  if (!response.ok) throw new Error(`Publisher playlist metadata failed: HTTP ${response.status}.`);
  const html = await response.text();
  if (html.length > 100000) throw new Error('Unexpectedly large playlist metadata.');
  return parseLessonTracks(html, { volume: book.volume, lessonId: book.firstLesson + block - 1 });
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 1 || args[0] !== '--resume')) throw new Error('Usage: node scripts/refresh-textbook-audio.mjs [--resume]');
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const checkpoint = path.join(root, 'test-results/textbook-audio-metadata.json');
  await mkdir(path.dirname(checkpoint), { recursive: true });
  let lessons = [];
  if (args[0] === '--resume') {
    try {
      const saved = JSON.parse(await readFile(checkpoint, 'utf8'));
      if (!Array.isArray(saved)) throw new Error('Invalid metadata checkpoint.');
      lessons = saved.map(lesson => {
        if (!Array.isArray(lesson.tracks) || lesson.tracks.some(track => typeof track.url !== 'string' || track.url.includes('"'))) throw new Error('Invalid metadata checkpoint.');
        const checked = parseLessonTracks(lesson.tracks.map(track => `<audio src="${track.url}"></audio>`).join(''), lesson);
        if (JSON.stringify(checked) !== JSON.stringify(lesson)) throw new Error('Invalid metadata checkpoint.');
        return checked;
      });
      if (new Set(lessons.map(lesson => lesson.lessonId)).size !== lessons.length) throw new Error('Duplicate checkpoint lesson.');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  for (const book of books) {
    // One small metadata request at a time, with a pause between requests. The
    // browser fetches a selected MP3 only after the learner presses Play.
    for (let block = 1; block <= 25; block++) {
      if (lessons.some(lesson => lesson.lessonId === book.firstLesson + block - 1)) continue;
      lessons.push(await fetchLesson(book, block));
      lessons.sort((a, b) => a.lessonId - b.lessonId);
      await writeFile(checkpoint, JSON.stringify(lessons, null, 2) + '\n');
      await wait(1000);
    }
    const tracks = lessons.filter(lesson => lesson.volume === book.volume).flatMap(lesson => lesson.tracks);
    const numbers = tracks.map(track => Number(track.filename.match(/_([0-9]{3})\.mp3$/)[1])).sort((a, b) => a - b);
    if (tracks.length !== book.expectedTracks || numbers.some((number, index) => number !== index + 1)) throw new Error(`Incomplete or duplicated volume ${book.volume} metadata; no files changed.`);
    console.log(`Volume ${book.volume}: 25 lessons, ${tracks.length} verified playlist entries.`);
  }
  const manifest = { schemaVersion: 1, textbookEdition: 2, publisher: 'スリーエーネットワーク', retrievedAt: new Date().toISOString(), lessons };
  const output = path.join(root, 'src/content/textbook-audio.json');
  await mkdir(path.dirname(output), { recursive: true });
  const temporary = `${output}.pending-${process.pid}`;
  await writeFile(temporary, JSON.stringify(manifest, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' });
  await rename(temporary, output);
  console.log('Saved 50 lesson playlists. No audio or ZIP files were downloaded.');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); console.error('Verified metadata is preserved. Retry later with --resume; the application manifest was not replaced.'); process.exitCode = 1; });
}
