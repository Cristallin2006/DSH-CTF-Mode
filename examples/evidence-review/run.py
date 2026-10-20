#!/usr/bin/env python3
"""Run the native deterministic Solver/memory walkthrough in an isolated home.

Uses the same exercised native fixture as the regression suite. It is a mechanism
demo, not an autonomous model solving demonstration or a benchmark replay.
"""
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('distribution_doctor', ROOT / 'tools/doctor.py')
doctor = importlib.util.module_from_spec(spec); spec.loader.exec_module(doctor)


def main():
    if sys.platform != 'linux':
        sys.exit('Run this native demonstration in Linux/WSL; recovery/run.py needs only Python.')
    node = shutil.which('node')
    package = doctor.native_package()
    if not node or not package:
        sys.exit('Install DSH and Node.js 24+, or set DSH_NATIVE_PACKAGE_ROOT. See docs/QUICKSTART.md.')
    env = dict(os.environ)
    for key in ['DSH_HOME', 'DSH_ANALYSIS_STATE', 'DSH_ORCHESTRATION_TEST_ROOT']:
        env.pop(key, None)
    env['DSH_NATIVE_PACKAGE_ROOT'] = package['path']
    env['DSH_TELEMETRY_DISABLED'] = '1'
    print('SYNTHETIC NATIVE DEMO | deterministic local adapter | external model calls: 0', flush=True)
    print('1. Bind a synthetic task and publish an untested interpretation.', flush=True)
    print('2. A native Solver reads its record grant; source access is separately granted.', flush=True)
    print('3. An independent review reads original evidence, then continues in the same child.', flush=True)
    print('4. Legacy work, Observer, idle grants and teardown retain their boundaries.', flush=True)
    result = subprocess.run([node, str(ROOT / 'tests/collaborative-native.mjs')], cwd=ROOT, env=env)
    if result.returncode:
        return result.returncode
    value = json.loads((ROOT / '.test-results/collaborative-native.json').read_text())
    assert value['ok'] and value['externalModelCalls'] == value['externalTargetRequests'] == 0
    print('PASS | actual native child tools and scoped memory exercised | no live task data used', flush=True)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
