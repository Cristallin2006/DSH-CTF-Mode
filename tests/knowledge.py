#!/usr/bin/env python3
"""Replay public synthetic samples and test fixed graders; no model calls."""
import importlib.util
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('knowledge_registry', ROOT / 'tests/knowledge/checkers/registry.py')
registry = importlib.util.module_from_spec(spec); spec.loader.exec_module(registry)


def main():
    cases = json.loads((ROOT / 'tests/knowledge/cases/offline.json').read_text())
    answers = json.loads((ROOT / 'tests/knowledge/answers.json').read_text())
    assert len({c['id'] for c in cases}) == len(cases)
    results = []
    for case in cases:
        assert case['checker'] in registry.ADAPTERS or case['checker'] in registry.GRADERS
        pair = answers[case['id']]
        actual = registry.ADAPTERS[case['checker']](case['fixture']) if case['checker'] in registry.ADAPTERS else None
        assert registry.grade(case, pair['correct'], actual), case['id']
        assert not registry.grade(case, pair['wrong'], actual), 'Grader accepted counterexample: ' + case['id']
        assert pair['correct'].get('status', case['expected_outcome']) == case['expected_outcome']
        results.append({'id': case['id'], 'family': case['family'], 'ok': True,
                        'measurement': 'production_tool_sample' if actual is not None else 'authored_grader_fixture',
                        'expected_outcome': case['expected_outcome']})
    counts = {kind: sum(r['measurement'] == kind for r in results) for kind in ('production_tool_sample', 'authored_grader_fixture')}
    report = {'ok': True, 'cases': results, 'counts': counts, 'model_calls': 0, 'target_requests': 0,
              'limitation': 'Public deterministic samples and authored grading fixtures; not agent routing, understanding or solving performance'}
    (ROOT / '.test-results').mkdir(exist_ok=True)
    (ROOT / '.test-results/knowledge.json').write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps({**report, 'cases': len(results)}, indent=2))


if __name__ == '__main__':
    main()
