import LiveAudioStream from './capture';
import { Buffer } from 'buffer';
import { initWhisper, WhisperContext } from 'whisper.rn/index';
import { Silero } from './silero';
import { PcmFramer, Segmenter, SpeechSegment } from './segmenter';
import { verifyModels, setCaptureActive } from '../models/store';
import { Language, languages } from '../linguistics/languages';
import { MmsLid } from '../linguistics/mms';
export type Transcript = {
  id: number;
  text: string;
  endMs: number;
  processingMs: number;
  reason: string;
  detectedLanguage?: Language;
  languageMethod?: 'selected' | 'mms';
  warning?: string;
};
export type Callbacks = {
  onText: (value: Transcript) => void;
  onVad: (p: number, speaking: boolean) => void;
  onError: (error: Error) => void;
};
export class Pipeline {
  private vad?: Silero;
  private lid?: MmsLid;
  private whisper?: WhisperContext;
  private framer = new PcmFramer();
  private segmenter = new Segmenter();
  private frames: Float32Array[] = [];
  private speech: { segment: SpeechSegment; at: number }[] = [];
  private accepting = false;
  private pump?: Promise<void>;
  private decoding?: Promise<void>;
  private subscription?: { remove(): void };
  private failed = false;
  private id = 0;
  private watchdog?: ReturnType<typeof setInterval>;
  private lastFrame = 0;
  private closing?: Promise<void>;
  private initialization?: Promise<void>;
  private stopRequested = false;
  constructor(
    private callbacks: Callbacks,
    private options: { language?: Language; useMms?: boolean } = {},
  ) {
    this.segmenter = new Segmenter(options.language ? 4 : 8);
  }
  start(): Promise<void> {
    if (this.stopRequested) {
      return Promise.reject(new Error('Recording was cancelled'));
    }
    if (!this.initialization) {
      this.initialization = this.initialize();
    }
    return this.initialization.catch(async e => {
      await this.stop(false);
      throw e;
    });
  }
  private assertOpen() {
    if (this.stopRequested) {
      throw new Error('Recording was cancelled before microphone start');
    }
  }
  private async initialize() {
    setCaptureActive(true);
    const paths = await verifyModels(
      this.options.language ? 'multilingual' : 'english',
    );
    this.assertOpen();
    if (this.options.useMms) {
      this.lid = await MmsLid.create();
    }
    this.assertOpen();
    this.vad = await Silero.create(paths.vad);
    this.assertOpen();
    this.whisper = await initWhisper({
      filePath: paths.whisper,
      useGpu: false,
    });
    this.assertOpen();
    LiveAudioStream.init({
      sampleRate: 16000,
      channels: 1,
      bitsPerSample: 16,
      audioSource: 6,
      bufferSize: 2048,
    });
    this.assertOpen();
    this.accepting = true;
    this.lastFrame = Date.now();
    this.watchdog = setInterval(() => {
      if (Date.now() - this.lastFrame > 5000) {
        this.fail(
          new Error(
            'Microphone stopped delivering audio. Check interruptions, permissions and input route.',
          ),
        );
      }
    }, 1000);
    this.subscription = LiveAudioStream.on('data', (base64: string) => {
      if (!this.accepting) {
        return;
      }
      this.lastFrame = Date.now();
      try {
        this.frames.push(...this.framer.push(Buffer.from(base64, 'base64')));
        if (this.frames.length > 64) {
          throw new Error(
            'VAD cannot keep up. Session stopped; no audio silently discarded.',
          );
        }
        this.runVad();
      } catch (e) {
        this.fail(e);
      }
    });
    LiveAudioStream.start();
  }
  private fail(error: unknown) {
    if (this.failed) {
      return;
    }
    this.failed = true;
    this.accepting = false;
    LiveAudioStream.stop();
    this.callbacks.onError(
      error instanceof Error ? error : new Error(String(error)),
    );
  }
  private runVad() {
    if (this.pump) {
      return;
    }
    this.pump = this.processFrames()
      .catch(e => this.fail(e))
      .finally(() => {
        this.pump = undefined;
      });
  }
  private async processFrames() {
    while (this.frames.length && !this.failed) {
      const frame = this.frames.shift()!;
      const p = await this.vad!.probability(frame);
      const segment = this.segmenter.push(frame, p);
      this.callbacks.onVad(p, this.segmenter.active);
      if (segment) {
        this.enqueue(segment);
      }
    }
  }
  private enqueue(segment: SpeechSegment) {
    if (this.speech.length >= 3) {
      throw new Error(
        'Transcription backlog exceeded. Stop and use shorter turns on this device.',
      );
    }
    this.speech.push({ segment, at: Date.now() });
    if (!this.decoding) {
      this.decoding = this.decode()
        .catch(e => this.fail(e))
        .finally(() => {
          this.decoding = undefined;
        });
    }
  }
  private async decode() {
    while (this.speech.length && !this.failed) {
      const { segment, at } = this.speech.shift()!;
      // Whisper expects float32 PCM, NOT raw PCM16. Frames have already been normalised.
      let detectedLanguage: Language | undefined;
      let warning = '';
      if (this.lid) {
        const result = await this.lid.identify(segment.samples);
        detectedLanguage = result.language;
        if (!detectedLanguage) {
          warning =
            'Audio language identification is uncertain. Confirm the selected language.';
        }
      }
      const selected = this.options.language || 'eng';
      const route = detectedLanguage || selected;
      const task = this.whisper!.transcribeData(
        segment.samples.buffer as ArrayBuffer,
        { language: languages[route].tag, translate: false, maxThreads: 2 },
      );
      const result = await task.promise;
      const text = result.result.trim();
      if (text) {
        this.callbacks.onText({
          id: this.id++,
          text,
          endMs: segment.endSample / 16,
          processingMs: Date.now() - at,
          reason: segment.reason,
          detectedLanguage,
          languageMethod: detectedLanguage ? 'mms' : 'selected',
          warning,
        });
      }
    }
  }
  stop(flush = true): Promise<void> {
    this.stopRequested = true;
    this.accepting = false;
    if (this.subscription) {
      LiveAudioStream.stop();
    }
    if (!this.closing) {
      this.closing = (async () => {
        await this.initialization?.catch(() => {});
        await this.close(flush);
      })();
    }
    return this.closing;
  }
  private async close(flush: boolean) {
    if (this.watchdog) {
      clearInterval(this.watchdog);
      this.watchdog = undefined;
    }
    this.accepting = false;
    if (this.subscription) {
      LiveAudioStream.stop();
      this.subscription.remove();
      this.subscription = undefined;
    }
    try {
      await this.pump;
      if (flush && !this.failed && this.vad && this.whisper) {
        const tail = this.framer.flush();
        if (tail) {
          this.frames.push(tail);
        }
        await this.processFrames();
        const segment = this.segmenter.flush();
        if (segment) {
          this.enqueue(segment);
        }
      }
      await this.decoding;
    } finally {
      await this.decoding;
      this.frames = [];
      this.speech = [];
      const whisper = this.whisper;
      this.whisper = undefined;
      const lid = this.lid;
      this.lid = undefined;
      const vad = this.vad;
      this.vad = undefined;
      try {
        await whisper?.release();
      } finally {
        try {
          await vad?.release();
        } finally {
          try {
            await lid?.release();
          } finally {
            setCaptureActive(false);
          }
        }
      }
    }
  }
}
