import { Buffer } from 'buffer';
import { DeviceEventEmitter, NativeModules, Platform } from 'react-native';
import type { AudioSource } from '../audio/pipeline';
import { Language, languages } from '../linguistics/languages';
import { verifyModels } from '../models/store';
import { requireLocal } from '../native';

interface MediaApi {
  pickText(): Promise<string | null>;
  pickPhoto(language: string): Promise<string | null>;
  pickAudio(): Promise<string | null>;
  startScreenAudio(): Promise<void>;
  stopScreenAudio(): Promise<void>;
}
function media() {
  const module = NativeModules.BabelMedia as MediaApi | undefined;
  if (!module) {
    throw new Error('Install the updated BabelTalk native build.');
  }
  return module;
}
export function pickText() {
  return media().pickText();
}
export type ChineseScript = 'simplified' | 'traditional';
export function pickPhoto(language: Language, script: ChineseScript) {
  const model = language === 'cmn'
    ? script === 'traditional' ? 'chi_tra' : 'chi_sim'
    : language;
  return media().pickPhoto(model);
}
export const screenAudioAvailable =
  Platform.OS === 'android' && Number(Platform.Version) >= 29;
export function screenAudioSource(): AudioSource {
  return {
    async init() {},
    start: () => media().startScreenAudio(),
    stop: () => media().stopScreenAudio(),
    on: (_event, callback) =>
      DeviceEventEmitter.addListener('BabelScreenPcm', callback),
  };
}

export async function importTranscript(
  language: Language,
  translatePashtoSpeech: boolean,
  cantonese: boolean,
  onProgress: (percent: number) => void,
) {
  const [{ default: RNFS }, { initWhisper }, { Silero }, { PcmFramer, Segmenter }, models] =
    await Promise.all([
      import('react-native-fs'),
      import('whisper.rn/index'),
      import('../audio/silero'),
      import('../audio/segmenter'),
      verifyModels(cantonese ? 'cantonese' : 'multilingual'),
    ]);
  const path = await media().pickAudio();
  if (!path) {
    return null;
  }
  try {
    onProgress(0);
    const size = Number((await RNFS.stat(path)).size);
    const wavHeaderBytes = 44; // Both native importers write a fixed PCM WAV header.
    if (!Number.isSafeInteger(size) || size <= wavHeaderBytes || size > wavHeaderBytes + 19200000 || size % 2 !== 0) {
      throw new Error('The recording contains invalid or unsupported audio.');
    }
    const vad = await Silero.create(models.vad);
    try {
      const framer = new PcmFramer();
      const segmenter = new Segmenter(4);
      const source: string[] = [];
      const english: string[] = [];
      let completeTranslation = true;
      let context: Awaited<ReturnType<typeof initWhisper>> | undefined;
      async function decode(samples: Float32Array) {
        context ??= await initWhisper({ filePath: models.whisper, useGpu: false });
        const audio = samples.buffer as ArrayBuffer;
        const text = (await context.transcribeData(audio, {
          language: cantonese ? 'yue' : languages[language].tag,
          translate: false,
          maxThreads: 2,
        }).promise).result.trim();
        if (!text) {
          return;
        }
        source.push(text);
        if (translatePashtoSpeech && completeTranslation) {
          try {
            const translated = (await context.transcribeData(audio, {
              language: 'ps',
              translate: true,
              maxThreads: 2,
            }).promise).result.trim();
            completeTranslation = Boolean(translated);
            if (translated) {
              english.push(translated);
            }
          } catch {
            completeTranslation = false;
          }
        }
      }
      try {
        const blockSize = 32768;
        for (let position = wavHeaderBytes; position < size; position += blockSize) {
          const count = Math.min(blockSize, size - position);
          const bytes = Buffer.from(await RNFS.read(path, count, position, 'base64'), 'base64');
          if (bytes.length !== count) {
            throw new Error('The recording could not be read in full.');
          }
          for (const frame of framer.push(bytes)) {
            const segment = segmenter.push(frame, await vad.probability(frame));
            if (segment) {
              await decode(segment.samples);
            }
          }
          onProgress(Math.min(99, Math.floor((position + count - wavHeaderBytes) / (size - wavHeaderBytes) * 100)));
        }
        const tail = framer.flush();
        if (tail) {
          const segment = segmenter.push(tail, await vad.probability(tail));
          if (segment) {
            await decode(segment.samples);
          }
        }
        const final = segmenter.flush();
        if (final) {
          await decode(final.samples);
        }
        if (!source.length) {
          throw new Error('No speech was recognised in the selected recording.');
        }
        return {
          text: source.join('\n'),
          english: completeTranslation ? english.join('\n') : '',
        };
      } finally {
        await context?.release();
      }
    } finally {
      await vad.release();
    }
  } finally {
    await RNFS.unlink(path).catch(() => {});
  }
}

export function translationChunks(value: string, limit = 3000): string[] {
  const chars = Array.from(value.trim());
  const chunks: string[] = [];
  let start = 0;
  while (start < chars.length) {
    let end = Math.min(start + limit, chars.length);
    if (end < chars.length) {
      let split = end;
      while (split > start + limit / 2 && !/\s|[.!?。！？؟۔]/u.test(chars[split - 1])) {
        split--;
      }
      if (split > start + limit / 2) {
        end = split;
      }
    }
    chunks.push(chars.slice(start, end).join(''));
    start = end;
  }
  return chunks;
}

export async function translateDocument(text: string, source: Language, target: Language) {
  if (!text.trim()) {
    return '';
  }
  if (source === target) {
    return text;
  }
  if (!languages[source].translation || !languages[target].translation) {
    throw new Error('Pashto is available for transcription and text review.');
  }
  const api = requireLocal();
  const a = languages[source].tag;
  const b = languages[target].tag;
  if (!(await api.pairReady(a, b))) {
    throw new Error('Prepare this language pair in Models or use Download pair here.');
  }
  const paragraphs: string[] = [];
  for (const paragraph of text.split(/\n/u)) {
    const parts: string[] = [];
    for (const chunk of translationChunks(paragraph)) {
      parts.push(await api.translate(chunk, a, b));
    }
    paragraphs.push(parts.join(' '));
  }
  return paragraphs.join('\n');
}
