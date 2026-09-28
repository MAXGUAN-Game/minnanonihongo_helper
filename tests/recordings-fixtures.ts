import { randomUUID } from 'node:crypto';
import { getLesson } from '../src/content';
import type { buildApp } from '../src/server/app';
import type { Recording } from '../src/shared/recordings';

export const lesson = getLesson(1)!;
export const task = lesson.speaking[0]!;
export const fixtureKey = 'sk-recordings-fake-provider-key';
export function wav(seconds = .5, amplitude = 5000) {
  const buffer = Buffer.alloc(44 + Math.round(16000 * seconds) * 2);
  buffer.write('RIFF', 0); buffer.writeUInt32LE(buffer.length - 8, 4); buffer.write('WAVE', 8);
  buffer.write('fmt ', 12); buffer.writeUInt32LE(16, 16); buffer.writeUInt16LE(1, 20); buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(16000, 24); buffer.writeUInt32LE(32000, 28); buffer.writeUInt16LE(2, 32); buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36); buffer.writeUInt32LE(buffer.length - 44, 40);
  for (let i = 44; i < buffer.length; i += 2) buffer.writeInt16LE(Math.round(Math.sin((i - 44) * .08) * amplitude), i);
  return buffer;
}
export function upload(app: ReturnType<typeof buildApp>, overrides: Partial<{ lessonId: number; context: 'speak' | 'conversation'; itemId: string; clientRecordingId: string }> = {}, bytes = wav(), headers: Record<string, string> = {}) {
  const query = new URLSearchParams(Object.entries({ lessonId: lesson.id, context: 'speak', itemId: task.id, clientRecordingId: randomUUID(), ...overrides }).map(([key, value]) => [key, String(value)]));
  return app.inject({ method: 'POST', url: `/api/recordings?${query}`, headers: { ...headers, 'content-type': 'audio/wav' }, payload: bytes });
}
export async function saved(app: ReturnType<typeof buildApp>, overrides: Parameters<typeof upload>[1] = {}): Promise<Recording> {
  const response = await upload(app, overrides);
  if (response.statusCode !== 200) throw new Error(response.body);
  return response.json();
}
export function assessmentResult(overrides: Record<string, unknown> = {}) {
  return { taskScore: 48, grammarScore: 29, vocabularyScore: 18, summaryZh: '意思表达清楚，可以再练一句。', corrections: [], reference: task.answer, ...overrides };
}
export function provider(result: unknown = assessmentResult()) {
  return new Response(JSON.stringify({ choices: [{ message: { content: typeof result === 'string' ? result : JSON.stringify(result) } }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}
