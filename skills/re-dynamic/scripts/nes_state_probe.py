#!/usr/bin/env python3
"""Validate a debugger-assisted NES one-byte RAM experiment and hash artifacts."""
import argparse
import hashlib
import json
from pathlib import Path


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def check(spec):
    rom = Path(spec['rom'])
    if rom.read_bytes()[:4] != b'NES\x1a':
        raise ValueError('not an iNES ROM')
    address, value = int(spec['address'], 0), int(spec['value'], 0)
    if not 0 <= address < 0x800 or not 0 <= value <= 255:
        raise ValueError('address must be internal RAM and value a byte')
    artifacts = {}
    baseline = Path(spec['baseline_ram']).read_bytes()
    if len(baseline) != 0x800:
        raise ValueError('baseline RAM must be 2048 bytes')
    for name in ('control', 'injected'):
        run = spec[name]
        before = Path(run['ram_before']).read_bytes()
        after = Path(run['ram_after']).read_bytes()
        if len(before) != len(after) or len(before) != 0x800:
            raise ValueError(f'{name} RAM snapshots must be 2048 bytes')
        expected = bytearray(baseline)
        if name == 'injected':
            expected[address] = value
        if before != expected:
            raise ValueError(f'{name} initial RAM differs beyond selected address')
        if not isinstance(run.get('frames'), int) or run['frames'] <= 0:
            raise ValueError(f'{name} requires positive rendered frame count')
        if not Path(run['screenshot']).is_file():
            raise ValueError(f'{name} screenshot missing')
        artifacts[name] = {'frames': run['frames'], 'observed': run.get('observed', ''),
                           'ram_changes': [i for i, (a, b) in enumerate(zip(before, after)) if a != b],
                           'screenshot_sha256': sha(run['screenshot']),
                           'ram_after_sha256': sha(run['ram_after'])}
    if spec['control']['frames'] != spec['injected']['frames']:
        raise ValueError('control and injected runs need equal frame counts')
    return {'schema': 'nes-state-probe-v1', 'rom_sha256': sha(rom),
            'baseline_ram_sha256': sha(spec['baseline_ram']), 'address': address,
            'value': value, 'runs': artifacts, 'claim': 'state experiment only; natural input path unverified'}


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('spec_json')
    p.add_argument('--out', required=True)
    a = p.parse_args()
    try:
        result = check(json.loads(Path(a.spec_json).read_text(encoding='utf-8')))
        Path(a.out).write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
        print(json.dumps({'ok': True, 'receipt': a.out}))
    except (OSError, ValueError, TypeError, KeyError) as exc:
        print(json.dumps({'ok': False, 'error': str(exc)}))
        return 2
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
