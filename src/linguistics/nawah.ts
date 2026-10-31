import { Platform } from 'react-native';
import RNFS from 'react-native-fs';
import { InferenceSession, Tensor } from 'onnxruntime-react-native';
import { ByteBpe, BpeModel, stripArabicDiacritics } from './bpe';
import { modelDirectory } from '../models/store';
type Pack = {
  schema: number;
  source: string;
  revision: string;
  files: { file: string; bytes: number; sha256: string }[];
};
export const dialectNames: Record<string, string> = {
  bh: 'Bahraini',
  dz: 'Algerian',
  eg: 'Egyptian',
  iq: 'Iraqi',
  lb: 'Lebanese',
  ly: 'Libyan',
  ma: 'Moroccan',
  msa: 'Modern Standard Arabic',
  ps: 'Palestinian',
  sa: 'Saudi',
  sd: 'Sudanese',
  sy: 'Syrian',
  tn: 'Tunisian',
  ye: 'Yemeni',
};
export type DialectResult = { label?: string; warning: string };
async function loadPack() {
  const folder = `${modelDirectory}/nawah`;
  await RNFS.mkdir(folder, { NSURLIsExcludedFromBackupKey: true });
  // Build-generated assets contain only public model data; no remote code.
  for (const name of [
    'manifest.json',
    'model.onnx',
    'tokenizer.json',
    'labels.json',
  ]) {
    const dest = `${folder}/${name}`;
    if (!(await RNFS.exists(dest))) {
      if (Platform.OS === 'android') {
        await RNFS.copyFileAssets(`nawah/${name}`, dest);
      } else {
        await RNFS.copyFile(`${RNFS.MainBundlePath}/nawah/${name}`, dest);
      }
    }
  }
  const pack = JSON.parse(
    await RNFS.readFile(`${folder}/manifest.json`, 'utf8'),
  ) as Pack;
  if (
    pack.schema !== 1 ||
    pack.source !== 'oddadmix/Nawah-Dialect-BERT-6M' ||
    pack.revision !== 'a603d94f1c32d47fa79deb852e16db51caff70de'
  ) {
    throw new Error('Nawah pack identity mismatch');
  }
  for (const name of ['model.onnx', 'tokenizer.json', 'labels.json']) {
    const file = pack.files.find(f => f.file === name);
    const path = `${folder}/${name}`;
    if (
      !file ||
      Number((await RNFS.stat(path)).size) !== file.bytes ||
      (await RNFS.hash(path, 'sha256')) !== file.sha256
    ) {
      throw new Error(`Nawah integrity check failed: ${name}`);
    }
  }
  return folder;
}
export class NawahDialect {
  private constructor(
    private session: InferenceSession,
    private tokenizer: ByteBpe,
    private labels: string[],
  ) {}
  static async create() {
    const folder = await loadPack();
    const tokenizer = JSON.parse(
      await RNFS.readFile(`${folder}/tokenizer.json`, 'utf8'),
    ) as { model: BpeModel };
    const labels = JSON.parse(
      await RNFS.readFile(`${folder}/labels.json`, 'utf8'),
    ).labels as string[];
    if (labels.length !== 14 || labels.some(label => !dialectNames[label])) {
      throw new Error('Nawah labels mismatch');
    }
    return new NawahDialect(
      await InferenceSession.create(`${folder}/model.onnx`, {
        intraOpNumThreads: 2,
        interOpNumThreads: 1,
      }),
      new ByteBpe(tokenizer.model),
      labels,
    );
  }
  async classify(text: string): Promise<DialectResult> {
    if (stripArabicDiacritics(text).trim().split(/\s+/u).length < 25) {
      return {
        warning: 'Arabic dialect: insufficient context (at least 25 words).',
      };
    }
    const ids = this.tokenizer.encode(text);
    if (!ids.length) {
      return { warning: 'Arabic dialect: no tokens.' };
    }
    const outputs = await this.session.run({
      input_ids: new Tensor('int64', BigInt64Array.from(ids, BigInt), [
        1,
        ids.length,
      ]),
      attention_mask: new Tensor(
        'int64',
        new BigInt64Array(ids.length).fill(1n),
        [1, ids.length],
      ),
    });
    const values = Array.from(outputs.logits.data as Float32Array);
    if (values.length !== 14 || values.some(v => !Number.isFinite(v))) {
      throw new Error('Invalid Nawah logits');
    }
    const max = Math.max(...values);
    const weights = values.map(v => Math.exp(v - max));
    const sum = weights.reduce((a, b) => a + b, 0);
    const ranked = weights
      .map((v, i) => ({ label: this.labels[i], score: v / sum }))
      .sort((a, b) => b.score - a.score);
    if (ranked[0].score < 0.8 || ranked[0].score - ranked[1].score < 0.2) {
      return { warning: 'Arabic dialect is uncertain; no label assigned.' };
    }
    return {
      label: dialectNames[ranked[0].label],
      warning:
        'Arabic dialect candidate from accumulated same-speaker text; not a calibrated certainty score.',
    };
  }
  async release() {
    await this.session.release();
  }
}
