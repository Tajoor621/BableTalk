# BabelTalk

Native Android/iOS face-to-face conversation assistant. No API keys, accounts or
cloud speech/translation calls. Initial speech and translation-model downloads
require a connection; conversation inference runs locally once prepared.

## Current implementation

- 16 kHz mono PCM16 capture, Silero ONNX streaming VAD, multilingual quantised
  Whisper base for English/Urdu/Arabic, and experimental Pashto transcription.
- English↔Urdu↔Arabic on-device ML Kit translation. Pashto translation is explicitly
  unavailable: an English pivot cannot create a missing Pashto model.
- Explicit speaker A/B turns, Stop & translate, bilingual text, correct-and-retranslate,
  sentence-by-sentence system TTS, and explicit Play controls. Recording stops
  before playback, so speaker output is not fed back into recognition.
- Private headphone output for B→A; phone speaker output for A→B. A failed private
  route returns an error instead of speaking publicly. Users may explicitly select
  speaker output for their own listening.
- Persistent private SQLite sessions, interrupted-session visibility, user-controlled
  JSON/text sharing, and deletion. Audio is held in RAM, not written as recordings.
- In-app speech-model download/repair with immutable URLs, size and SHA-256 checks;
  explicit Wi-Fi translation downloads; installed voice listing; actionable errors.
- Optional MMS-LID-126 audio classifier with top-k predictions and conservative
  ambiguity handling. Manual per-speaker language selection works without it.
- Source CI plus native Android/iOS build workflows. See Actions for actual build
  results; neither JavaScript bundles nor mocked tests certify phone behaviour.

This is a development application, not a qualified production interpreter. Native
builds, real-device language accuracy, headset routing, battery and sustained
latency must pass `docs/DEVICE_ACCEPTANCE.md`. The earlier Phase 1 device gate is
still unfulfilled; later capabilities are implemented for development testing,
not presented as device-qualified releases. No published benchmark is claimed
as this application's accuracy.

## Linguistic choices

Use one language per turn and correct recognition before playing translations.
Short/mixed Urdu and Hindi speech can be ambiguous. Names, amounts, dates and
negation need confirmation. MMS scores are uncalibrated model scores, not ASR
or translation certainty. A confident language mismatch holds translation for
review; it never silently switches the session pair.

The requested MMS checkpoint has one billion parameters and is approximately
974 MB even in the quantised ONNX pack. It is optional because forcing it into
every phone turn would undermine latency and memory limits. Its licence is
CC-BY-NC-4.0; review that restriction before enabling or distributing it.

Urdu, Pashto and English have no dialect classifier here. Arabic dialect labels
need a separately qualified Nawah pack and sufficient context; its model card
warns about inputs shorter than approximately 25 words. Dialect→MSA is not a
lookup-table substitution. This app preserves original text rather than
inventing an MSA paraphrase. On-device baseline translation may struggle with
colloquial Arabic; request a rephrase in MSA or correct the recognised words.

Specialised Urdu/Arabic Whisper checkpoints and MOSS/Kitten voices remain
qualification work. The running baseline uses multilingual Whisper and available
system voices. It does not claim those specialised models are integrated.

## Setup

Requirements: Node 22.11+, npm, Python 3.10+, and appropriate native tooling.
Android uses JDK 17, SDK/build tools 36, NDK 27.1.12297006 and CMake 3.22.1.
iOS requires macOS, compatible Xcode and CocoaPods. Native identifiers are
`com.babeltalk`; repository spelling is intentionally `BableTalk`.

```sh
npm ci
npm run typecheck
npm run lint -- --max-warnings=0
npm test
npm run android
# On macOS:
cd ios
pod install
cd ..
npm run ios
```

Open Models, download speech models (~63 MB), select the desired A/B languages,
and Prepare selected pair on Wi-Fi. ML Kit manages translation-model integrity
through its SDK; those proprietary weights are not part of the open-source
speech-model lock. An installed matching system voice is needed for playback;
translated text remains available when a voice is missing. No speech synthesis
service key is needed. Test voice availability in airplane mode.

For an independent Android test build with embedded JavaScript:

```sh
cd android
./gradlew assembleRelease -PreactNativeArchitectures=arm64-v8a
adb install -r app/build/outputs/apk/release/app-release.apk
```

The template uses the public development signing key. This is a development-test
APK; replace signing and complete privacy/licence/device qualification before
public distribution. GitHub Actions uploads this test APK when native builds
succeed. There is no web app or GitHub Pages deployment: these are native audio
modules, not browser APIs.

The `offlineQa` variant removes Android INTERNET permission completely and is
debuggable for preloading speech weights with `npm run models:android`; ML Kit
translation packs must also be prepared separately before a network-denied test.
Normal release permits explicit first-run model downloads. The inference path
never calls a model downloader or cloud translator. SDK operational metadata
is governed by Google's SDK terms; no transcript is passed to a network endpoint
by BabelTalk. Verify network behaviour in device qualification.

`npm ci` applies small idempotent namespace fixes to the two pinned legacy RN
modules in `scripts/native-compat.cjs`. Review them when changing versions.

## Scripted model installation

```sh
npm run models:download
python3 scripts/models.py verify
npm run models:android
# Optional, ~974 MB extra, non-commercial MMS licence:
python3 scripts/models.py download --mms
python3 scripts/models.py install-android --mms
```

Android run-as installation requires a debuggable build. Models go in its private
files/models directory. For iOS development, use Xcode Devices and Simulators to
replace the debug app container with verified weights in AppData/Documents/models;
simulator containers can be located with `xcrun simctl get_app_container booted
com.babeltalk data`. Most users should use the in-app downloader instead.

MMS is already converted to ONNX by the pinned Xenova pack; Silero is already
ONNX, and Whisper is already GGML quantised. No conversion is needed for those
locked files. The original English-only Phase 1 model remains supported by the
pipeline default and developer model installer.

## Storage and privacy

The schema is initialised by `src/storage/sessions.ts` through native SQLite.
SQL values are parameterised; writes are serialised. A crash can leave an open
session and a pending utterance, which remain visible in saved history.

Android disables backups. iOS stores the database in an Application Support
folder excluded from backups and uses OS file protection. The app does not add
its own database encryption: protect the device with a screen lock. No audio
is persisted. The most recent 500 turns are shown during a session; the database
retains the full record. Saved-session list currently shows the latest 200.
Only an explicit Export action opens the operating-system share sheet.

## Hardware and remaining qualification

One OS-selected microphone is used at a time. Two simultaneous physical phone
and headset inputs are not assumed. Both people can use the phone microphone;
explicit speaker ownership prevents guessing who spoke. Android 12+ selects
communication devices; Android 7–11 supports explicit wired output in this build.
Legacy Bluetooth routing needs further device-specific implementation. iOS uses
AVAudioSession output overrides and checks that the private output exists.

The app stops recording when backgrounded or interrupted. Test calls, screen locks,
headset unplugging, Bluetooth changes, rapid taps and low memory. The <3 s and
one-hour goals are targets, not measured results. Pashto speech quality is
experimental; do not substitute model-paper WER for conversational performance.

## Authoritative references

- https://developers.google.com/ml-kit/language/translation/android
- https://developers.google.com/ml-kit/language/translation/ios
- https://developers.google.com/ml-kit/language/translation/translation-language-support
- https://huggingface.co/facebook/mms-lid-126
- https://huggingface.co/Xenova/mms-lid-126
- https://huggingface.co/oddadmix/Nawah-Dialect-BERT-6M
- https://github.com/mybigday/whisper.rn
- https://github.com/snakers4/silero-vad
- https://huggingface.co/ggerganov/whisper.cpp

ML Kit and system TTS are practical mobile alternatives to a Python/LibreTranslate
server; they are not representations of those requested open-source runtimes.
No laptop/LAN inference bridge is used, because sending transcript text to it
would violate the no-device-egress requirement.
