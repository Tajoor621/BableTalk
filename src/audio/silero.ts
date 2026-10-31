import { InferenceSession, Tensor } from 'onnxruntime-react-native';
import { FRAME } from './segmenter';
/** Silero v5 contract: 64-sample context + 512 new samples; recurrent state [2,1,128]. */
export class Silero {
  private state: Tensor = new Tensor(
    'float32',
    new Float32Array(256),
    [2, 1, 128],
  );
  private context = new Float32Array(64);
  private constructor(private session: InferenceSession) {}
  static async create(path: string) {
    return new Silero(
      await InferenceSession.create(path, {
        intraOpNumThreads: 1,
        interOpNumThreads: 1,
      }),
    );
  }
  async probability(frame: Float32Array) {
    if (frame.length !== FRAME) {
      throw new Error('Silero requires 512 samples');
    }
    const input = new Float32Array(576);
    input.set(this.context);
    input.set(frame, 64);
    const result = await this.session.run({
      input: new Tensor('float32', input, [1, 576]),
      state: this.state,
      sr: new Tensor('int64', BigInt64Array.from([16000n]), []),
    });
    this.state = result.stateN;
    this.context = frame.slice(-64);
    const p = Number(result.output.data[0]);
    if (!Number.isFinite(p) || p < 0 || p > 1) {
      throw new Error('Invalid Silero output');
    }
    return p;
  }
  async release() {
    await this.session.release();
  }
}
