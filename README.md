# BabelTalk — Phase 1 foundation

A native React Native project for private, face-to-face conversation assistance.
**This delivery implements Phase 1 only: microphone → Silero ONNX VAD → English
Whisper transcription → live text. It is a development foundation, not a
production-qualified translator.** The remaining phases are deliberately gated
on the real-device checks in `docs/DEVICE_ACCEPTANCE.md`.

## Implemented

- Android and iOS native projects, React Native 0.84.1 / TypeScript.
- Requested capture format: 16 kHz, mono, signed PCM16 little-endian. Capture
  callbacks become normalised float32 samples before inference.
- Silero v5.1.2 through ONNX Runtime: 512-sample frames, previous 64 samples as
  context, recurrent `[2,1,128]` state, fresh state for every session.
- 192 ms pre-roll; speech starts at probability 0.6; continuation threshold 0.45;
  approximately 512 ms silence to close a turn; 256 ms minimum speech; 12-second
  maximum utterance. Thresholds are provisional until device calibration.
- `whisper.cpp` through `whisper.rn`, quantised `base.en-q5_1`, English token,
  CPU inference with two threads. No simulated transcripts or platform cloud STT.
- Start/End controls, live transcript, VAD indicator, visible errors, final-turn
  flushing, background stopping, native resource cleanup, input watchdog and
  bounded processing queues. Overload stops capture with an explicit error.
- SHA-256 + size verification before microphone capture, scripted model
  installation, source CI, unit tests and real-model desktop VAD smoke check.
- No analytics, accounts, keys, speech uploads or audio files. The live view holds
  only the latest 500 turns in memory. This phase has **no saved sessions/export**.

## Requirements

- Node 22.11+ and npm; Python 3.10+ for model scripts.
- Android: JDK 17, Android Studio/SDK 36, build tools 36.0.0, NDK 27.1.12297006,
  CMake as requested by native dependencies, a physical Android 7+ device. Use a
  modern Android 10+ phone with adequate RAM for meaningful performance tests.
- iOS: macOS, compatible Xcode and CocoaPods/Bundler; iOS 15.1+ project target,
  physical iPhone for audio testing. A simulator is useful only for build/UI work.
- About 63 MB of Phase 1 model files; substantially more RAM is needed at runtime.
  No latency or battery claim is certified by this delivery.

## Install dependencies and models

```sh
npm ci
npm run models:download
python3 scripts/models.py verify
npm run typecheck
npm test
npm run lint -- --max-warnings=0
```

The download script uses fixed model URLs and checks sizes and hashes from
`models.lock.json`. Downloads go to ignored `models/` and are atomically renamed
only after verification. Models and node_modules are not included in the source
archive. The mobile app has no downloader; initial installation is a development
step. An in-app verified download/import screen belongs to Phase 7.

Phase 1 uses an existing ONNX model and an existing quantised GGML model, so no
ONNX conversion or Whisper quantisation is needed. Do not rename a Hugging Face
checkpoint or a PEFT adapter to `.bin`; that does not create a whisper.cpp model.

## Android

Connect a phone with USB debugging enabled and confirm `adb devices` lists it.

```sh
npm run android
# Once the app is installed, copy verified weights into its private files area:
npm run models:android
# Multiple attached devices: python3 scripts/models.py install-android --serial SERIAL
npm start
```

`models:android` uses `run-as com.babeltalk`, so it is for the debug build only.
If the app was already open, return to it and tap **Start English session**.
Grant microphone permission. Speak in short English sentences, pause, then tap
**End session**. The last words should appear before the microphone-off state.
A missing/corrupt model produces an actionable error before capture.

For a Metro development session use `adb reverse tcp:8081 tcp:8081` if necessary.
For genuinely offline operation, use the embedded-JavaScript QA variant:

```sh
cd android
./gradlew assembleOfflineQa
adb install -r app/build/outputs/apk/offlineQa/app-offlineQa.apk
cd ..
npm run models:android
```

`offlineQa` includes the JavaScript bundle, disables React Native developer
support and removes network permission, while remaining debuggable for private
model installation. It uses the public development signing key. This is a
**development test build**, not a distributable production release. A signed
production release needs a private model importer, release signing and physical
device qualification. `./gradlew assembleRelease` builds the template release,
which cannot receive models with run-as. Both the release and offlineQa
manifests explicitly remove network permission. The debug manifest permits Metro
networking only. External storage permission inherited from RNFS is removed.

`postinstall` runs the small idempotent `scripts/native-compat.cjs` to add missing
AGP namespaces to the two pinned legacy modules. No app source is downloaded or
modified by that patch. Changes to these dependency versions require reviewing it.

## iOS

```sh
bundle install
cd ios
bundle exec pod install
cd ..
npm run ios
```

Open `ios/BabelTalk.xcworkspace` to select your signing team and physical iPhone;
the bundle identifier is `com.babeltalk`. Only the microphone permission handler
is enabled. The app never requests Apple Speech Recognition permission.

Install the same two verified weights into the app's **Documents/models/**
directory before recording:

- Simulator: obtain its container using
  `xcrun simctl get_app_container booted com.babeltalk data`, then create
  `Documents/models` inside it and copy both files from local `models/`.
- Physical iPhone: in Xcode Devices and Simulators, download the installed debug
  app container; add the files under `AppData/Documents/models`; replace the
  container and relaunch. Do this only with this app's development container.

Build the Release scheme with its bundled JavaScript for airplane-mode tests;
a Metro-connected debug launch alone does not prove offline operation. File
installation and signing are developer steps in this phase. iOS does not expose
an equivalent to Android's remove-INTERNET permission; privacy relies on the app
having no inference-networking code, and must also be verified on a phone.

## Verification and evidence

See `docs/VALIDATION.md` for the exact executed checks and limitations. To run the
optional desktop smoke check on a speech fixture:

```sh
python3 -m pip install numpy onnxruntime
# Supply a local 16 kHz mono PCM16 speech WAV, not a compressed audio file.
python3 scripts/check_vad.py /path/to/speech.wav
```

This executes the real locked Silero model on desktop; it does not certify
mobile ONNX execution or end-to-end speech accuracy. Native release builds,
real-device accuracy, power, routing and accessibility remain qualification work.

## Next phases — keep this order

| Phase | Scope | Entry/exit gate |
|---|---|---|
| 1 | English capture, ONNX Silero, Whisper text | Physical-device VAD boundaries, accuracy and interruption checks |
| 2 | MMS-LID-126 | Validate ISO codes/top-k calibration on independent English/Urdu/Arabic/Pashto speech |
| 3 | Urdu ASR, English↔Urdu translation, English TTS | Verified model licences, mobile runtime, one-way offline device test |
| 4 | Arabic ASR and text dialect classifier | ASR precedes text classification; benchmark dialect labels and MSA normalisation |
| 5 | Pashto baseline | Honest lower-quality indicator; verify offline translation and TTS coverage first |
| 6 | Reverse direction, SQLite, exports | Explicit turn ownership, route tests, transactions and user-controlled export |
| 7 | Model manager, accessibility, polish | Hour-long battery run, offline integrity, release signing, real-device acceptance |

The later models named in the brief are candidate integrations, not implemented
or independently certified here. Model availability, language coverage, licences
and published metrics must be checked against the actual immutable checkpoint.
Urdu/Pashto/English must not receive invented dialect labels. A language-ID score
must not be displayed as ASR/translation certainty.

LibreTranslate/Argos on a laptop is **not** the final private on-device core:
sending speech or text to a LAN server would breach the brief's no-device-egress
rule. Production translation needs a proven mobile-compatible model/runtime.
An English pivot cannot create missing Pashto models. Dialect classification
does not itself produce a correct MSA paraphrase. Unsupported pairs must remain
explicitly unavailable rather than silently using a cloud service.

Independent phone/headset input streams and per-utterance headphone/speaker
output are hardware/OS-dependent. Phase 6 must validate explicit turn-based
routing on both platforms; Phase 1 records one OS-selected input only.

## Sources and licences

- React Native setup: https://reactnative.dev/docs/set-up-your-environment
- whisper.rn API/source: https://github.com/mybigday/whisper.rn
- PCM native module: https://github.com/mybigday/react-native-audio-pcm-stream
- Silero reference recurrent/context protocol:
  https://github.com/snakers4/silero-vad/blob/v5.1.2/src/silero_vad/utils_vad.py
- English quantised weights: https://huggingface.co/ggerganov/whisper.cpp
- ONNX Runtime React Native: https://github.com/microsoft/onnxruntime/tree/main/js/react_native

Silero and Whisper weights are MIT licensed according to their upstream
repositories. ONNX Runtime, whisper.rn and other dependencies retain their own
licences; perform a dependency/model notice review before distribution. Download
model weights from their upstream locations using the included lock file.
