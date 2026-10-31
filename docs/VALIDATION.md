# Validation — 31 October 2026

This source delivery is Phase 1. It has not been certified production-ready.

Executed in a Linux development environment:

- TypeScript strict project checking.
- Jest: 16 passing tests across five suites. PCM decoding at split byte boundaries, short/no-speech rejection,
  pre-roll/endpoint trimming, final-turn flushing, 12-second segmentation,
  model integrity rejection, Silero context/recurrent tensor protocol, native
  initialisation failure cleanup, capture overflow and ASR failure cleanup,
  idempotent shutdown, and UI capability labelling. Native bindings are mocked
  in Jest; those tests validate orchestration rather than native audio/inference.
- ESLint with zero warnings allowed.
- Metro production JavaScript bundle generation for Android and iOS.
- Download and SHA-256/size verification of both locked model weights.
- Real Silero v5.1.2 ONNX desktop CPU inference using the upstream whisper.cpp
  `samples/jfk.wav` (16 kHz mono PCM16). 344 frames; 208 above probability 0.6;
  peak 0.9976. This confirms the input/state protocol can detect speech on a
  known fixture, not conversational WER, routing, or robustness.

Not executed here:

- Gradle/CMake Android native build: no Android SDK/NDK/device in the environment.
- Xcode/CocoaPods iOS native build: no macOS/Xcode/device in the environment.
- Native mobile ONNX and Whisper execution, physical microphone/headset routing,
  interruption recovery, speech accuracy, sustained latency, one-hour battery,
  thermal behaviour or assistive-technology acceptance.
- Translation, LID, dialect classification, TTS, SQLite or exports: future phases.

CI in `.github/workflows/verify.yml` repeats source checks and both JavaScript
bundles when the project is placed in a repository. It does not imply a native
build or a real-device test has passed.
