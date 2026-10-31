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
