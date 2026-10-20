#!/usr/bin/env python3
"""Read-only prerequisite check; no model calls, profile loading or database creation."""
import argparse
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import sys


def command(argv):
    try:
        result = subprocess.run(argv, capture_output=True, text=True, timeout=15)
        return result.returncode == 0, result.stdout.strip()
    except (OSError, subprocess.TimeoutExpired):
        return False, ''


def native_package():
    configured = os.environ.get('DSH_NATIVE_PACKAGE_ROOT')
    if configured:
        path = Path(configured).expanduser()
    else:
        npm = shutil.which('npm')
        if not npm:
            return None
        # Windows npm.cmd is not used: full/native mode is Linux-only.
        ok, value = command([npm, 'root', '-g'])
        if not ok:
            return None
        path = Path(value) / '@deepseek-ai/dsh'
    try:
        data = json.loads((path / 'package.json').read_text(encoding='utf-8'))
        if data.get('name') == '@deepseek-ai/dsh':
            return {'path': str(path.resolve()), 'version': data.get('version')}
    except (OSError, ValueError):
        pass
    return None


def inspect(mode, home):
    checks = [{'name': 'python', 'ok': sys.version_info >= (3, 10), 'required': True,
               'detail': platform.python_version()}]
    def add(name, ok, detail, required=True):
        checks.append({'name': name, 'ok': bool(ok), 'required': required, 'detail': detail})
    add('dsh_command', shutil.which('dsh'), 'DSH command found' if shutil.which('dsh') else 'Install DSH separately; skill files alone do not install the host')
    package = None
    if mode == 'full':
        add('linux_storage', sys.platform == 'linux' and not home.resolve().is_relative_to(Path('/mnt')), 'Full mode needs Linux-native storage, not /mnt')
        add('python3_for_hooks', Path('/usr/bin/python3').is_file(), 'The state adapter invokes /usr/bin/python3')
        node = shutil.which('node')
        ok, version = command([node, '--version']) if node else (False, '')
        add('node_24_plus', ok and int(version.lstrip('v').split('.')[0]) >= 24, version or 'Node.js 24+ not found')
        sqlite_ok, _ = command([node, '--no-warnings', '-e', "const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync(':memory:');d.close();console.log('ok')"]) if node else (False, '')
        add('node_sqlite', sqlite_ok, 'In-memory node:sqlite probe; no persistent DB was opened')
        package = native_package() if sys.platform == 'linux' else None
        add('dsh_native_package', package is not None, package or 'Set DSH_NATIVE_PACKAGE_ROOT to the installed DSH package directory')
        if package and package['version'] != '0.1.5-rc.3':
            add('validated_host_version', False, 'Validated on DSH 0.1.5-rc.3; validate other versions before use', required=False)
        for rel in ['runtime/analysis-v1/session.py', 'hooks/hooks.json', 'plugins/analysis-memory/broker.mjs', 'plugins/analysis-orchestration/index.mjs', 'launch/ctf-orchestration.patch.json']:
            add('installed:' + rel, (home / rel).is_file(), 'Present' if (home / rel).is_file() else 'Run setup.py --mode full --apply after checking its preview')
    add('model_configuration', True, 'Not inspected. Normal interactive solving needs your own model configuration; synthetic examples do not.', required=False)
    add('specialist_tools', True, 'Ghidra/JDK and other specialist backends are optional and not validated by this doctor.', required=False)
    return {'ok': all(c['ok'] for c in checks if c['required']), 'mode': mode, 'home': str(home),
            'checks': checks, 'native_package': package, 'model_calls': 0,
            'coverage': 'Prerequisites and file presence only; does not prove plugin activation, target reachability, or model quality.'}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--mode', choices=['skills', 'full'], default='skills')
    parser.add_argument('--home', default=os.environ.get('DSH_HOME', str(Path.home() / '.dsh')))
    args = parser.parse_args()
    value = inspect(args.mode, Path(args.home).expanduser().absolute())
    print(json.dumps(value, ensure_ascii=False, indent=2))
    return 0 if value['ok'] else 2


if __name__ == '__main__':
    raise SystemExit(main())
