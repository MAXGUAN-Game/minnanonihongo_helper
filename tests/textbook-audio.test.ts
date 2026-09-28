import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { getTextbookAudioLesson, isOfficialTextbookAudioUrl, textbookAudioLessons, textbookAudioManifest } from '../src/content/textbook-audio';
import { TextbookAudio } from '../src/client/TextbookAudio';
import type { Speech } from '../src/client/speech';

const { parseLessonTracks } = await import(pathToFileURL(join(process.cwd(), 'scripts/refresh-textbook-audio.mjs')).href);
const { collectPackageFiles } = await import(pathToFileURL(join(process.cwd(), 'scripts/package-web.mjs')).href);
const firstUrl = 'https://www.3anet.co.jp/np/secure/0-0001-01-230020/0-0001-01-230020-1.exp/minna_shokyu_1_001.mp3';

describe('publisher textbook audio manifest', () => {
  it('provides both second-edition books and every lesson exactly once', () => {
    expect(textbookAudioManifest.textbookEdition).toBe(2);
    expect(Number.isNaN(Date.parse(textbookAudioManifest.retrievedAt))).toBe(false);
    expect(textbookAudioLessons.map(lesson => lesson.lessonId)).toEqual(Array.from({ length: 50 }, (_, index) => index + 1));
    for (const lesson of textbookAudioLessons) {
      expect(lesson.volume).toBe(lesson.lessonId <= 25 ? 1 : 2);
      expect(lesson.tracks.length).toBeGreaterThan(0);
      expect(lesson.tracks.map(track => track.order)).toEqual(Array.from({ length: lesson.tracks.length }, (_, index) => index + 1));
    }
  });

  it('retains all 162 unique official tracks in their original book order', () => {
    const all = textbookAudioLessons.flatMap(lesson => lesson.tracks);
    expect(all).toHaveLength(162);
    expect(new Set(all.map(track => track.id)).size).toBe(162);
    expect(new Set(all.map(track => track.url)).size).toBe(162);
    for (const volume of [1, 2]) {
      const tracks = textbookAudioLessons.filter(lesson => lesson.volume === volume).flatMap(lesson => lesson.tracks);
      expect(tracks.map(track => track.filename)).toEqual(Array.from({ length: volume === 1 ? 87 : 75 }, (_, index) => `minna_shokyu_${volume}_${String(index + 1).padStart(3, '0')}.mp3`));
    }
  });

  it.each([
    [1, 1, [1, 2, 3, 4]], [25, 1, [85, 86, 87]], [26, 2, [1, 2, 3]], [50, 2, [73, 74, 75]],
  ] as const)('maps boundary lesson %i to its independently checked official tracks', (lessonId, volume, numbers) => {
    const lesson = getTextbookAudioLesson(lessonId)!;
    expect(lesson.tracks.map(track => track.filename)).toEqual(numbers.map(number => `minna_shokyu_${volume}_${String(number).padStart(3, '0')}.mp3`));
  });

  it('uses only the correct book and lesson directories on the official HTTPS host', () => {
    for (const lesson of textbookAudioLessons) {
      const resource = lesson.volume === 1 ? '230020' : '240020';
      const block = lesson.volume === 1 ? lesson.lessonId : lesson.lessonId - 25;
      expect(lesson.sourcePage).toBe(`https://www.3anet.co.jp/np/resrcs/${resource}/`);
      for (const track of lesson.tracks) {
        const url = new URL(track.url);
        expect(url.origin).toBe('https://www.3anet.co.jp');
        expect(url.pathname).toBe(`/np/secure/0-0001-01-${resource}/0-0001-01-${resource}-${block}.exp/${track.filename}`);
        expect(url.username + url.password + url.search + url.hash).toBe('');
        expect(isOfficialTextbookAudioUrl(track.url)).toBe(true);
      }
    }
  });

  it('does not accept arbitrary URLs, lookalike domains, credentials, or unlisted files', () => {
    for (const url of [null, undefined, {}, '', '/api/recordings/123/audio', 'blob:local-audio',
      firstUrl.replace('https:', 'http:'), firstUrl.replace('www.3anet.co.jp', 'www.3anet.co.jp.example.com'),
      firstUrl.replace('https://', 'https://user:password@'), firstUrl + '?download=true', firstUrl + '#fragment',
      firstUrl.replace('_001.mp3', '_999.mp3'), firstUrl.replace('230020', '900020'),
    ]) expect(isOfficialTextbookAudioUrl(url)).toBe(false);
    for (const lessonId of [0, -1, 51, 1.5, Number.NaN]) expect(getTextbookAudioLesson(lessonId)).toBeUndefined();
  });

  it('keeps audio binaries out of the deployable source package', async () => {
    const files: string[] = await collectPackageFiles();
    expect(files).toContain('src/content/textbook-audio.json');
    expect(files.filter(file => /\.(mp3|wav|m4a|aac|ogg|flac|opus|zip)$/i.test(file))).toEqual([]);
    expect(JSON.stringify(textbookAudioManifest)).not.toMatch(/data:audio|base64,/i);
  });

  it.skipIf(!existsSync(join(process.cwd(), '.git')))('does not track audio binaries in Git', () => {
    const tracked = execFileSync('git', ['ls-files', '--', '*.mp3', '*.wav', '*.m4a', '*.aac', '*.ogg', '*.flac', '*.opus'], { cwd: process.cwd(), encoding: 'utf8', windowsHide: true });
    expect(tracked.trim()).toBe('');
  });
});

describe('publisher metadata parsing without audio downloads', () => {
  it('retains exact filenames and playlist order without inventing question labels', () => {
    const first = firstUrl.replace('https://www.3anet.co.jp', '');
    const second = first.replace('_001.mp3', '_002.mp3');
    const result = parseLessonTracks(`<audio src="${first}" controls></audio><audio preload="none" src="${second}"></audio>`, { lessonId: 1, volume: 1 });
    expect(result.tracks).toEqual(getTextbookAudioLesson(1)!.tracks.slice(0, 2));
    expect(result.tracks.every((track: object) => !('category' in track) && !('transcript' in track))).toBe(true);
  });

  it('rejects an empty, duplicate, paid, or unexpected lesson playlist', () => {
    for (const markup of [
      '<p>Login required</p>', `<audio src="${firstUrl}"></audio><audio src="${firstUrl}"></audio>`,
      `<audio src="${firstUrl.replace('230020', '900020')}"></audio>`,
      `<audio src="${firstUrl.replace('-1.exp/', '-2.exp/')}"></audio>`,
      '<audio src="https://example.com/audio.mp3"></audio>',
    ]) expect(() => parseLessonTracks(markup, { lessonId: 1, volume: 1 })).toThrow();
  });
});

describe('reusable textbook player presentation', () => {
  it('shows an explicit Play action and official source without starting a request while rendering', () => {
    const speech = { playUrl: vi.fn(), stop: vi.fn() } as unknown as Speech;
    const markup = renderToStaticMarkup(createElement(TextbookAudio, { lessonId: 26, speech }));
    expect(markup).toContain('第 26 课教材原声');
    expect(markup).toContain('官方音轨 1 / 3');
    expect(markup).toContain('minna_shokyu_2_001.mp3');
    expect(markup).toContain('https://www.3anet.co.jp/np/resrcs/240020/');
    expect(markup).not.toContain('<audio');
    expect(speech.playUrl).not.toHaveBeenCalled();
    expect(speech.stop).not.toHaveBeenCalled();
  });
});
