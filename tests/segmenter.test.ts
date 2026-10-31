import { FRAME, PcmFramer, Segmenter } from '../src/audio/segmenter';
const frame = (value = 0.2) => new Float32Array(FRAME).fill(value);
it('preserves signed PCM16 samples through odd callback boundaries', () => {
  const bytes = new Uint8Array(FRAME * 2);
  const view = new DataView(bytes.buffer);
  view.setInt16(0, -32768, true);
  view.setInt16(2, 32767, true);
  const pcm = new PcmFramer();
  expect(pcm.push(bytes.slice(0, 3))).toEqual([]);
  const result = pcm.push(bytes.slice(3));
  expect(result).toHaveLength(1);
  expect(result[0][0]).toBe(-1);
  expect(result[0][1]).toBeCloseTo(32767 / 32768);
});
it('pads a partial final frame exactly once', () => {
  const pcm = new PcmFramer();
  pcm.push(new Uint8Array([0, 64, 0, 192]));
  const result = pcm.flush()!;
  expect(result.length).toBe(512);
  expect(result[0]).toBe(0.5);
  expect(result[1]).toBe(-0.5);
  expect(result[2]).toBe(0);
  expect(pcm.flush()).toBeUndefined();
});
it('never emits silence or short impulses', () => {
  const vad = new Segmenter();
  for (let i = 0; i < 100; i++) {
    expect(vad.push(frame(), 0)).toBeUndefined();
  }
  vad.push(frame(), 0.9);
  for (let i = 0; i < 16; i++) {
    expect(vad.push(frame(), 0)).toBeUndefined();
  }
  expect(vad.flush()).toBeUndefined();
});
it('retains pre-roll and speech, removes excess trailing silence', () => {
  const vad = new Segmenter();
  for (let i = 0; i < 6; i++) {
    vad.push(frame(0), 0);
  }
  for (let i = 0; i < 10; i++) {
    vad.push(frame(), 0.9);
  }
  for (let i = 0; i < 15; i++) {
    expect(vad.push(frame(0), 0)).toBeUndefined();
  }
  const result = vad.push(frame(0), 0)!;
  expect(result.reason).toBe('silence');
  expect(result.samples.length).toBe(19 * FRAME);
  expect(result.endSample).toBe(19 * FRAME);
  expect(vad.active).toBe(false);
});
it('flushes speech at stop, without duplicate finalisation', () => {
  const vad = new Segmenter();
  for (let i = 0; i < 10; i++) {
    vad.push(frame(), 0.9);
  }
  expect(vad.flush()!.samples.length).toBe(10 * FRAME);
  expect(vad.flush()).toBeUndefined();
});
it('caps continuous speech at 12 seconds', () => {
  const vad = new Segmenter();
  let result;
  for (let i = 0; i < 375; i++) {
    result = vad.push(frame(), 0.9);
  }
  expect(result!.reason).toBe('limit');
  expect(result!.samples.length).toBe(16000 * 12);
});
it('rejects non-finite probabilities and wrong frame sizes', () => {
  const vad = new Segmenter();
  expect(() => vad.push(frame(), NaN)).toThrow();
  expect(() => vad.push(new Float32Array(10), 0.5)).toThrow();
});
it('supports short conversational yes/no turns with the conversation-specific 128 ms gate', () => {
  const vad = new Segmenter(4);
  for (let i = 0; i < 4; i++) {
    vad.push(frame(), 0.9);
  }
  expect(vad.flush()?.samples.length).toBe(4 * FRAME);
});
