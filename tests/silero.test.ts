import { InferenceSession, Tensor } from 'onnxruntime-react-native';
import { Silero } from '../src/audio/silero';
const mockRun = jest.fn();
const mockRelease = jest.fn();
jest.mock('onnxruntime-react-native', () => ({
  Tensor: jest
    .fn()
    .mockImplementation((type, data, dims) => ({ type, data, dims })),
  InferenceSession: { create: jest.fn() },
}));
it('chains recurrent state and exactly 64 context samples across 512-sample frames', async () => {
  const next = new Tensor(
    'float32',
    new Float32Array(256).fill(1),
    [2, 1, 128],
  );
  mockRun.mockResolvedValue({
    output: new Tensor('float32', new Float32Array([0.8]), [1, 1]),
    stateN: next,
  });
  (InferenceSession.create as jest.Mock).mockResolvedValue({
    run: mockRun,
    release: mockRelease,
  });
  const vad = await Silero.create('model.onnx');
  await vad.probability(new Float32Array(512).fill(0.5));
  let input = mockRun.mock.calls[0][0];
  expect(input.input.dims).toEqual([1, 576]);
  expect(input.input.data.slice(0, 64)).toEqual(new Float32Array(64));
  expect(input.state.dims).toEqual([2, 1, 128]);
  expect(input.sr.data[0]).toBe(16000n);
  await vad.probability(new Float32Array(512).fill(0.25));
  input = mockRun.mock.calls[1][0];
  expect(input.input.data.slice(0, 64)).toEqual(new Float32Array(64).fill(0.5));
  expect(input.state).toBe(next);
  await vad.release();
  expect(mockRelease).toHaveBeenCalledTimes(1);
});
