import { InferenceSession, Tensor } from 'onnxruntime-react-native';
import labels from './mms-labels.json';
import { verifyMms } from '../models/store';
import { isLanguage, Language } from './languages';
export type Prediction = { code: string; score: number };
export function rankLanguages(logits: ArrayLike<number>): Prediction[] {
  if (logits.length !== Object.keys(labels).length) {
    throw new Error('MMS label count does not match model logits');
  }
  const values = Array.from(logits);
  if (values.some(x => !Number.isFinite(x))) {
    throw new Error('Non-finite MMS output');
  }
  const max = Math.max(...values);
  const probabilities = values.map(x => Math.exp(x - max));
  const sum = probabilities.reduce((a, b) => a + b, 0);
  return probabilities
    .map((p, i) => ({
      code: labels[String(i) as keyof typeof labels],
      score: p / sum,
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);
}
export function acceptLanguage(
  predictions: Prediction[],
  duration: number,
): Language | undefined {
  const [top, second] = predictions;
  return top &&
    duration >= 3 &&
    top.score >= 0.7 &&
    top.score - (second?.score || 0) >= 0.15 &&
    isLanguage(top.code)
    ? top.code
    : undefined;
}
export class MmsLid {
  private constructor(private session: InferenceSession) {}
  static async create() {
    return new MmsLid(
      await InferenceSession.create(await verifyMms(), {
        intraOpNumThreads: 2,
        interOpNumThreads: 1,
      }),
    );
  }
  async identify(samples: Float32Array) {
    // Bound the 1B-parameter classifier's input memory and quadratic attention cost.
    const audio = samples.slice(0, 16000 * 6);
    let mean = 0;
    for (const x of audio) {
      mean += x;
    }
    mean /= audio.length;
    let variance = 0;
    for (const x of audio) {
      variance += (x - mean) ** 2;
    }
    variance /= audio.length;
    const scale = Math.sqrt(variance + 1e-7);
    for (let i = 0; i < audio.length; i++) {
      audio[i] = (audio[i] - mean) / scale;
    }
    const feeds: Record<string, Tensor> = {
      input_values: new Tensor('float32', audio, [1, audio.length]),
    };
    if (this.session.inputNames.includes('attention_mask')) {
      feeds.attention_mask = new Tensor(
        'int64',
        new BigInt64Array(audio.length).fill(1n),
        [1, audio.length],
      );
    }
    const outputs = await this.session.run(feeds);
    const logits = outputs.logits || outputs[this.session.outputNames[0]];
    const predictions = rankLanguages(logits.data as Float32Array);
    return {
      predictions,
      language: acceptLanguage(predictions, samples.length / 16000),
    };
  }
  async release() {
    await this.session.release();
  }
}
