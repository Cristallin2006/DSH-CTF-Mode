#!/usr/bin/env python3
"""DSH analysis state, v1. Standard library; SQLite owns atomic state and events."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import shutil
import sqlite3
import subprocess
import sys
import time
import uuid
from contextlib import contextmanager

VERSION = '1.0.7'
ROOT = Path(os.environ.get('DSH_HOME', str(Path.home() / '.dsh')))
STATE = Path(os.environ.get('DSH_ANALYSIS_STATE', str(ROOT / 'analysis-state')))
TRANSITIONS = {
    'running': {'waiting', 'paused', 'blocked', 'complete', 'cancelled'},
    'waiting': {'running', 'paused', 'blocked', 'cancelled'},
    'paused': {'running', 'cancelled'},
    'blocked': {'running', 'paused', 'cancelled'},
    'complete': set(), 'cancelled': set(),
}

def packed(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True)

@contextmanager
def database():
    STATE.mkdir(parents=True, exist_ok=True, mode=0o700)
    con = sqlite3.connect(STATE / 'state.sqlite3', timeout=8)
    con.row_factory = sqlite3.Row
    con.execute('PRAGMA journal_mode=WAL')
    con.execute('PRAGMA synchronous=FULL')
    con.executescript('''
    CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, task TEXT, cwd TEXT);
    CREATE TABLE IF NOT EXISTS targets (task TEXT, id TEXT, generation INTEGER, data TEXT,
                                      PRIMARY KEY(task,id,generation));
    CREATE TABLE IF NOT EXISTS artifacts (hash TEXT PRIMARY KEY, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS records (id TEXT PRIMARY KEY, task TEXT, kind TEXT, data TEXT);
    CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY, key TEXT UNIQUE, ts REAL,
                                     session TEXT, task TEXT, kind TEXT, data TEXT);
    CREATE TABLE IF NOT EXISTS leases (resource TEXT PRIMARY KEY, task TEXT, owner TEXT,
                                      token TEXT NOT NULL, expires REAL NOT NULL);
    CREATE TABLE IF NOT EXISTS resources (id TEXT PRIMARY KEY, task TEXT, data TEXT);
    CREATE TABLE IF NOT EXISTS reminders (key TEXT PRIMARY KEY, signature TEXT, ts REAL);
    ''')
    con.commit()
    con.execute('BEGIN IMMEDIATE')
    try:
        yield con
        con.commit()
    except BaseException:
        con.rollback()
        raise
    finally:
        con.close()

def get_task(con, task):
    row = con.execute('SELECT data FROM tasks WHERE id=?', (task,)).fetchone()
    if not row:
        raise ValueError('unknown task: ' + str(task))
    return json.loads(row[0])

def save_task(con, task, data):
    con.execute('UPDATE tasks SET data=? WHERE id=?', (packed(data), task))

def event(con, kind, data, session='', task=None, key=None):
    con.execute('INSERT OR IGNORE INTO events(key,ts,session,task,kind,data) VALUES(?,?,?,?,?,?)',
                (key, time.time(), session, task, kind, packed(data)))

def load_data(args):
    value = Path(args.file).read_text(encoding='utf-8') if getattr(args, 'file', None) else args.data
    data = json.loads(value)
    if not isinstance(data, dict):
        raise ValueError('data must be a JSON object')
    return data

def valid_target(con, task, target, generation):
    row = con.execute('SELECT MAX(generation) FROM targets WHERE task=? AND id=?', (task, target)).fetchone()
    if row[0] is None or row[0] != generation:
        raise ValueError('target generation is stale or absent')


def orchestration_basis(con, task, run):
    data = get_task(con, task)
    targets = [dict(row) for row in con.execute('SELECT id,MAX(generation) AS generation FROM targets WHERE task=? GROUP BY id ORDER BY id', (task,))]
    works = []
    for row in con.execute('SELECT data FROM orch_work WHERE task=? AND epoch=?', (task, run['epoch'])):
        work = json.loads(row[0])
        review, feedback = work.get('review'), work.get('checkpoint') or {}
        works.append({'id': work['id'], 'state': work['state'], 'result_revision': work.get('result_revision', 0),
                      'review': {'decision': review['decision'], 'result_revision': review.get('result_revision', 0)} if review else None,
                      'feedback': {'outcome': feedback.get('outcome'), 'evidence_refs': sorted(set(feedback.get('evidence_refs', [])))}})
    return {'epoch': run['epoch'], 'goal': data.get('goal'), 'constraints': data.get('constraints') if data.get('constraints') is not None else {},
            'targets': targets, 'works': sorted(works, key=lambda work: work['id'])}


def require_orchestration_resolution(con, task):
    if not con.execute("SELECT 1 FROM sqlite_master WHERE name='orch_runs'").fetchone():
        return
    row = con.execute('SELECT data FROM orch_runs WHERE task=?', (task,)).fetchone()
    if not row:
        return
    run = json.loads(row[0])
    if run.get('state') not in ('finished', 'disabled'):
        raise ValueError('finish or explicitly disable orchestration before completing the task')
    review = run.get('resolution_review') or {}
    if review.get('state') != 'resolved' or review.get('basis') != orchestration_basis(con, task, run):
        raise ValueError('current orchestration goal resolution required; read dsh_orchestration status and resolve against its decision_review.signature; finish/disable alone is not goal completion')
    resolution = review.get('resolution') or {}
    if resolution.get('decision') != 'complete' or resolution.get('goal_status') != 'fulfilled' or not resolution.get('completion_scope') or not resolution.get('evidence_refs'):
        raise ValueError('goal is not recorded fulfilled with delivery scope and evidence; retain checkpoint and pause/block, or supply a grounded complete resolution')
    unresolved = resolution.get('unresolved')
    if not isinstance(unresolved, list) or any(not isinstance(item, dict) or item.get('disposition') != 'out_of_scope' or not item.get('reason') for item in unresolved):
        raise ValueError('in-scope unresolved objectives cannot be silently completed')
    works = {json.loads(row[0])['id']: json.loads(row[0]) for row in con.execute('SELECT data FROM orch_work WHERE task=? AND epoch=?', (task, run['epoch']))}
    for work in works.values():
        if work['state'] in ('launching', 'running', 'stopping', 'cleanup_unknown', 'pending', 'returned'):
            raise ValueError('unresolved orchestration branches remain; review or explicitly retire them')
        if work['state'] == 'needs_more_evidence' and not any(item.get('work') == work['id'] for item in unresolved):
            raise ValueError('needs_more_evidence branch must remain explicit in resolution')
    refs = list(resolution['evidence_refs']) + [ref for item in unresolved for ref in item.get('evidence_refs', [])]
    targets = review['basis']['targets']
    for ref in refs:
        if not isinstance(ref, str):
            raise ValueError('invalid resolution evidence reference')
        if ref.startswith('work:') and '@' in ref:
            ident, revision = ref[5:].rsplit('@', 1)
            work = works.get(ident)
            if not work or not revision.isdigit() or int(revision) != work.get('result_revision', 0) or not work.get('result') or run.get('targets') != targets:
                raise ValueError('stale resolution work evidence')
        elif ref.startswith('record:'):
            evidence = con.execute('SELECT data FROM records WHERE task=? AND id=?', (task, ref[7:])).fetchone()
            if not evidence:
                raise ValueError('resolution evidence is absent or belongs to another task')
            data = json.loads(evidence[0])
            if data.get('target') and not any(t['id'] == data['target'] and t['generation'] == data.get('generation') for t in targets):
                raise ValueError('resolution evidence target generation is stale')
        else:
            raise ValueError('resolution evidence must be record:ID or work:ID@RESULT_REVISION')

def process_identity(pid):
    try:
        raw = Path('/proc') / str(pid) / 'stat'
        parts = raw.read_text().rsplit(')', 1)[1].split()
        if parts[0] == 'Z':
            return None
        boot = Path('/proc/sys/kernel/random/boot_id').read_text().strip()
        return boot + ':' + parts[19]
    except (OSError, IndexError):
        return None

def inspect_status(con, task):
    data = get_task(con, task)
    def rows(table):
        return [dict(x) for x in con.execute('SELECT * FROM ' + table + ' WHERE task=?', (task,))]
    resources = reconcile_resources(con, task)
    leases = rows('leases')
    for item in leases:
        item['expired'] = item['expires'] <= time.time()
    targets = rows('targets')
    for item in targets:
        item['data'] = json.loads(item['data'])
        latest = con.execute('SELECT MAX(generation) FROM targets WHERE task=? AND id=?', (task, item['id'])).fetchone()[0]
        item['current'] = item['generation'] == latest
    records = rows('records')
    for item in records:
        item['data'] = json.loads(item['data'])
    result = {'task': data, 'targets': targets, 'resources': resources, 'leases': leases, 'records': records}
    if con.execute("SELECT 1 FROM sqlite_master WHERE name='orch_runs'").fetchone():
        row = con.execute('SELECT data FROM orch_runs WHERE task=?', (task,)).fetchone()
        if row:
            run = json.loads(row[0]); review = run.get('resolution_review') or {}
            result['orchestration_decision'] = {'state': review.get('state', 'pending'), 'current': review.get('basis') == orchestration_basis(con, task, run),
                                               'resolution': review.get('resolution'), 'delivery': review.get('delivery'), 'authority': 'coordinator assessment, not verified goal completion'}
    return result

def reconcile_resources(con, task):
    resources = [dict(x) for x in con.execute('SELECT * FROM resources WHERE task=?', (task,))]
    for item in resources:
        data = json.loads(item['data'])
        pid = data.get('pid')
        if pid:
            item['identity_matches'] = process_identity(int(pid)) == data.get('process_identity')
            if data.get('status') == 'active' and not item['identity_matches']:
                data['status'] = 'inactive'
                data['outcome'] = 'unknown-reconcile-before-retry'
                con.execute('UPDATE resources SET data=? WHERE id=?', (packed(data), item['id']))
                event(con, 'resource-observed-inactive', {'id': item['id'], 'pid': pid}, task=task)
        item['data'] = data
    return resources

def active_resource_count(con, task, exclude=None):
    return sum(item['id'] != exclude and item['data'].get('status') == 'active' for item in reconcile_resources(con, task))


def require_native_jobs_stopped(con, task, target=None):
    if con.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='orch_work'").fetchone():
        active = con.execute("SELECT id FROM orch_work WHERE task=? AND json_extract(data,'$.state') IN ('launching','running','stopping','cleanup_unknown') LIMIT 1", (task,)).fetchone()
        if active:
            raise ValueError('orchestrated Solver cleanup unconfirmed; pause/cancel in its owning host before changing task/target')
    if not con.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='analysis_native_jobs'").fetchone():
        return
    rows = con.execute('SELECT data FROM analysis_native_jobs WHERE task=?', (task,))
    for row in rows:
        data = json.loads(row[0])
        if (target is None or data.get('target_id') == target) and data.get('status') in ('launching', 'running', 'stopping', 'cleanup_unknown'):
            raise ValueError('native job cleanup unconfirmed; use owning host analysis_session lifecycle entry before changing task/target')

def check_lease(con, resource, task, owner, token):
    row = con.execute('SELECT * FROM leases WHERE resource=?', (resource,)).fetchone()
    if not row or row['task'] != task or row['owner'] != owner or row['token'] != token or row['expires'] <= time.time():
        raise ValueError('write lease absent, expired, or owned by another actor')
    return row

def execute(args):
    if args.command == 'discover':
        return discover(args)
    if args.command == 'guard':
        return guard(args)
    with database() as con:
        task = getattr(args, 'task', None)
        if args.command == 'init':
            task = args.id or uuid.uuid4().hex
            data = {'id': task, 'goal': args.goal, 'status': 'running', 'created_at': time.time(),
                    'constraints': load_data(args), 'checkpoint': {}, 'schema_version': 1}
            con.execute('INSERT INTO tasks VALUES(?,?)', (task, packed(data)))
            if args.session:
                existing = con.execute('SELECT task FROM sessions WHERE id=?', (args.session,)).fetchone()
                if existing and existing[0] and existing[0] != task:
                    raise ValueError('session already bound; use bind to explicitly reassign')
                con.execute('INSERT INTO sessions(id,task,cwd) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET task=excluded.task',
                            (args.session, task, str(Path.cwd())))
            event(con, 'task-created', data, args.session or '', task)
            return data
        if args.command == 'health':
            integrity = con.execute('PRAGMA quick_check').fetchone()[0]
            return {'status': 'ok' if integrity == 'ok' else 'degraded', 'integrity': integrity,
                    'state': str(STATE), 'runtime_version': VERSION,
                    'counts': {table: con.execute('SELECT COUNT(*) FROM ' + table).fetchone()[0]
                               for table in ('tasks', 'sessions', 'events', 'records', 'leases', 'resources')},
                    'last_event_at': con.execute('SELECT MAX(ts) FROM events').fetchone()[0]}
        if args.command == 'list':
            return [json.loads(row[0]) for row in con.execute('SELECT data FROM tasks')]
        get_task(con, task)
        if args.command == 'status':
            return inspect_status(con, task)
        if args.command == 'bind':
            old = con.execute('SELECT task FROM sessions WHERE id=?', (args.session,)).fetchone()
            if old and old[0] and old[0] != task:
                require_native_jobs_stopped(con, old[0])
            con.execute('INSERT INTO sessions(id,task,cwd) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET task=excluded.task',
                        (args.session, task, str(Path.cwd())))
            event(con, 'session-bound', {}, args.session, task)
            return {'bound': args.session, 'task': task}
        if args.command in ('checkpoint', 'transition'):
            data = get_task(con, task)
            checkpoint = load_data(args)
            if args.command == 'transition':
                if args.status != 'running':
                    require_native_jobs_stopped(con, task)
                if args.status != data['status'] and args.status not in TRANSITIONS[data['status']]:
                    raise ValueError('invalid task transition')
                if args.status != 'running' and not checkpoint.get('summary'):
                    raise ValueError('non-running transition needs a checkpoint summary')
                active = [x['data'] for x in reconcile_resources(con, task) if x['data'].get('status') == 'active']
                if args.status in ('paused', 'complete', 'cancelled') and active and not checkpoint.get('resource_plan'):
                    raise ValueError('active resources need explicit resource_plan; they are not terminated automatically')
                if args.status == 'complete' and con.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='mem_work'").fetchone():
                    pending = con.execute("SELECT id FROM mem_work WHERE task=? AND state NOT IN ('adopted','retired') LIMIT 1", (task,)).fetchone()
                    if pending:
                        raise ValueError('unresolved collaboration work remains; review or retire it explicitly')
                if args.status == 'complete' and checkpoint.get('unresolved'):
                    raise ValueError('unresolved objective remains; save checkpoint and pause/block as appropriate')
                if args.status == 'complete':
                    require_orchestration_resolution(con, task)
                data['status'] = args.status
            data['checkpoint'] = checkpoint
            data['updated_at'] = time.time()
            save_task(con, task, data)
            event(con, args.command, checkpoint, task=task)
            return data
        if args.command == 'target':
            require_native_jobs_stopped(con, task, args.id)
            data = load_data(args)
            current = con.execute('SELECT MAX(generation) FROM targets WHERE task=? AND id=?', (task, args.id)).fetchone()[0] or 0
            generation = current + 1
            con.execute('INSERT INTO targets VALUES(?,?,?,?)', (task, args.id, generation, packed(data)))
            event(con, 'target-generation', {'id': args.id, 'generation': generation, 'data': data}, task=task)
            return {'target': args.id, 'generation': generation}
        if args.command == 'artifact':
            path = Path(args.path).resolve(strict=True)
            h = hashlib.sha256()
            with path.open('rb') as stream:
                for chunk in iter(lambda: stream.read(1048576), b''):
                    h.update(chunk)
            digest = h.hexdigest()
            data = {'path': str(path), 'sha256': digest, 'size': path.stat().st_size}
            con.execute('INSERT OR IGNORE INTO artifacts VALUES(?,?)', (digest, packed(data)))
            event(con, 'artifact-linked', data, task=task)
            return data
        if args.command == 'record':
            data = load_data(args)
            if data.get('target'):
                valid_target(con, task, data['target'], data.get('generation'))
            if args.kind == 'claim':
                if data.get('origin') not in ('observed', 'inferred'):
                    raise ValueError('claim needs origin: observed|inferred')
                if data.get('verification') not in ('untested', 'tested', 'accepted'):
                    raise ValueError('claim needs verification: untested|tested|accepted')
                evidence = data.get('evidence', [])
                if not isinstance(evidence, list):
                    raise ValueError('evidence must be an array of evidence record IDs')
                for evidence_id in evidence:
                    row = con.execute('SELECT kind,data FROM records WHERE id=? AND task=?', (evidence_id, task)).fetchone()
                    if not row or row[0] != 'evidence':
                        raise ValueError('unknown evidence record: ' + str(evidence_id))
                    linked = json.loads(row[1])
                    if data.get('target') and (linked.get('target'), linked.get('generation')) != (data['target'], data.get('generation')):
                        raise ValueError('evidence from another target/generation must be explicitly revalidated')
                if data['verification'] != 'untested' and not evidence:
                    raise ValueError('tested/accepted claim needs evidence references')
                if data['verification'] == 'accepted':
                    raise ValueError('trusted acceptance-receipt adapter not configured; new accepted promotion refused')
            if args.kind == 'evidence':
                path = Path(data['path']).resolve(strict=True)
                if not path.is_file():
                    raise ValueError('evidence must be a real file')
                data['path'] = str(path)
                data['sha256'] = hashlib.sha256(path.read_bytes()).hexdigest()
            ident = uuid.uuid4().hex
            con.execute('INSERT INTO records VALUES(?,?,?,?)', (ident, task, args.kind, packed(data)))
            event(con, args.kind, {'id': ident, 'data': data}, task=task)
            return {'id': ident, 'kind': args.kind, 'data': data}
        if args.command == 'lease':
            if args.ttl <= 0:
                raise ValueError('ttl must be positive')
            row = con.execute('SELECT * FROM leases WHERE resource=?', (args.resource,)).fetchone()
            if args.action == 'acquire':
                if get_task(con, task)['status'] != 'running':
                    raise ValueError('only running tasks acquire leases')
                if row and row['expires'] > time.time():
                    raise ValueError('resource already leased; renew with its current token')
                token = uuid.uuid4().hex
                con.execute('INSERT OR REPLACE INTO leases VALUES(?,?,?,?,?)',
                            (args.resource, task, args.owner, token, time.time() + args.ttl))
            else:
                check_lease(con, args.resource, task, args.owner, args.token)
                token = args.token
                if args.action == 'release':
                    con.execute('DELETE FROM leases WHERE resource=?', (args.resource,))
                else:
                    con.execute('UPDATE leases SET expires=? WHERE resource=?', (time.time() + args.ttl, args.resource))
            event(con, 'lease-' + args.action, {'resource': args.resource, 'owner': args.owner}, task=task)
            return {'resource': args.resource, 'token': token, 'action': args.action}
        if args.command == 'resource':
            data = load_data(args)
            if data.get('pid'):
                identity = process_identity(int(data['pid']))
                if not identity:
                    raise ValueError('PID is not a live Linux process')
                data['process_identity'] = identity
            data.setdefault('status', 'active')
            old = con.execute('SELECT task FROM resources WHERE id=?', (args.id,)).fetchone()
            if old and old[0] != task:
                raise ValueError('resource belongs to another task')
            cap = get_task(con, task).get('constraints', {}).get('max_active_resources')
            if cap is not None and data['status'] == 'active':
                active = active_resource_count(con, task, exclude=args.id)
                if active >= int(cap):
                    raise ValueError('explicit max_active_resources budget exhausted')
            con.execute('INSERT OR REPLACE INTO resources VALUES(?,?,?)', (args.id, task, packed(data)))
            event(con, 'resource-registered', {'id': args.id, 'data': data}, task=task)
            return data
        if args.command == 'events':
            return [dict(row) for row in con.execute('SELECT * FROM events WHERE task=? ORDER BY id DESC LIMIT ?', (task, args.limit))]
    raise ValueError('unsupported command')

def discover(args):
    tools = args.tools or ['python3', 'node', 'java', 'file', 'gdb', 'tshark', 'ffuf', 'sage', 'wine']
    result = {'checked_at': time.time(), 'system': platform.platform(), 'architecture': platform.machine(),
              'python': sys.executable, 'tools': {t: shutil.which(t) for t in tools}, 'venvs': {},
              'proxy_variable_names': sorted(k for k in os.environ if k.lower() in ('http_proxy', 'https_proxy', 'all_proxy', 'no_proxy')),
              'invalidate_on': ['environment/path change', 'interpreter/package update', 'execution failure']}
    for name in ('ghidra-rpc-venv', 're-tools-venv', 're-pwn-venv', 'ctf-venv', 'unpacker-venv'):
        path = Path.home() / name / 'bin/python3'
        if path.exists():
            result['venvs'][name] = str(path)
    if args.python and args.module:
        probe = subprocess.run([args.python, '-c', 'import importlib,sys; importlib.import_module(sys.argv[1]); print("import-ok")', args.module],
                               capture_output=True, text=True, timeout=15)
        result['import_probe'] = {'interpreter': args.python, 'module': args.module, 'returncode': probe.returncode,
                                  'stdout': probe.stdout[-1000:], 'stderr': probe.stderr[-1000:]}
    return result

def guard(args):
    cmd = args.argv[1:] if args.argv and args.argv[0] == '--' else args.argv
    if not cmd:
        raise ValueError('guard needs a command after --')
    # Reserve the lease across the operation. Expired old tokens cannot recover it.
    with database() as con:
        if get_task(con, args.task)['status'] != 'running':
            raise ValueError('task is not running')
        check_lease(con, args.resource, args.task, args.owner, args.token)
        if args.target:
            valid_target(con, args.task, args.target, args.generation)
        if args.timeout <= 0:
            raise ValueError('timeout must be positive')
        con.execute('UPDATE leases SET expires=? WHERE resource=?', (time.time() + args.timeout + 30, args.resource))
        event(con, 'guard-dispatch', {'resource': args.resource, 'command_hash': hashlib.sha256(packed(cmd).encode()).hexdigest()}, task=args.task)
    # Infrastructure enforces dispatch conditions, not the correctness of arbitrary code.
    import signal
    proc = subprocess.Popen(cmd, start_new_session=True)
    deadline = time.monotonic() + args.timeout
    def stop_tree():
        try:
            os.killpg(proc.pid, signal.SIGTERM)
        except ProcessLookupError:
            return
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            pass
        # The process leader may exit while descendants remain.
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        proc.wait()
    try:
        while proc.poll() is None:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                stop_tree()
                rc = 124
                break
            try:
                rc = proc.wait(timeout=min(1, remaining))
            except subprocess.TimeoutExpired:
                with database() as con:
                    check_lease(con, args.resource, args.task, args.owner, args.token)
                    if get_task(con, args.task)['status'] != 'running':
                        raise ValueError('task changed state during guarded operation; outcome needs reconciliation')
                    if args.target:
                        valid_target(con, args.task, args.target, args.generation)
        else:
            rc = proc.returncode
        stop_tree()
    except BaseException:
        stop_tree()
        with database() as con:
            event(con, 'guard-interrupted', {'resource': args.resource, 'outcome': 'unknown-reconcile-before-retry'}, task=args.task)
        raise
    with database() as con:
        event(con, 'guard-result', {'resource': args.resource, 'returncode': rc,
                                  'outcome': 'unknown-reconcile-before-retry' if rc == 124 else 'returned'}, task=args.task)
    return {'returncode': rc}

def parser():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--version', action='version', version=VERSION)
    commands = ap.add_subparsers(dest='command', required=True)
    def data(p):
        group = p.add_mutually_exclusive_group()
        group.add_argument('--file')
        group.add_argument('--data', default='{}')
    p = commands.add_parser('init'); p.add_argument('--goal', required=True); p.add_argument('--id'); p.add_argument('--session'); data(p)
    commands.add_parser('list')
    commands.add_parser('health')
    for name in ('status', 'bind', 'checkpoint', 'transition', 'target', 'artifact', 'record', 'lease', 'resource', 'events', 'guard'):
        p = commands.add_parser(name); p.add_argument('task')
        if name in ('checkpoint', 'transition', 'target', 'record', 'resource'): data(p)
        if name in ('target', 'resource'): p.add_argument('--id', required=True)
        if name == 'bind': p.add_argument('--session', required=True)
        if name == 'transition': p.add_argument('--status', required=True, choices=list(TRANSITIONS))
        if name == 'artifact': p.add_argument('--path', required=True)
        if name == 'record': p.add_argument('--kind', required=True, choices=['experiment', 'evidence', 'claim', 'hypothesis', 'handoff', 'note'])
        if name == 'events': p.add_argument('--limit', type=int, default=50)
        if name in ('lease', 'guard'):
            p.add_argument('--resource', required=True); p.add_argument('--owner', required=True); p.add_argument('--token')
        if name == 'lease':
            p.add_argument('--action', required=True, choices=['acquire', 'renew', 'release']); p.add_argument('--ttl', type=float, default=300)
        if name == 'guard':
            p.add_argument('--target'); p.add_argument('--generation', type=int); p.add_argument('--timeout', type=float, default=300)
    p = commands.add_parser('discover'); p.add_argument('--tools', nargs='*'); p.add_argument('--python'); p.add_argument('--module')
    return ap

if __name__ == '__main__':
    try:
        cli = sys.argv[1:]
        separator = cli.index('--') if '--' in cli else len(cli)
        args = parser().parse_args(cli[:separator])
        args.argv = cli[separator + 1:]
        result = execute(args)
        print(packed({'ok': True, 'result': result}))
        sys.exit(result['returncode'] if args.command == 'guard' else 0)
    except (ValueError, OSError, sqlite3.Error, subprocess.TimeoutExpired) as exc:
        print(packed({'ok': False, 'error': str(exc)}), file=sys.stderr)
        sys.exit(2)
