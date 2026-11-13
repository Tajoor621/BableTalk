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
export function pickPhoto(language: Language) {
  return media().pickPhoto(language);
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

export async function importTranscript(language: Language) {
  const [{ default: RNFS }, { initWhisper }, models] = await Promise.all([
    import('react-native-fs'),
    import('whisper.rn/index'),
    verifyModels('multilingual'),
  ]);
  const path = await media().pickAudio();
  if (!path) {
    return null;
  }
  try {
    const context = await initWhisper({ filePath: models.whisper, useGpu: false });
    try {
      const result = await context.transcribe(path, {
        language: languages[language].tag,
        translate: false,
        maxThreads: 2,
      }).promise;
      if (!result.result.trim()) {
        throw new Error('No speech was recognised in the selected recording.');
      }
      return result.result.trim();
    } finally {
      await context.release();
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
      while (split > start + limit / 2 && !/\s|[.!?؟۔]/u.test(chars[split - 1])) {
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
