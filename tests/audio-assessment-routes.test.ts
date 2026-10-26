import { describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { deploymentConfig } from '../src/server/deployment';
import { DEFAULT_AUDIO_ASSESSMENT_SETTINGS } from '../src/shared/audio-assessment';
import { fixtureKey, provider, wav } from './recordings-fixtures';
import { audioKey, closePractice, configurePractice, createPractice, generatePractice, reference, scoreResult, submitAudio } from './practice-fixtures';

describe('direct audio settings and credential isolation', () => {
  it('preserves independent credentials across restart and restore, never exporting secrets', async () => {
    const first = createPractice();
    expect((await first.app.inject('/api/speaking/audio-settings')).json()).toEqual(DEFAULT_AUDIO_ASSESSMENT_SETTINGS);
    const backup = (await first.app.inject('/api/backup')).json(); await configurePractice(first.app);
    await first.app.inject({ method: 'PATCH', url: '/api/speaking/audio-settings', payload: { workspaceId: 'tenant-test-123' } });
    const exported = await first.app.inject('/api/backup');
    for (const value of [audioKey, fixtureKey, 'tenant-test-123']) expect(exported.body).not.toContain(value);
    expect((await first.app.inject({ method: 'POST', url: '/api/restore', payload: { backup } })).statusCode).toBe(200);
    await closePractice(first.app); const second = createPractice({ dataDir: first.dataDir });
    expect((await second.app.inject('/api/speaking/audio-settings')).json()).toMatchObject({ hasApiKey: true, workspaceId: 'tenant-test-123' });
    const question = await generatePractice(second.app); expect((await submitAudio(second.app, question.id)).statusCode).toBe(200);
    expect(second.audioFetch.mock.calls[0]![1]!.headers).toMatchObject({ Authorization: `Bearer ${audioKey}` });
    expect(second.aiFetch.mock.calls[0]![1]!.headers).toMatchObject({ Authorization: `Bearer ${fixtureKey}` });
    await second.app.inject({ method: 'PATCH', url: '/api/speaking/audio-settings', payload: { apiKey: '' } });
    expect((await second.app.inject('/api/speaking/audio-settings')).json().hasApiKey).toBe(false);
    expect((await second.app.inject('/api/settings')).json().hasApiKey).toBe(true);
  });
  it('rejects endpoint injection and forged configuration', async () => {
    const { app } = createPractice();
    for (const payload of [{ endpoint: 'https://attacker.example' }, { model: 'transcribe-only' }, { provider: 'deepseek' }, { workspaceId: '../key' }, { hasApiKey: true }]) expect((await app.inject({ method: 'PATCH', url: '/api/speaking/audio-settings', payload })).statusCode).toBe(400);
  });
  it('does not use the text provider key for audio', async () => {
    const { app, audioFetch } = createPractice();
    await app.inject({ method: 'PATCH', url: '/api/settings', payload: { apiKey: fixtureKey } });
    const question = await generatePractice(app); expect((await submitAudio(app, question.id)).statusCode).toBe(503);
    expect(audioFetch).not.toHaveBeenCalled(); expect((await app.inject('/api/backup')).json().aiAttempts).toEqual([]);
  });
});

describe('WAV answers without archives', () => {
  it('deduplicates concurrent and restarted submissions by request ID and waveform hash', async () => {
    const first = createPractice(); await configurePractice(first.app);
    const question = await generatePractice(first.app), id = randomUUID();
    const responses = await Promise.all([submitAudio(first.app, question.id, id), submitAudio(first.app, question.id, id)]);
    expect(responses.map(r => r.statusCode)).toEqual([200, 200]); expect(responses[0].json()).toEqual(responses[1].json()); expect(first.audioFetch).toHaveBeenCalledTimes(1);
    expect(responses[0].json()).toMatchObject({ totalScore: 98, usedHint: false }); expect(responses[0].json().recordingId).toBeUndefined();
    expect(existsSync(join(first.dataDir, 'recordings'))).toBe(false);
    expect((await submitAudio(first.app, question.id, id, wav(.5, 3000))).statusCode).toBe(409);
    await closePractice(first.app); const second = createPractice({ dataDir: first.dataDir });
    expect((await submitAudio(second.app, question.id, id)).json()).toEqual(responses[0].json()); expect(second.audioFetch).not.toHaveBeenCalled();
  });
  it('rejects malformed, silent, too short, too long, and unsupported WAV before calling a provider', async () => {
    const { app, audioFetch } = createPractice(); await configurePractice(app); const q = await generatePractice(app);
    const wrongRate = wav(); wrongRate.writeUInt32LE(48000, 24);
    const wrongBytes = wav(); wrongBytes.writeUInt32LE(96000, 28);
    const duplicateChunk = Buffer.concat([wav(), wav().subarray(36)]); duplicateChunk.writeUInt32LE(duplicateChunk.length - 8, 4);
    for (const bytes of [Buffer.from('bad'), wav(.1), wav(.5, 0), wav(30.01), wrongRate, wrongBytes, duplicateChunk]) {
      const response = await submitAudio(app, q.id, randomUUID(), bytes); expect(response.statusCode, response.body).toBe(400); expect(response.json().code).toBe('INVALID_AUDIO');
    }
    expect((await submitAudio(app, q.id, randomUUID(), Buffer.alloc(1100001))).statusCode).toBe(413); expect(audioFetch).not.toHaveBeenCalled();
    expect((await submitAudio(app, q.id, randomUUID(), wav(30))).statusCode).toBe(200);
  });
  it('rejects forged transcripts, outputs, archive IDs and absent questions', async () => {
    const { app, audioFetch } = createPractice(); await configurePractice(app); const q = await generatePractice(app);
    for (const query of ['&text=fake', '&recordingId=' + randomUUID(), '&totalScore=100']) expect((await submitAudio(app, q.id, randomUUID(), wav(), query)).statusCode).toBe(400);
    expect((await submitAudio(app, randomUUID())).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: `/api/ai-practice/questions/${q.id}/assess-audio?clientAssessmentId=${randomUUID()}`, payload: { text: reference.jp } })).statusCode).toBe(400);
    expect(audioFetch).not.toHaveBeenCalled();
  });
  it('allows a failed request to retry without counting the failure, and locks restore while scoring', async () => {
    const { app, audioFetch } = createPractice(); await configurePractice(app); const q = await generatePractice(app), id = randomUUID();
    audioFetch.mockRejectedValueOnce(new Error('offline')); expect((await submitAudio(app, q.id, id)).statusCode).toBe(502);
    const backup = (await app.inject('/api/backup')).json(); expect(backup.aiAttempts).toEqual([]);
    let finish!: (response: Response) => void; audioFetch.mockImplementationOnce(() => new Promise(done => { finish = done; }));
    const pending = submitAudio(app, q.id, id).then(r => r); await vi.waitFor(() => expect(audioFetch).toHaveBeenCalledTimes(2));
    expect((await app.inject({ method: 'POST', url: '/api/restore', payload: { backup } })).statusCode).toBe(409);
    finish(provider(scoreResult())); expect((await pending).json().usedHint).toBe(false);
  });
  it('does not count unrecognizable audio and permits retrying the same request', async () => {
    const { app, audioFetch } = createPractice(); await configurePractice(app); const q = await generatePractice(app, 'dictation'), id = randomUUID();
    audioFetch.mockResolvedValueOnce(provider({ readable: false, text: '' })); expect((await submitAudio(app, q.id, id)).statusCode).toBe(422);
    expect((await app.inject('/api/backup')).json().aiAttempts).toEqual([]);
    audioFetch.mockResolvedValueOnce(provider({ readable: true, text: reference.jp })); expect((await submitAudio(app, q.id, id)).json()).toMatchObject({ correct: true, inputMode: 'audio', usedHint: false });
  });
  it.each(['dictation', 'vocabulary'] as const)('recognizes %s independently and prevents text reuse under the audio request ID', async kind => {
    const { app, audioFetch, aiFetch } = createPractice(); await configurePractice(app); const q = await generatePractice(app, kind), id = randomUUID();
    audioFetch.mockResolvedValueOnce(provider({ readable: true, text: reference.jp }));
    if (kind === 'vocabulary') aiFetch.mockResolvedValueOnce(provider({ correct: true, feedbackZh: '自然。', reference }));
    const response = await submitAudio(app, q.id, id); expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({ inputMode: 'audio', answer: reference.jp, usedHint: false });
    const recognition = JSON.parse(audioFetch.mock.calls[0]![1]!.body as string);
    expect(JSON.stringify(recognition)).not.toContain(q.id); expect(JSON.stringify(recognition)).not.toContain(reference.jp);
    expect((await app.inject({ method: 'POST', url: `/api/ai-practice/questions/${q.id}/answer`, payload: { clientAttemptId: id, answer: reference.jp } })).statusCode).toBe(409);
  });
  it('blocks untrusted browser origins before any paid request or audio processing', async () => {
    const token = 'audio-private-test-token-1234567890';
    const { app, audioFetch } = createPractice({ deployment: deploymentConfig({ DEPLOYMENT: 'web', APP_PUBLIC_ORIGIN: 'https://study.example.com', APP_PROXY_TOKEN: token }) });
    const response = await app.inject({ method: 'POST', url: `/api/ai-practice/questions/${randomUUID()}/assess-audio?clientAssessmentId=${randomUUID()}`, headers: { host: 'study.example.com', origin: 'https://attacker.example', 'x-nihongo-proxy': token, 'content-type': 'audio/wav' }, payload: wav() });
    expect(response.statusCode).toBe(403); expect(audioFetch).not.toHaveBeenCalled();
  });
});
