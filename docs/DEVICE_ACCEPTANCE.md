# Phase 1 physical-device gate

Status: NOT RUN. Do not mark Phase 1 device-qualified until actual evidence is
recorded. A desktop unit test, bundle, or emulator screenshot is insufficient.

Record phone model, OS, build/commit, model SHA-256, temperature, initial battery,
headset/input route, test duration and elapsed times. Obtain both speakers'
consent. Do not collect or upload audio without explicit agreement.

1. Fresh install: denied microphone permission, permanently denied permission,
   missing model, truncated model, wrong hash, repeated start tap. Each must
   leave the microphone off and show an actionable message.
2. With verified weights: 30 seconds silence, then 20 English sentences from
   multiple speakers. Include short words, quiet speech, loud speech and pauses.
   Check that silence does not generate text and first/last syllables survive.
   Include a brief accidental sound below 256 ms and continuous speech >12 s.
3. Compare manually against consented reference text. Report substitutions,
   insertions and deletions, WER=(S+D+I)/reference-word-count, sample count and
   recording conditions. Set an acceptance threshold for the intended use case;
   do not claim general accuracy from one speaker or a scripted fixture.
4. Tap End during speech and while decoding. Confirm final words appear once,
   the native microphone indicator extinguishes and a new session works.
5. Receive a call; background/lock/unlock the phone; connect/disconnect wired and
   Bluetooth headsets. Confirm safe stopping or visible watchdog error; inspect
   actual input route. Reopen/restart repeatedly and look for leaked resources.
6. Stress a low-memory device. Measure VAD and ASR throughput. Overload must
   produce a visible error rather than an unbounded queue or silent speech loss.
7. Embedded-JavaScript build, airplane mode, Wi-Fi/mobile data disabled: start
   and end sessions repeatedly. Verify no transcript/audio network traffic.
8. Screen reader, large text, dark/light system settings, rotation, permission
   alerts: verify every control is usable. Review contrast and live announcements
   with a person using assistive technology.
9. Run 60 minutes with representative speech/silence patterns. Record battery
   drain, heat, memory, crashes and p50/p95 recognition delays. This is a Phase 1
   baseline; the full-pipeline one-hour target must be retested in Phase 7.

The displayed processing time includes ASR queue + recognition after endpointing.
It excludes the ~512 ms silence endpoint and future translation/TTS. It cannot
establish the final <3-second end-of-speech-to-translated-audio requirement.

Advance to Phase 2 only when Android and iOS Phase 1 device evidence is reviewed.
Do not substitute guessed test results or published model benchmark numbers.

## Full conversation development gate

- On the installed APK/iPhone build, download speech and translation models once,
  then repeat English↔Urdu and English↔Arabic conversations with networking off.
- Verify both typed and spoken input; long turns must segment without dropping
  words. Review originals and translations with independent bilingual speakers.
- Confirm B→A headphones and A→B speaker, including headphone disconnect DURING
  playback. Check for route leakage; a startup-only route check is insufficient.
- Confirm Stop playback, backgrounding, incoming calls and rapid start/stop during
  model initialisation. A cancelled start must not leave capture active.
- Verify corrections regenerate translation; simulate missing/corrupt models,
  unavailable voice, unsupported Pashto pair and mismatched language detection.
- Enable Nawah and provide at least 25 words from the SAME speaker. Confirm short
  or uncertain input has no label, and Urdu/Pashto never acquire dialect labels.
- Kill/reopen the app during a session: saved pending/open records must survive.
  Test actual JSON/TXT export files and deletion; inspect SQLite foreign keys.
- Measure separately: endpoint delay, ASR queue/inference, LID, dialect, translation,
  user review delay, TTS first audio, end-to-end delay, battery and temperature.
  Manual review time must not be hidden inside a claimed sub-three-second result.
