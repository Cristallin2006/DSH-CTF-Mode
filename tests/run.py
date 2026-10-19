#!/usr/bin/env python3
"""Run isolated synthetic regressions. No external model or target requests."""
import os
from pathlib import Path
import shutil
import subprocess
import sys

root = Path(__file__).resolve().parent.parent
env = dict(os.environ)
for key in ('DSH_HOME', 'DSH_ANALYSIS_STATE'):
    env.pop(key, None)
node = shutil.which('node')
if not node:
    sys.exit('Node.js 24 is required')
names = ['contract', 'feedback', 'invariants', 'resolution', 'shutdown', 'skill-delivery-unit', 'reliability', 'reference-policy-unit', 'collaborative-memory']
if '--native' in sys.argv:
    if not env.get('DSH_NATIVE_PACKAGE_ROOT'):
        sys.exit('Set DSH_NATIVE_PACKAGE_ROOT to the installed @deepseek-ai/dsh package')
    names += ['reload', 'idle-native', 'native', 'skill-delivery', 'reference-delivery', 'collaborative-native']
for name in names:
    print(f'Running {name}', flush=True)
    result = subprocess.run([node, str(root/'tests'/f'{name}.mjs')], cwd=root, env=env)
    if result.returncode:
        sys.exit(result.returncode)
print(f'Passed {len(names)} synthetic regression groups')
