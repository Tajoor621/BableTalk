/** 16 kHz / 512 samples = 32 ms. Keep pre-roll and cap utterances at 12 s. */
export const FRAME = 512;
export type SpeechSegment = {
  samples: Float32Array;
  endSample: number;
  reason: 'silence' | 'limit' | 'stop';
};
export class Segmenter {
  constructor(private minimumSpeechFrames = 8) {}
  private pre: Float32Array[] = [];
  private frames: Float32Array[] = [];
  private speechFrames = 0;
  private silence = 0;
  private clock = 0;
  get active() {
    return this.frames.length > 0;
  }
  push(frame: Float32Array, probability: number): SpeechSegment | undefined {
    if (
      frame.length !== FRAME ||
      !Number.isFinite(probability) ||
      probability < 0 ||
      probability > 1
    ) {
      throw new Error('Invalid VAD frame or probability');
    }
    this.clock += FRAME;
    if (!this.active) {
      this.pre.push(frame.slice());
      if (this.pre.length > 7) {
        this.pre.shift();
      }
      if (probability < 0.6) {
        return;
      }
      this.frames = this.pre;
      this.pre = [];
      this.speechFrames = 1;
      this.silence = 0;
      return;
    }
    this.frames.push(frame.slice());
    if (probability >= 0.45) {
      this.silence = 0;
      this.speechFrames++;
    } else {
      this.silence++;
    }
    if (this.frames.length >= 375) {
      return this.finish('limit');
    }
    if (this.silence >= 16) {
      return this.finish('silence');
    }
  }
  flush() {
    return this.active ? this.finish('stop') : undefined;
  }
  private finish(reason: SpeechSegment['reason']): SpeechSegment | undefined {
    // Retain 96 ms of trailing silence. Reject impulses below the configured speech duration.
    const retained = this.frames.slice(
      0,
      Math.max(1, this.frames.length - Math.max(0, this.silence - 3)),
    );
    const endSample = this.clock - Math.max(0, this.silence - 3) * FRAME;
    const valid = this.speechFrames >= this.minimumSpeechFrames;
    this.frames = [];
    this.pre = [];
    this.silence = 0;
    this.speechFrames = 0;
    if (!valid) {
      return;
    }
    const samples = new Float32Array(retained.length * FRAME);
    retained.forEach((f, i) => samples.set(f, i * FRAME));
    return { samples, endSample, reason };
  }
}

/** Handles byte fragments, including a PCM sample split across callbacks. */
export class PcmFramer {
  private pending = new Uint8Array(0);
  push(bytes: Uint8Array): Float32Array[] {
    const joined = new Uint8Array(this.pending.length + bytes.length);
    joined.set(this.pending);
    joined.set(bytes, this.pending.length);
    const frames: Float32Array[] = [];
    let offset = 0;
    const view = new DataView(joined.buffer);
    while (offset + FRAME * 2 <= joined.length) {
      const frame = new Float32Array(FRAME);
      for (let i = 0; i < FRAME; i++) {
        frame[i] = view.getInt16(offset + i * 2, true) / 32768;
      }
      frames.push(frame);
      offset += FRAME * 2;
    }
    this.pending = joined.slice(offset);
    return frames;
  }
  flush(): Float32Array | undefined {
    if (!this.pending.length) {
      return;
    }
    const frame = new Float32Array(FRAME);
    const view = new DataView(this.pending.buffer);
    for (let i = 0; i + 1 < this.pending.length; i += 2) {
      frame[i / 2] = view.getInt16(i, true) / 32768;
    }
    this.pending = new Uint8Array(0);
    return frame;
  }
}
