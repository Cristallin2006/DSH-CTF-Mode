#!/usr/bin/env python3
"""Preview/install public skills; full mode adds runtime files and a separate overlay.

Standard library only. No downloads, model calls, profile edits or service restarts.
"""
import argparse
from contextlib import closing
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import sqlite3
import subprocess
import sys
import tempfile
from uuid import uuid4

ROOT = Path(__file__).resolve().parent.parent
EVENTS = ('SessionStart', 'SubagentStart', 'PreToolUse', 'PostToolUse', 'Stop', 'SubagentStop')


def encoded(value):
    return (json.dumps(value, ensure_ascii=False, indent=2) + '\n').encode()


def digest(data):
    return hashlib.sha256(data).hexdigest()


def destination(home, relative):
    path = home / relative
    if not path.is_relative_to(home):
        raise ValueError('Destination escapes DSH_HOME')
    for item in [path, *path.parents]:
        if item.is_symlink():
            raise ValueError('Symlink destination refused: ' + str(item))
        if item == home:
            break
    if path.exists() and not path.is_file():
        raise ValueError('Expected a regular file: ' + str(path))
    return path


def hooks_config(home):
    path = destination(home, 'hooks/hooks.json')
    cfg = json.loads(path.read_text(encoding='utf-8')) if path.exists() else {'hooks': {}}
    if not isinstance(cfg, dict) or not isinstance(cfg.get('hooks', {}), dict):
        raise ValueError('Invalid hooks.json; original left unchanged')
    cfg.setdefault('hooks', {})
    entry = {'type': 'command', 'command': 'python3 "${CLAUDE_PLUGIN_ROOT}/analysis_hook.py"', 'timeout': 10}
    for event in EVENTS:
        groups = cfg['hooks'].setdefault(event, [])
        if not isinstance(groups, list):
            raise ValueError('Invalid hook event groups')
        found = False
        for group in groups:
            if not isinstance(group, dict) or not isinstance(group.get('hooks', []), list):
                raise ValueError('Invalid hook group')
            for hook in group.get('hooks', []):
                if not isinstance(hook, dict):
                    raise ValueError('Invalid hook entry')
                command = hook.get('command', '')
                if isinstance(command, str) and 'analysis_hook.py' in command:
                    if command != entry['command']:
                        raise ValueError('Conflicting analysis_hook.py command; use manual merge')
                    found = True
        if not found:
            groups.append({'hooks': [dict(entry)]})
    return encoded(cfg)


def overlay(home, ctf_mode=None, native_ui=False):
    def module(name, revision=None):
        return (home / 'plugins' / name / 'index.mjs').as_uri() + ('?revision=' + revision if revision else '')
    rows = [
        {'id': 'dsh-ctf-state-adapter', 'name': module('analysis-hooks-sandbox', '1.1.3'),
         'config': {'dshHome': str(home), 'pluginRoot': str(home / 'hooks'),
                    'configPath': str(home / 'hooks/hooks.json'), 'selfTest': False}},
        {'id': 'analysis-memory', 'name': module('analysis-memory'),
         'config': {'enabled': True, 'stateRoot': str(home / 'analysis-state')}},
        {'id': 'analysis-orchestration', 'name': module('analysis-orchestration', '0.8.1'),
         'config': {'enabled': True, 'stateRoot': str(home / 'analysis-state'), 'maxParallel': 3}}
    ]
    if ctf_mode is not None:
        rows.append({'id': 'ctf-mode', 'name': module('ctf-mode', '1.0.0'),
                     'config': {'enabled': True, 'mode': ctf_mode}})
    if native_ui:
        rows.append({'id': 'dsh-ctf-ui', 'name': module('ctf-ui')})
    return encoded([{'insert': rows}])


def native_preset(home, native_root=None):
    """Duplicate this machine's Standard composition; do not vendor the upstream preset."""
    root = Path(native_root or os.environ.get('DSH_NATIVE_PACKAGE_ROOT', '/opt/node24/lib/node_modules/@deepseek-ai/dsh'))
    standard = root / 'node_modules/@deepseek-ai/dsh-agent-presets/presets/standard/agent.cordis.yml'
    if not standard.is_file() or standard.stat().st_size > 262144:
        raise ValueError('Native Standard preset unavailable; set DSH_NATIVE_PACKAGE_ROOT to the installed DSH package')
    body = standard.read_text(encoding='utf-8')
    # Local custom directories do not necessarily share the harness's Node lookup
    # base. Resolve every upstream package through the installed harness first.
    pattern = re.compile(r"(?m)^(\s*name:\s*)['\"](@deepseek-ai/[^'\"\n]+)['\"]\s*$")
    names = sorted({match.group(2) for match in pattern.finditer(body)})
    resolver = "const {createRequire}=require('node:module'),{pathToFileURL}=require('node:url'),fs=require('node:fs');const r=createRequire(process.argv[1]);process.stdout.write(JSON.stringify(Object.fromEntries(JSON.parse(fs.readFileSync(0,'utf8')).map(n=>[n,pathToFileURL(r.resolve(n)).href]))));"
    resolved = json.loads(subprocess.run(['node', '-e', resolver, str(root / 'package.json')], input=json.dumps(names), text=True, capture_output=True, check=True).stdout)
    body = pattern.sub(lambda match: match.group(1) + json.dumps(resolved[match.group(2)]), body)
    row = {'id': 'ctf-mode', 'name': (home / 'plugins/ctf-mode/index.mjs').as_uri(),
           'config': {'enabled': True, 'mode': 'auto', 'presetId': 'ctf'}}
    return {'.agent-presets/ctf/agent.cordis.yml': (body.rstrip() + '\n\n- ' + json.dumps(row, ensure_ascii=False) + '\n').encode(),
            '.agent-presets/ctf/preset.yml': encoded({'name': 'CTF 模式', 'description': '自动判断、优先单兵或优先编排；按任务加载完整解题知识，显示运行状态。', 'order': 10}),
            'launch/ctf-native.patch.json': overlay(home, native_ui=True)}


def plan(home, mode, preset=None, ctf_mode='auto', native=False, native_root=None):
    folders = ['skills']
    if mode == 'full':
        folders += ['runtime/analysis-v1', 'plugins/analysis-hooks-sandbox', 'plugins/analysis-memory', 'plugins/analysis-orchestration', 'plugins/ctf-mode', 'dsh-hooks']
        if native:
            folders.append('plugins/ctf-ui')
    result = {}
    manifest = json.loads((ROOT / 'tools/install-manifest.json').read_text(encoding='utf-8'))
    if not isinstance(manifest, list) or not all(isinstance(rel, str) for rel in manifest):
        raise ValueError('Invalid public install manifest')
    for rel in manifest:
        if not any(rel.startswith(folder + '/') for folder in folders) and not (preset == 'ctf' and rel == 'tools/ctf.py'):
            continue
        relative = Path(rel)
        if relative.is_absolute() or '..' in relative.parts:
            raise ValueError('Unsafe source manifest path')
        path = ROOT / relative
        for item in [path, *path.parents]:
            if item.is_symlink():
                raise ValueError('Source symlink refused: ' + rel)
            if item == ROOT:
                break
        if not path.is_file():
            raise ValueError('Required public source file missing: ' + rel)
        try:
            result[rel] = path.read_bytes()
        except OSError as error:
            raise ValueError('Cannot read required public source file: ' + rel) from error
    if mode == 'full':
        result['hooks/analysis_hook.py'] = result.pop('dsh-hooks/analysis_hook.py')
        result['hooks/hooks.json'] = hooks_config(home)
        result['launch/ctf-orchestration.patch.json'] = overlay(home)
        if native:
            for required in ('plugins/ctf-ui/package.json', 'plugins/ctf-ui/index.mjs', 'plugins/ctf-ui/client.js', 'plugins/ctf-ui/controller.mjs', 'plugins/ctf-mode/index.mjs'):
                if required not in result:
                    raise ValueError('Native CTF preset source missing from manifest: ' + required)
            result.update(native_preset(home, native_root))
        if preset == 'ctf':
            for required in ('skills/ctf-mode/SKILL.md', 'plugins/ctf-mode/index.mjs',
                             'plugins/ctf-mode/core.mjs', 'plugins/analysis-hooks-sandbox/hook-readiness.mjs'):
                if required not in result:
                    raise ValueError('CTF preset source missing from manifest: ' + required)
            result['launch/ctf-mode.patch.json'] = overlay(home, ctf_mode)
            if 'tools/ctf.py' not in result:
                raise ValueError('CTF launcher source missing from manifest')
            result['launch/ctf.py'] = result.pop('tools/ctf.py')
    return {rel: data for rel, data in result.items()
            if not destination(home, rel).exists() or destination(home, rel).read_bytes() != data}


def active_work(home):
    if (home / 'analysis-state').is_symlink():
        raise ValueError('Symlink state directory refused')
    path = home / 'analysis-state/state.sqlite3'
    if not path.exists():
        return 0
    if path.is_symlink():
        raise ValueError('Symlink state database refused')
    count = 0
    with closing(sqlite3.connect(path.as_uri() + '?mode=ro', uri=True, timeout=2)) as con:
        tables = {row[0] for row in con.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        for table, field in [('orch_work', 'state'), ('analysis_native_jobs', 'status')]:
            if table in tables:
                count += con.execute(f"SELECT COUNT(*) FROM {table} WHERE json_extract(data,'$.{field}') IN ('launching','running','stopping','cleanup_unknown')").fetchone()[0]
        if 'mem_work' in tables:
            count += con.execute("SELECT COUNT(*) FROM mem_work WHERE state='running'").fetchone()[0]
    return count


def atomic(path, data, mode=0o644):
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix='.dsh-setup-', dir=path.parent)
    try:
        with os.fdopen(fd, 'wb') as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(temporary, mode)
        os.replace(temporary, path)
    finally:
        if Path(temporary).exists():
            Path(temporary).unlink()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--mode', choices=['skills', 'full'], default='skills')
    parser.add_argument('--home', default=os.environ.get('DSH_HOME', str(Path.home() / '.dsh')))
    parser.add_argument('--preset', choices=['ctf'], help='opt-in main-session skill and hook admission; requires full')
    parser.add_argument('--native-preset', choices=['ctf'], help='install a custom native CTF card and separate host/UI overlay; requires full')
    parser.add_argument('--native-root', help='installed DSH package root, for cloning its native Standard composition')
    parser.add_argument('--ctf-mode', choices=['auto', 'solo', 'orchestrated'], default='auto')
    parser.add_argument('--apply', action='store_true', help='default is a genuinely read-only preview')
    parser.add_argument('--replace', action='store_true', help='back up and replace conflicting files; never deletes unlisted files')
    args = parser.parse_args()
    raw = Path(args.home).expanduser().absolute()
    if raw.is_symlink():
        raise ValueError('DSH_HOME symlink refused')
    home = raw.resolve()
    if home.is_relative_to(ROOT) or ROOT.is_relative_to(home):
        raise ValueError('DSH_HOME and the checkout must not overlap')
    if args.mode == 'full' and (sys.platform != 'linux' or home.is_relative_to(Path('/mnt'))):
        raise ValueError('Full mode requires native Linux storage (not /mnt). Use WSL and a Linux DSH_HOME.')
    if (args.preset or args.native_preset) and args.mode != 'full':
        raise ValueError('CTF preset requires --mode full')
    if args.preset and args.native_preset:
        raise ValueError('Choose the legacy process overlay or the native session preset, not both')
    if args.native_preset and args.ctf_mode != 'auto':
        raise ValueError('The native preset uses soft preferences in CTF settings; --ctf-mode pins only the legacy process overlay')
    changes = plan(home, args.mode, args.preset, args.ctf_mode, bool(args.native_preset), args.native_root)
    conflicts = [rel for rel in changes if destination(home, rel).exists() and rel != 'hooks/hooks.json']
    value = {'ok': True, 'mode': args.mode, 'applied': False, 'home': str(home), 'changed_files': len(changes),
             'conflicting_files': conflicts, 'profile_edits': False, 'service_restart': False, 'model_calls': 0,
             'preset': args.preset, 'ctf_mode': args.ctf_mode if args.preset else None,
             'native_preset': args.native_preset,
             'note': 'Run tools/doctor.py --mode ' + args.mode + '; full mode requires a fresh profile or a manual merge if these plugins are already registered.'}
    if not args.apply:
        print(json.dumps(value, ensure_ascii=False, indent=2))
        return 0
    if conflicts and not args.replace:
        raise ValueError('Conflicting files found; preview first, then use --replace only after maintenance preparation')
    # Checked even for skills-only writes: a live Solver may be using a skill file.
    if changes and active_work(home):
        raise ValueError('Managed work is active or cleanup is unconfirmed; pause/drain it before installation')
    if not changes:
        print(json.dumps({**value, 'applied': True, 'unchanged': True}, ensure_ascii=False))
        return 0
    original = {rel: destination(home, rel).read_bytes() if destination(home, rel).exists() else None for rel in changes}
    modes = {rel: (destination(home, rel).stat().st_mode & 0o777) if original[rel] is not None else 0o644 for rel in changes}
    backup = home / 'setup-backups' / (datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S') + '-' + uuid4().hex[:8])
    if (home / 'setup-backups').is_symlink():
        raise ValueError('Symlink backup directory refused')
    backup.mkdir(parents=True, mode=0o700)
    manifest = {}
    for rel, data in original.items():
        if data is not None:
            atomic(backup / 'original' / rel, data, 0o600)
        manifest[rel] = {'before': digest(data) if data is not None else None, 'after': digest(changes[rel]), 'mode': modes[rel]}
    atomic(backup / 'manifest.json', encoded(manifest), 0o600)
    written = []
    try:
        for rel, data in changes.items():
            path = destination(home, rel)
            current = path.read_bytes() if path.exists() else None
            if current != original[rel]:
                raise ValueError('Destination changed during setup; refused: ' + rel)
            atomic(path, data, modes[rel]); written.append(rel)
        if args.mode == 'full':
            state = home / 'analysis-state'
            if state.is_symlink():
                raise ValueError('Symlink state directory refused')
            state.mkdir(mode=0o700, exist_ok=True)
    except BaseException:
        for rel in reversed(written):
            path = destination(home, rel)
            if original[rel] is None:
                path.unlink()
            else:
                atomic(path, original[rel], modes[rel])
        raise
    value.update(applied=True, backup=str(backup))
    if args.mode == 'full':
        value['overlay'] = str(home / 'launch/ctf-orchestration.patch.json')
        value['next'] = 'Use the generated --patch with a NEW ctf-preview profile; see docs/QUICKSTART.md. Configure your own model separately.'
    if args.preset == 'ctf':
        value['ctf_overlay'] = str(home / 'launch/ctf-mode.patch.json')
        value['next'] = 'Launch python3 '+str(home / 'launch/ctf.py')+' --profile ctf --from-default-profile web (new profile only); configure your model normally.'
    print(json.dumps(value, ensure_ascii=False, indent=2))
    return 0


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except (ValueError, OSError, sqlite3.Error) as error:
        print(json.dumps({'ok': False, 'error': str(error), 'model_calls': 0}, ensure_ascii=False), file=sys.stderr)
        raise SystemExit(2)
