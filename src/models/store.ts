import RNFS from 'react-native-fs';
import manifest from '../../models.lock.json';
export const modelDirectory = `${RNFS.DocumentDirectoryPath}/models`;
export async function verifyModels() {
  for (const model of manifest.models) {
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
  }
  return {
    vad: `${modelDirectory}/silero_vad.onnx`,
    whisper: `${modelDirectory}/ggml-base.en-q5_1.bin`,
  };
}
