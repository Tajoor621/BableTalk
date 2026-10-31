#!/usr/bin/env python3
"""Run the real locked Silero model on a 16 kHz mono PCM16 WAV; development QA only."""
import os
os.environ['ORT_DISABLE_TELEMETRY'] = '1'
os.environ['HF_HUB_DISABLE_TELEMETRY'] = '1'
import argparse
from pathlib import Path
import wave
import numpy as np
import onnxruntime as ort
ort.disable_telemetry_events()

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('wav', type=Path)
args = parser.parse_args()
with wave.open(str(args.wav), 'rb') as src:
    if (src.getframerate(), src.getnchannels(), src.getsampwidth()) != (16000, 1, 2):
        raise ValueError('Expected 16 kHz mono PCM16 WAV')
    audio = np.frombuffer(src.readframes(src.getnframes()), dtype='<i2').astype(np.float32) / 32768
model = Path(__file__).resolve().parents[1] / 'models/silero_vad.onnx'
session = ort.InferenceSession(str(model), providers=['CPUExecutionProvider'])
state = np.zeros((2, 1, 128), dtype=np.float32)
context = np.zeros(64, dtype=np.float32)
probabilities = []
for index in range(0, len(audio), 512):
    frame = np.zeros(512, dtype=np.float32)
    chunk = audio[index:index + 512]
    frame[:len(chunk)] = chunk
    output, state = session.run(None, {'input': np.concatenate((context, frame))[None, :], 'state': state, 'sr': np.array(16000, dtype=np.int64)})
    context = frame[-64:]
    probabilities.append(float(output[0, 0]))
assert probabilities and all(np.isfinite(probabilities))
assert max(probabilities) > 0.6, 'No speech detected in speech fixture'
print(f'{len(probabilities)} frames; peak speech probability {max(probabilities):.4f}; speech frames {sum(p > .6 for p in probabilities)}')
