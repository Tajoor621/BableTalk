import { Buffer } from 'buffer';
import { Pipeline } from '../src/audio/pipeline';
import Capture from '../src/audio/capture';
import { initWhisper } from 'whisper.rn/index';
import { Silero } from '../src/audio/silero';
let mockAudio: (data: string) => void;
const mockRemove = jest.fn();
const mockVadRelease = jest.fn();
const mockWhisperRelease = jest.fn();
const mockTranscribe = jest.fn();
jest.mock('../src/audio/capture', () => ({
  __esModule: true,
  default: {
    init: jest.fn(),
    start: jest.fn(),
    stop: jest.fn(),
    on: jest.fn((_event, fn) => {
      mockAudio = fn;
      return { remove: mockRemove };
    }),
  },
}));
jest.mock('../src/linguistics/mms', () => ({ MmsLid: { create: jest.fn() } }));
jest.mock('../src/models/store', () => ({
  setCaptureActive: jest.fn(),
  verifyModels: jest.fn(async () => ({ vad: 'v', whisper: 'w' })),
}));
jest.mock('../src/audio/silero', () => ({ Silero: { create: jest.fn() } }));
jest.mock('whisper.rn/index', () => ({ initWhisper: jest.fn() }));
const settle = () => new Promise<void>(resolve => setImmediate(resolve));
beforeEach(() => {
  jest.clearAllMocks();
  (Silero.create as jest.Mock).mockResolvedValue({
    probability: async () => 0.9,
    release: mockVadRelease,
  });
  mockTranscribe.mockReturnValue({
    promise: Promise.resolve({ result: ' Hello offline. ' }),
  });
  (initWhisper as jest.Mock).mockResolvedValue({
    transcribeData: mockTranscribe,
    release: mockWhisperRelease,
  });
});
function setup() {
  const callbacks = { onText: jest.fn(), onVad: jest.fn(), onError: jest.fn() };
  return { pipeline: new Pipeline(callbacks), ...callbacks };
}
it('captures requested format and flushes final words before release', async () => {
  const { pipeline, onText } = setup();
  await pipeline.start();
  expect(Capture.init).toHaveBeenCalledWith(
    expect.objectContaining({
      sampleRate: 16000,
      channels: 1,
      bitsPerSample: 16,
    }),
  );
  mockAudio(Buffer.alloc(512 * 2 * 10).toString('base64'));
  await pipeline.stop();
  expect(onText).toHaveBeenCalledWith(
    expect.objectContaining({ text: 'Hello offline.', reason: 'stop' }),
  );
  const data = mockTranscribe.mock.calls[0][0] as ArrayBuffer;
  expect(data.byteLength).toBe(10 * 512 * 4);
  expect(mockWhisperRelease).toHaveBeenCalledTimes(1);
  expect(mockVadRelease).toHaveBeenCalledTimes(1);
  await pipeline.stop();
  expect(mockWhisperRelease).toHaveBeenCalledTimes(1);
});
it('rejects capture overflow visibly and releases resources', async () => {
  const { pipeline, onError } = setup();
  await pipeline.start();
  mockAudio(Buffer.alloc(512 * 2 * 65).toString('base64'));
  expect(onError).toHaveBeenCalledWith(
    expect.objectContaining({
      message: expect.stringContaining('cannot keep up'),
    }),
  );
  await pipeline.stop(false);
  expect(mockRemove).toHaveBeenCalledTimes(1);
});
it('releases VAD if Whisper initialisation fails', async () => {
  (initWhisper as jest.Mock).mockRejectedValueOnce(new Error('bad model'));
  const { pipeline } = setup();
  await expect(pipeline.start()).rejects.toThrow('bad model');
  expect(mockVadRelease).toHaveBeenCalledTimes(1);
});
it('releases both models when native transcription rejects', async () => {
  mockTranscribe.mockImplementation(() => ({
    promise: Promise.reject(new Error('native decode failed')),
  }));
  const { pipeline, onError } = setup();
  await pipeline.start();
  mockAudio(Buffer.alloc(512 * 2 * 10).toString('base64'));
  await settle();
  await pipeline.stop();
  expect(onError).toHaveBeenCalled();
  expect(mockVadRelease).toHaveBeenCalledTimes(1);
  expect(mockWhisperRelease).toHaveBeenCalledTimes(1);
});
