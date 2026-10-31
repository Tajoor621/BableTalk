import { NativeEventEmitter, NativeModules } from 'react-native';
// The upstream package's .d.ts declares a different package name; use its native API directly.
type PcmModule = {
  init(options: {
    sampleRate: number;
    channels: number;
    bitsPerSample: number;
    audioSource: number;
    bufferSize: number;
  }): Promise<void> | void;
  start(): void;
  stop(): Promise<void>;
  addListener(event: string): void;
  removeListeners(count: number): void;
};
const native = NativeModules.RNLiveAudioStream as PcmModule | undefined;
export default {
  async init(options: Parameters<PcmModule['init']>[0]) {
    if (!native) {
      throw new Error(
        'Native microphone module unavailable. Rebuild the native app.',
      );
    }
    await native.init(options);
  },
  start() {
    native!.start();
  },
  async stop() {
    await native?.stop();
  },
  on(_event: 'data', callback: (data: string) => void) {
    return new NativeEventEmitter(native).addListener('data', callback);
  },
};
