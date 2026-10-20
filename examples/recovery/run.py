#!/usr/bin/env python3
"""Known-answer synthetic byte recovery. No models, targets or real sessions."""
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('local_transform_search', ROOT / 'skills/ghidra-core/scripts/transform_search.py')
tool = importlib.util.module_from_spec(spec); spec.loader.exec_module(tool)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output-dir', type=Path)
    args = parser.parse_args()
    output = args.output_dir or Path(tempfile.mkdtemp(prefix='dsh-recovery-example-'))
    if output.exists() and any(output.iterdir()):
        raise ValueError('Choose a new/empty output directory; existing files are not overwritten')
    output.mkdir(parents=True, exist_ok=True)
    expected = b'ctf{local_replay_only}'
    # Independent fixture encoder: XOR 0x5a, then ADD 19 modulo 256.
    encoded = bytes(((byte ^ 0x5a) + 19) % 256 for byte in expected)
    request = {'version': 1, 'source': {'hex': encoded.hex(), 'basis': 'public known-answer synthetic fixture'},
               'width': 8, 'direction': 'inverse', 'pipelines': [[
                   [{'op': 'xor', 'key_hex': '00'}, {'op': 'xor', 'key_hex': '5a'}],
                   [{'op': 'add', 'value': 0}, {'op': 'add', 'value': 19}]]],
               'criteria': {'sha256': hashlib.sha256(expected).hexdigest()},
               'budget': {'max_input_bytes': 4096, 'max_paths': 4, 'max_byte_ops': 10000}, 'top': 4}
    tool.exclusive_write(output / 'spec.json', json.dumps(request, indent=2).encode())
    report = tool.search(request)
    assert report['status'] == 'complete' and report['coverage']['considered_paths'] == 4
    assert report['candidates'][0]['matches_declared_criteria'] is True
    tool.exclusive_write(output / 'recovery-report.json', json.dumps(report, indent=2).encode())
    recovered = tool.replay(report, 1)
    assert recovered == expected
    tool.exclusive_write(output / 'candidate.bin', recovered)
    answer = {'ok': True, 'example': 'synthetic local recovery', 'considered_paths': 4,
              'replayed_sha256': hashlib.sha256(recovered).hexdigest(), 'fixture_text': recovered.decode(),
              'output_dir': str(output), 'model_calls': 0, 'target_requests': 0,
              'authority': 'known-answer local replay only; not target acceptance or benchmark performance'}
    print(json.dumps(answer, indent=2))


if __name__ == '__main__':
    main()
