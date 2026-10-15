#!/usr/bin/env python3
"""Bind observed Windows runs to a sample and evidence files; never infer acceptance."""
import argparse
import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path


def digest(path):
    h = hashlib.sha256()
    with Path(path).open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            h.update(block)
    return h.hexdigest()


def build(sample, observations):
    data = json.loads(Path(observations).read_text(encoding='utf-8'))
    if not isinstance(data, dict) or not isinstance(data.get('runs'), list) or len(data['runs']) < 2:
        raise ValueError('runs must contain at least a candidate and a negative control')
    roles = set()
    for run in data['runs']:
        if not isinstance(run, dict) or not {'role', 'input_hex', 'environment', 'launch', 'observed'} <= run.keys():
            raise ValueError('each run needs role, input_hex, environment, launch, observed')
        if run['role'] not in ('candidate', 'negative') or run['role'] in roles:
            raise ValueError('one candidate and one negative control required')
        roles.add(run['role'])
        bytes.fromhex(run['input_hex'])
        if not all(isinstance(run[k], str) and run[k].strip() for k in ('environment', 'launch', 'observed')):
            raise ValueError('empty run field')
        for name in run.get('evidence_files', []):
            if not Path(name).is_file():
                raise ValueError(f'missing evidence file: {name}')
            run.setdefault('evidence_sha256', {})[name] = digest(name)
    if roles != {'candidate', 'negative'}:
        raise ValueError('one candidate and one negative control required')
    if data['runs'][0]['input_hex'].lower() == data['runs'][1]['input_hex'].lower():
        raise ValueError('candidate and negative control inputs must differ')
    return {'schema': 'windows-oracle-observation-v1',
            'created_utc': datetime.now(timezone.utc).isoformat(),
            'sample': str(Path(sample).resolve()), 'sample_sha256': digest(sample),
            'runs': data['runs'], 'program_accept': 'unreviewed'}


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('sample')
    p.add_argument('observations', help='JSON with candidate and negative runs')
    p.add_argument('--out', required=True)
    a = p.parse_args()
    try:
        result = build(a.sample, a.observations)
        out = Path(a.out)
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
        print(json.dumps({'ok': True, 'receipt': str(out), 'sample_sha256': result['sample_sha256']}))
    except (OSError, ValueError, TypeError, json.JSONDecodeError) as exc:
        print(json.dumps({'ok': False, 'error': str(exc)}))
        return 2
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
