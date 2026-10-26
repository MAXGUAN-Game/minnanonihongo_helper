import { randomUUID } from 'node:crypto';
import type { buildApp } from '../src/server/app';
import { task, assessmentResult } from './recordings-fixtures';

/** A real pre-v1.3 shape: original speaking scores linked to archived audio. */
export async function legacyBackup(app: ReturnType<typeof buildApp>, version: 1 | 2 | 3) {
  const backup = (await app.inject('/api/backup')).json();
  backup.version = version;
  delete backup.vocabularyMastery;
  const createdAt = '2026-10-01T00:00:00Z', recordingId = randomUUID(), assessmentId = randomUUID();
  backup.settings.autoplay = false;
  backup.progress = [{ lessonId: 1, stage: 'speak', cursor: 0, status: 'independent', itemId: task.id, updatedAt: createdAt }];
  backup.attempts = [{ id: randomUUID(), lessonId: 1, itemId: task.id, result: 'good', answer: '会社員です。', createdAt }];
  if (version < 3) { delete backup.aiQuestions; delete backup.aiAttempts; delete backup.aiPositions; }
  if (version === 1) { delete backup.recordings; delete backup.assessments; }
  else {
    backup.recordings = [{ id: recordingId, lessonId: 1, context: 'speak', itemId: task.id, createdAt,
      expiresAt: new Date(Date.parse(createdAt) + 90 * 86400000).toISOString(), durationMs: 500,
      transcript: '会社員です。', confirmedText: '会社員です。', audioAvailable: true, audioStatus: 'available' }];
    backup.assessments = [{ ...assessmentResult(), id: assessmentId, lessonId: 1, itemId: task.id,
      text: '会社員です。', recordingId, createdAt, source: 'deepseek', kind: 'expression', totalScore: 95 }];
    Object.assign(backup.attempts[0], { recordingId, assessmentId });
  }
  return backup;
}
