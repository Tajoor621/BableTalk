import RNFS from 'react-native-fs';
import manifest from '../../models.lock.json';
import optional from '../../optional-models.lock.json';
export const modelDirectory = `${RNFS.DocumentDirectoryPath}/models`;
export type ModelSpec = {
  file: string;
  url: string;
  sha256: string;
  bytes: number;
  license: string;
  group?: string;
};
export function coreModels(
  mode: 'english' | 'multilingual' = 'english',
): ModelSpec[] {
  return manifest.models.filter(
    model =>
      model.file === 'silero_vad.onnx' ||
      model.file ===
        (mode === 'english' ? 'ggml-base.en-q5_1.bin' : 'ggml-base-q5_1.bin'),
  );
}
export async function verifyFile(model: ModelSpec) {
  const path = `${modelDirectory}/${model.file}`;
  if (!(await RNFS.exists(path))) {
    throw new Error(`Install models first: missing ${model.file}`);
  }
  const stat = await RNFS.stat(path);
  if (
    Number(stat.size) !== model.bytes ||
    (await RNFS.hash(path, 'sha256')) !== model.sha256
  ) {
    throw new Error(
      `Model verification failed: ${model.file}. Reinstall the model pack.`,
    );
  }
  return path;
}
export async function verifyModels(
  mode: 'english' | 'multilingual' = 'english',
) {
  for (const model of coreModels(mode)) {
    await verifyFile(model);
  }
  return {
    vad: `${modelDirectory}/silero_vad.onnx`,
    whisper: `${modelDirectory}/${
      mode === 'english' ? 'ggml-base.en-q5_1.bin' : 'ggml-base-q5_1.bin'
    }`,
  };
}
let downloadActive = false;
let captureActive = false;
export function setCaptureActive(active: boolean) {
  if (active && downloadActive) {
    throw new Error('Wait for model installation before recording');
  }
  captureActive = active;
}
export async function downloadModels(
  onProgress: (label: string, progress: number) => void,
  includeMms = false,
) {
  if (downloadActive || captureActive) {
    throw new Error('End recording and wait for the current download');
  }
  downloadActive = true;
  try {
    await RNFS.mkdir(modelDirectory, { NSURLIsExcludedFromBackupKey: true });
    const models: ModelSpec[] = includeMms
      ? optional.models
      : coreModels('multilingual');
    for (const model of models) {
      try {
        await verifyFile(model);
        onProgress(model.file, 1);
        continue;
      } catch {
        /* Explicit repair requested. */
      }
      const free = await RNFS.getFSInfo();
      if (free.freeSpace < model.bytes * 2 + 100_000_000) {
        throw new Error('Free additional storage before installing models');
      }
      const temp = `${modelDirectory}/${model.file}.part`;
      try {
        const result = await RNFS.downloadFile({
          fromUrl: model.url,
          toFile: temp,
          progressDivider: 2,
          progress: e =>
            onProgress(
              model.file,
              e.contentLength ? e.bytesWritten / e.contentLength : 0,
            ),
        }).promise;
        if (
          result.statusCode !== 200 ||
          Number((await RNFS.stat(temp)).size) !== model.bytes ||
          (await RNFS.hash(temp, 'sha256')) !== model.sha256
        ) {
          throw new Error(`Download verification failed: ${model.file}`);
        }
        if (await RNFS.exists(`${modelDirectory}/${model.file}`)) {
          await RNFS.unlink(`${modelDirectory}/${model.file}`);
        }
        await RNFS.moveFile(temp, `${modelDirectory}/${model.file}`);
        onProgress(model.file, 1);
      } finally {
        if (await RNFS.exists(temp)) {
          await RNFS.unlink(temp);
        }
      }
    }
  } finally {
    downloadActive = false;
  }
}
export async function verifyMms() {
  return verifyFile(optional.models[0]);
}
