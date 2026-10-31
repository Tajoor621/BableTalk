#!/usr/bin/env python3
"""Phase 1 model acquisition. No network activity occurs in the mobile app."""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
MODELS = ROOT / 'models'
LOCK = ROOT / 'models.lock.json'

def verify(path, model):
    if not path.is_file() or path.stat().st_size != model['bytes']:
        return False
    digest = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(block)
    return digest.hexdigest() == model['sha256']

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['download', 'verify', 'install-android'])
    parser.add_argument('--serial', help='ADB device serial')
    args = parser.parse_args()
    models = json.loads(LOCK.read_text())['models']
    MODELS.mkdir(exist_ok=True)
    for model in models:
        path = MODELS / model['file']
        if args.action == 'download' and not verify(path, model):
            temp = path.with_suffix(path.suffix + '.part')
            try:
                print('Downloading', model['file'], flush=True)
                with urllib.request.urlopen(model['url'], timeout=60) as src, temp.open('wb') as dst:
                    while block := src.read(1024 * 1024):
                        dst.write(block)
                if not verify(temp, model):
                    raise RuntimeError('Checksum/size mismatch: ' + model['file'])
                temp.replace(path)
            finally:
                temp.unlink(missing_ok=True)
        if not verify(path, model):
            raise RuntimeError('Missing or corrupt model; run download: ' + model['file'])
        print('Verified', model['file'])
    if args.action == 'install-android':
        adb = ['adb'] + (['-s', args.serial] if args.serial else [])
        package = 'com.babeltalk'
        subprocess.run(adb + ['shell', 'run-as', package, 'mkdir', '-p', 'files/models'], check=True)
        for model in models:
            # stdin avoids world-readable temporary model copies on shared storage.
            with (MODELS / model['file']).open('rb') as src:
                subprocess.run(adb + ['shell', 'run-as', package, 'sh', '-c',
                                      f'"cat > files/models/{model["file"]}"'], stdin=src, check=True)
        print('Installed into debug app private files/models directory.')

if __name__ == '__main__':
    main()
