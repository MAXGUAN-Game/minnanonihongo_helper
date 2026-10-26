import { afterEach, describe, expect, it, vi } from 'vitest';
import { requestAudioAssessment } from '../src/server/audio-assessment';
import { DEFAULT_AUDIO_ASSESSMENT_SETTINGS, type AudioAssessmentResult } from '../src/shared/audio-assessment';
import { getLesson } from '../src/content';
import { fixtureKey, lesson, task, wav } from './recordings-fixtures';

const settings = { ...DEFAULT_AUDIO_ASSESSMENT_SETTINGS, hasApiKey: true };
function result(): AudioAssessmentResult {
  return {
    text: '会社員です。', summaryZh: '意思表达清楚。', grammarFeedbackZh: '句尾です使用正确。', corrections: [],
    pronunciation: { status: 'clear', feedbackZh: '这句读音清楚。', issues: [] }, reference: task.answer,
  };
}
function provider(value: unknown = result(), finishReason: string | undefined = 'stop') {
  return new Response(JSON.stringify({ choices: [{ message: { content: typeof value === 'string' ? value : JSON.stringify(value) }, finish_reason: finishReason }] }), { headers: { 'content-type': 'application/json' } });
}
function request(audioFetch: typeof fetch, changes: Partial<Parameters<typeof requestAudioAssessment>[0]> = {}) {
  return requestAudioAssessment({ audioFetch, apiKey: fixtureKey, settings, lesson, task, audio: wav(), ...changes });
}
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('audio assessment provider boundary', () => {
  it('sends the actual WAV and a compact lesson context in a single direct-audio request', async () => {
    const audioFetch = vi.fn<typeof fetch>().mockResolvedValue(provider());
    const audio = wav();
    expect(await request(audioFetch, { audio })).toEqual(result());
    expect(audioFetch).toHaveBeenCalledTimes(1);
    const [url, init] = audioFetch.mock.calls[0]!;
    expect(url).toBe('https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions');
    expect(init).toMatchObject({ method: 'POST', redirect: 'error', headers: { Authorization: `Bearer ${fixtureKey}` } });
    const body = JSON.parse(init!.body as string);
    expect(body).toMatchObject({ model: 'qwen3.8-omni-flash', reasoning_effort: 'none', modalities: ['text'], stream: false, response_format: { type: 'json_object' }, max_tokens: 4096 });
    expect(body.messages).toHaveLength(2);
    expect(body.messages[1].content[1]).toEqual({ type: 'input_audio', input_audio: { data: `data:audio/wav;base64,${audio.toString('base64')}`, format: 'wav' } });
    expect(body.messages[1].content[0].text).toContain(task.goal);
    expect(body.messages[1].content[0].text).not.toContain('vocabulary');
    expect(body.messages[0].content).toContain('不能根据转写文字猜测');
    expect(body.messages[0].content).toContain('范句不是唯一正确答案');
    for (const forbidden of [fixtureKey, getLesson(50)!.title]) expect(init!.body).not.toContain(forbidden);
  });

  it('derives only the official Beijing workspace endpoint', async () => {
    const audioFetch = vi.fn<typeof fetch>().mockResolvedValue(provider());
    await request(audioFetch, { settings: { ...settings, workspaceId: 'workspace-123' } });
    expect(audioFetch.mock.calls[0]![0]).toBe('https://workspace-123.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/chat/completions');
  });

  it.each(['x.example.com', 'x@attacker.com', 'x/path', 'x\nsecret'])('rejects unsafe workspace %j before a network request', async workspaceId => {
    const audioFetch = vi.fn<typeof fetch>();
    await expect(request(audioFetch, { settings: { ...settings, workspaceId } })).rejects.toMatchObject({ code: 'AUDIO_INVALID_SETTINGS' });
    expect(audioFetch).not.toHaveBeenCalled();
  });

  it('rejects missing configuration and missing audio before invoking the paid provider', async () => {
    const audioFetch = vi.fn<typeof fetch>();
    await expect(request(audioFetch, { apiKey: '  ' })).rejects.toMatchObject({ status: 503, code: 'AUDIO_NOT_CONFIGURED' });
    for (const audio of [Buffer.alloc(0), Buffer.alloc(44), Buffer.from('this is not a WAV'.repeat(10))]) {
      await expect(request(audioFetch, { audio })).rejects.toMatchObject({ status: 422, code: 'AUDIO_UNASSESSABLE' });
    }
    expect(audioFetch).not.toHaveBeenCalled();
  });

  it('accepts honest pronunciation uncertainty without inventing an issue', async () => {
    const expected = result(); expected.pronunciation = { status: 'uncertain', feedbackZh: '轻微底噪让我无法确定长音。', issues: [] };
    const audioFetch = vi.fn<typeof fetch>().mockResolvedValue(provider(expected));
    expect(await request(audioFetch)).toEqual(expected);
  });

  it('maps a validated inaudible result to a retryable 422 without echoing upstream text', async () => {
    const audioFetch = vi.fn<typeof fetch>().mockResolvedValue(provider({ unassessable: true, reasonZh: '听不到清晰的日语。' }));
    await expect(request(audioFetch)).rejects.toMatchObject({ status: 422, code: 'AUDIO_UNASSESSABLE' });
    expect(audioFetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['missing field', () => { const { grammarFeedbackZh: _, ...partial } = result(); return partial; }],
    ['score', () => ({ ...result(), pronunciationScore: 100 })],
    ['unquoted correction', () => ({ ...result(), corrections: [{ goal: task.goal, original: '言っていない', corrected: task.answer, explanation: '练习一下。' }] })],
    ['foreign grammar', () => ({ ...result(), corrections: [{ goal: task.goal, original: '会社員', corrected: task.answer, explanation: '练习一下。', grammarId: getLesson(50)!.grammar[0].id }] })],
    ['contradictory pronunciation', () => ({ ...result(), pronunciation: { ...result().pronunciation, issues: [{ word: '会社員', expectedKana: 'かいしゃいん', issueZh: '长音不清楚。', practiceTipZh: '再慢读一遍。' }] } })],
    ['too many issues', () => ({ ...result(), pronunciation: { status: 'needs_practice', feedbackZh: '再试一遍。', issues: Array(3).fill({ word: '会社員', expectedKana: 'かいしゃいん', issueZh: '音不清楚。', practiceTipZh: '再慢读一遍。' }) } })],
    ['malformed inaudible result', () => ({ unassessable: true })],
    ['blank reply', () => '  '],
    ['truncated JSON', () => '{"text":"会社員'],
    ['nonobject', () => []],
  ])('rejects %s in one attempt', async (_name, value) => {
    const audioFetch = vi.fn<typeof fetch>().mockResolvedValue(provider(value()));
    await expect(request(audioFetch)).rejects.toMatchObject({ status: 502, code: 'AUDIO_INVALID_RESPONSE' });
    expect(audioFetch).toHaveBeenCalledTimes(1);
  });

  it('distinguishes truncated completions', async () => { await expect(request(vi.fn<typeof fetch>().mockResolvedValue(provider(result(), 'length')))).rejects.toMatchObject({ code: 'AUDIO_RESPONSE_TRUNCATED' }); });
  it('rejects a combined third suggestion and truncated or filtered completions', async () => {
    const value = result();
    value.corrections = [{ goal: task.goal, original: '会社員', corrected: task.answer, explanation: '再练一遍。' }];
    value.pronunciation = { status: 'needs_practice', feedbackZh: '再练一遍。', issues: Array(2).fill({ word: '会社員', expectedKana: 'かいしゃいん', issueZh: '再注意节奏。', practiceTipZh: '慢读。' }) };
    for (const response of [provider(value), provider(result(), 'content_filter'), new Response('{bad JSON')]) {
      const audioFetch = vi.fn<typeof fetch>().mockResolvedValue(response);
      await expect(request(audioFetch)).rejects.toMatchObject({ code: 'AUDIO_INVALID_RESPONSE' });
      expect(audioFetch).toHaveBeenCalledTimes(1);
    }
  });

  it.each([
    [401, 'AUDIO_AUTH_FAILED'], [403, 'AUDIO_PERMISSION_DENIED'], [429, 'AUDIO_BUSY'],
    [400, 'AUDIO_MODEL_UNAVAILABLE'], [404, 'AUDIO_MODEL_UNAVAILABLE'], [500, 'AUDIO_UNAVAILABLE'],
  ])('returns a safe error for provider HTTP %s', async (status, code) => {
    const audioFetch = vi.fn<typeof fetch>().mockResolvedValue(new Response(fixtureKey, { status }));
    const error = await request(audioFetch).catch(error => error);
    expect(error).toMatchObject({ code }); expect(error.message).not.toContain(fixtureKey);
    expect(error.message).toContain('重试'); expect(audioFetch).toHaveBeenCalledTimes(1);
  });

  it('does not expose secrets in direct, escaped or inaudible feedback, or network errors', async () => {
    const secretReply = JSON.stringify({ ...result(), summaryZh: fixtureKey });
    for (const value of [secretReply, secretReply.replace('sk-', '\\u0073k-'), { unassessable: true, reasonZh: fixtureKey }]) {
      const audioFetch = vi.fn<typeof fetch>().mockResolvedValue(provider(value));
      const error = await request(audioFetch).catch(error => error);
      expect(error.code).toBe('AUDIO_INVALID_RESPONSE'); expect(error.message).not.toContain(fixtureKey);
      expect(audioFetch).toHaveBeenCalledTimes(1);
    }
    const audioFetch = vi.fn<typeof fetch>().mockRejectedValue(new Error(fixtureKey));
    const error = await request(audioFetch).catch(error => error);
    expect(error.code).toBe('AUDIO_UNAVAILABLE'); expect(error.message).not.toContain(fixtureKey);
  });

  it('caps response bodies whether or not Content-Length is supplied', async () => {
    for (const response of [new Response('x', { headers: { 'content-length': '65537' } }), new Response('x'.repeat(65537))]) {
      const audioFetch = vi.fn<typeof fetch>().mockResolvedValue(response);
      await expect(request(audioFetch)).rejects.toMatchObject({ code: 'AUDIO_INVALID_RESPONSE' });
    }
  });

  it('stops an unresponsive fetch at 90 seconds and makes no automatic retry', async () => {
    vi.useFakeTimers();
    const audioFetch = vi.fn<typeof fetch>().mockImplementation(() => new Promise(() => {}));
    const pending = request(audioFetch).catch(error => error);
    await vi.advanceTimersByTimeAsync(90_000);
    expect(await pending).toMatchObject({ status: 504, code: 'AUDIO_TIMEOUT' });
    expect(audioFetch).toHaveBeenCalledTimes(1);
    expect(audioFetch.mock.calls[0]![1]!.signal!.aborted).toBe(true);
  });

  it('accepts a successful assessment after the former 25-second deadline', async () => {
    vi.useFakeTimers();
    const audioFetch = vi.fn<typeof fetch>().mockImplementation(() => new Promise(resolve => setTimeout(() => resolve(provider(result())), 45000)));
    const pending = request(audioFetch);
    await vi.advanceTimersByTimeAsync(45000);
    expect(await pending).toEqual(result());
    expect(audioFetch).toHaveBeenCalledTimes(1);
  });
  it('shares the deadline with a stalled body and cancels its reader', async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    const response = new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('{')); }, cancel }));
    const audioFetch = vi.fn<typeof fetch>().mockImplementation(() => new Promise(resolve => setTimeout(() => resolve(response), 20_000)));
    const pending = request(audioFetch).catch(error => error);
    await vi.advanceTimersByTimeAsync(89_999);
    expect(cancel).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toMatchObject({ code: 'AUDIO_TIMEOUT' });
    expect(cancel).toHaveBeenCalledTimes(1); expect(audioFetch).toHaveBeenCalledTimes(1);
  });

  it('maps a failed response stream to a safe network error', async () => {
    const audioFetch = vi.fn<typeof fetch>().mockResolvedValue(new Response(new ReadableStream({ start(controller) { controller.error(new Error(fixtureKey)); } })));
    const error = await request(audioFetch).catch(error => error);
    expect(error.code).toBe('AUDIO_UNAVAILABLE'); expect(error.message).not.toContain(fixtureKey);
  });
});
