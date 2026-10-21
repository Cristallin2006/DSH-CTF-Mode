"""Fixed local adapters and small grading fixtures; not autonomous model evaluation."""
import contextlib
import importlib.util
import io
import json
from pathlib import Path
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[3]


def load(name, relative):
    spec = importlib.util.spec_from_file_location(name, ROOT / relative)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def transform(f):
    tool = load('knowledge_transform', 'skills/ghidra-core/scripts/transform_search.py')
    data = bytes.fromhex(f['hex'])
    start, end = f.get('slice', [0, len(data)])
    if not 0 <= start <= end <= len(data):
        return {'status': 'invalid'}
    request = {'version': 1, 'source': {'hex': data[start:end].hex(), 'basis': 'synthetic fixture'}, 'width': 8,
               'direction': f['direction'], 'pipelines': [[[op] for op in f['ops']]],
               'criteria': {'sha256': f['sha256']},
               'budget': {'max_input_bytes': 128, 'max_paths': 1, 'max_byte_ops': 2048}, 'top': 1}
    report = tool.search(request)
    candidate = report['candidates'][0]
    return {'status': 'checked' if candidate['matches_declared_criteria'] else 'no_match',
            'output_hex': tool.replay(report, 1).hex()}


def encoding(f):
    tool = load('knowledge_encoding', 'skills/ghidra-core/scripts/crypto_sanity.py')
    return tool.check_base64(f['text'], f['alphabet'], f['padding'])


def preflight(f):
    node = shutil.which('node')
    if not node:
        raise RuntimeError('Node.js 24+ required for production preflight samples')
    result = subprocess.run([node, str(Path(__file__).with_name('preflight.mjs')), json.dumps(f)],
                            capture_output=True, text=True, timeout=10)
    if result.returncode:
        raise RuntimeError(result.stderr)
    return json.loads(result.stdout)


ADAPTERS = {'transform': transform, 'encoding': encoding, 'preflight': preflight}


def grade_fixture(checker, f, answer):
    """These judge authored answers only. They do NOT produce agent decisions."""
    if checker == 'http-scope':
        return answer == {'observed': f['status'], 'cause': 'unknown', 'scope': 'one_request', 'target_accepted': None}
    if checker == 'oracle-contract':
        return answer == {'status': 'comparable' if f['expected_abi'] == f['actual_abi'] and f['same_input'] else 'inconclusive', 'target_accepted': None}
    if checker == 'capture-coverage':
        slots = {}; conflict = False
        for segment in f['segments']:
            for offset, byte in enumerate(bytes.fromhex(segment['hex']), segment['seq']):
                conflict |= offset in slots and slots[offset] != byte
                slots[offset] = byte
        complete = not conflict and set(slots) == set(range(f['length']))
        expected = {'complete': complete, 'output_hex': bytes(slots[i] for i in range(f['length'])).hex() if complete else None}
        return answer == expected
    if checker == 'routing-set':
        return answer.get('skills') in f['acceptable_skill_sets'] and answer.get('tool_permissions_unchanged') is True
    if checker == 'revision-scope':
        return answer == {'same_child': f['before_child'] == f['after_child'], 'review_current': f['reviewed_revision'] == f['result_revision']}
    raise ValueError('Unknown fixed checker')


GRADERS = {'http-scope', 'oracle-contract', 'capture-coverage', 'routing-set', 'revision-scope'}


def grade(case, answer, actual=None):
    if case['checker'] in ADAPTERS:
        # Reject invented/missing projection keys instead of comparing only one score.
        return isinstance(answer, dict) and bool(answer) and all(key in actual and actual[key] == value for key, value in answer.items())
    if case['checker'] in GRADERS:
        return isinstance(answer, dict) and grade_fixture(case['checker'], case['fixture'], answer)
    raise ValueError('Unknown fixed checker')
