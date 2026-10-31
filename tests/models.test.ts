import RNFS from 'react-native-fs';
import { verifyModels } from '../src/models/store';
import manifest from '../models.lock.json';
jest.mock('react-native-fs', () => ({
  DocumentDirectoryPath: '/private',
  exists: jest.fn(),
  stat: jest.fn(),
  hash: jest.fn(),
}));
beforeEach(() => jest.clearAllMocks());
it('fails closed for missing model files before inference', async () => {
  (RNFS.exists as jest.Mock).mockResolvedValue(false);
  await expect(verifyModels()).rejects.toThrow('missing');
});
it('rejects a correct-size file with a mismatched SHA-256', async () => {
  (RNFS.exists as jest.Mock).mockResolvedValue(true);
  (RNFS.stat as jest.Mock).mockResolvedValue({
    size: manifest.models[0].bytes,
  });
  (RNFS.hash as jest.Mock).mockResolvedValue('corrupt');
  await expect(verifyModels()).rejects.toThrow('verification failed');
});
it('accepts only the locked model pack', async () => {
  (RNFS.exists as jest.Mock).mockResolvedValue(true);
  for (const model of manifest.models) {
    (RNFS.stat as jest.Mock).mockResolvedValueOnce({ size: model.bytes });
    (RNFS.hash as jest.Mock).mockResolvedValueOnce(model.sha256);
  }
  await expect(verifyModels()).resolves.toEqual({
    vad: '/private/models/silero_vad.onnx',
    whisper: '/private/models/ggml-base.en-q5_1.bin',
  });
});
