# BableTalk development verification — 31 October 2026

The application now implements an offline mobile conversation workflow beyond
the original English-only foundation. The earlier physical-device gate has not
been passed; these integrations are for development qualification.

Executed locally:

- TypeScript and zero-warning lint; 41 Jest tests covering PCM, VAD context,
  capture cancellation during startup, short-reply boundaries, awaited native microphone init/stop, cleanup, language mappings, ambiguity,
  two-way translation direction, private-output failure, transcript retention,
  user corrections, queue finalisation, Arabic-only dialect eligibility, JSON
  export, and byte-level tokenisation.
- Actual SQLite schema, parameterised Unicode round-trip, foreign-key enforcement
  and cascading deletion through Python SQLite (not a mocked database).
- Actual Nawah PyTorch→ONNX export with fixed weights, mean pooling, source hash
  checks, and numerical logit parity on multiple sequence lengths. Mobile byte-BPE
  token IDs match the reference tokenizer on Arabic, diacritics and mixed text.
- Earlier actual Silero ONNX desktop inference on the whisper.cpp JFK fixture:
  344 frames; 208 above 0.6; peak 0.9976. This is a protocol smoke check only.

Jest native bindings are mocked. Those tests establish orchestration, not physical
microphone behaviour or an independent linguistic accuracy score. Source CI omits
the full generated model pack; its full-tokenizer parity test runs in native CI
with the generated pack present.

Native GitHub builds are required. The first builds identified and fixed SDK
setup, iOS minimum target, Gradle API compatibility and a native ML Kit selector
issue. Check the current commit's Actions results rather than treating an earlier
successful source job as a native build qualification.

ONNX model-export telemetry was blocked by automatic review. The safer rerun set
the documented process-lifetime telemetry opt-out before runtime initialisation
and passed. Both mobile runtimes also disable ONNX telemetry before creating the
inference environment. This does not substitute for device network verification.

Still unverified: physical Android/iPhone audio, route changes, system voice
availability, real conversational WER/translation adequacy/dialect calibration,
p50/p95 end-of-speech latency, one-hour battery, low-memory behaviour, accessibility
with assistive technology, and real-user bilingual comprehension. Pashto
translation is unavailable. Specialised Urdu/Arabic ASR and bundled neural TTS
are not represented as completed integrations.
