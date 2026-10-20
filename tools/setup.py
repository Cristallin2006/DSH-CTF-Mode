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
import sqlite3
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


def overlay(home):
    def module(name, revision=None):
        return (home / 'plugins' / name / 'index.mjs').as_uri() + ('?revision=' + revision if revision else '')
    return encoded([{'insert': [
        {'id': 'dsh-ctf-state-adapter', 'name': module('analysis-hooks-sandbox', '1.1.2'),
         'config': {'dshHome': str(home), 'pluginRoot': str(home / 'hooks'),
                    'configPath': str(home / 'hooks/hooks.json'), 'selfTest': False}},
        {'id': 'analysis-memory', 'name': module('analysis-memory'),
         'config': {'enabled': True, 'stateRoot': str(home / 'analysis-state')}},
        {'id': 'analysis-orchestration', 'name': module('analysis-orchestration', '0.7.0'),
         'config': {'enabled': True, 'stateRoot': str(home / 'analysis-state'), 'maxParallel': 3}}
    ]}])


def plan(home, mode):
    folders = ['skills']
    if mode == 'full':
        folders += ['runtime/analysis-v1', 'plugins/analysis-hooks-sandbox', 'plugins/analysis-memory', 'plugins/analysis-orchestration', 'dsh-hooks']
    result = {}
    manifest = json.loads((ROOT / 'tools/install-manifest.json').read_text(encoding='utf-8'))
    if not isinstance(manifest, list) or not all(isinstance(rel, str) for rel in manifest):
        raise ValueError('Invalid public install manifest')
    for rel in manifest:
        if not any(rel.startswith(folder + '/') for folder in folders):
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
    changes = plan(home, args.mode)
    conflicts = [rel for rel in changes if destination(home, rel).exists() and rel != 'hooks/hooks.json']
    value = {'ok': True, 'mode': args.mode, 'applied': False, 'home': str(home), 'changed_files': len(changes),
             'conflicting_files': conflicts, 'profile_edits': False, 'service_restart': False, 'model_calls': 0,
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
    print(json.dumps(value, ensure_ascii=False, indent=2))
    return 0


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except (ValueError, OSError, sqlite3.Error) as error:
        print(json.dumps({'ok': False, 'error': str(error), 'model_calls': 0}, ensure_ascii=False), file=sys.stderr)
        raise SystemExit(2)
