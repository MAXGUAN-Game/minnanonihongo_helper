import { describe, it, expect } from 'vitest';
import { validateWav, getSpeechStatus } from '../src/server/speech';
function wav(seconds = .5, amplitude = 5000) {
  const buffer = Buffer.alloc(44 + Math.round(16000 * seconds) * 2);
  buffer.write('RIFF', 0); buffer.writeUInt32LE(buffer.length - 8, 4); buffer.write('WAVE', 8); buffer.write('fmt ', 12); buffer.writeUInt32LE(16, 16); buffer.writeUInt16LE(1, 20); buffer.writeUInt16LE(1, 22); buffer.writeUInt32LE(16000, 24); buffer.writeUInt32LE(32000, 28); buffer.writeUInt16LE(2, 32); buffer.writeUInt16LE(16, 34); buffer.write('data', 36); buffer.writeUInt32LE(buffer.length - 44, 40);
  for (let i = 44; i < buffer.length; i += 2) buffer.writeInt16LE(Math.round(Math.sin((i - 44) * .08) * amplitude), i);
  return buffer;
}
describe('speech input validation', () => {
  it('accepts audible 16kHz mono PCM', () => expect(() => validateWav(wav())).not.toThrow());
  it('rejects silence instead of hallucinating a transcript', () => expect(() => validateWav(wav(.5, 0))).toThrow('没有听到声音'));
  it('rejects invalid and truncated audio', () => { expect(() => validateWav(Buffer.from('not a WAV'))).toThrow(); expect(() => validateWav(wav().subarray(0, 50))).toThrow('不完整'); });
  it('rejects stereo and incorrect sample rates', () => { const stereo = wav(); stereo.writeUInt16LE(2, 22); expect(() => validateWav(stereo)).toThrow(); const otherRate = wav(); otherRate.writeUInt32LE(48000, 24); expect(() => validateWav(otherRate)).toThrow(); });
  it('rejects very short or oversized recordings', () => { expect(() => validateWav(wav(.1))).toThrow(); expect(() => validateWav(wav(32))).toThrow(); });
  it('reports unavailable local model without simulating recognition', () => expect(getSpeechStatus('test-results/nonexistent-speech-directory')).toMatchObject({ ready: false, modelReady: false, binaryReady: false }));
});
