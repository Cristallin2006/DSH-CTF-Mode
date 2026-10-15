#!/usr/bin/env python3
"""Logged bounded process-tree runner; optional analysis resource registration."""
import argparse
import os
from pathlib import Path
import signal
import subprocess
import sys
import threading
import time
import uuid

def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--timeout', type=float, required=True)
    ap.add_argument('--log', required=True)
    ap.add_argument('--heartbeat', type=float, default=30)
    ap.add_argument('--grace', type=float, default=5)
    ap.add_argument('--task')
    ap.add_argument('--resource-id')
    ap.add_argument('cmd', nargs=argparse.REMAINDER)
    args = ap.parse_args()
    cmd = args.cmd[1:] if args.cmd and args.cmd[0] == '--' else args.cmd
    if not cmd or min(args.timeout, args.heartbeat) <= 0 or args.grace < 0:
        ap.error('command, positive timeout/heartbeat and nonnegative grace required')
    path = Path(args.log).resolve()
    path.parent.mkdir(parents=True, exist_ok=True)
    ident = args.resource_id or ('job:' + uuid.uuid4().hex)
    if args.task:
        import session
        with session.database() as con:
            task = session.get_task(con, args.task)
            if task['status'] != 'running':
                raise ValueError('task is not running')
            old = con.execute('SELECT task FROM resources WHERE id=?', (ident,)).fetchone()
            if old:
                raise ValueError('resource ID already registered; choose a new ID')
            cap = task.get('constraints', {}).get('max_active_resources')
            active = session.active_resource_count(con, args.task)
            if cap is not None and active >= int(cap):
                raise ValueError('explicit max_active_resources budget exhausted')
            con.execute('INSERT INTO resources VALUES(?,?,?)',
                        (ident, args.task, session.packed({'status': 'active', 'log': str(path), 'launch_pending': True,
                                                        'pid': os.getpid(), 'process_identity': session.process_identity(os.getpid())})))
    start = time.monotonic()
    finished = threading.Event()
    mutex = threading.Lock()
    with path.open('a', encoding='utf-8', errors='replace') as log:
        def emit(line, stdout=True):
            with mutex:
                log.write(line + '\n'); log.flush()
                if stdout:
                    print(line, flush=True)
        emit('[guarded_run] start timeout=' + str(args.timeout), False)
        env = dict(os.environ, PYTHONUNBUFFERED='1')
        try:
            proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                    text=True, errors='replace', env=env, start_new_session=True)
        except BaseException:
            if args.task:
                with session.database() as con:
                    con.execute('UPDATE resources SET data=? WHERE id=?', (session.packed({'status': 'launch-failed', 'log': str(path)}), ident))
            raise
        def register(status, rc=None):
            if not args.task:
                return
            import session
            with session.database() as con:
                session.get_task(con, args.task)
                old = con.execute('SELECT task FROM resources WHERE id=?', (ident,)).fetchone()
                if old and old[0] != args.task:
                    raise ValueError('resource ID owned by another task')
                data = {'status': status, 'pid': proc.pid, 'process_identity': session.process_identity(proc.pid),
                        'log': str(path), 'returncode': rc, 'timeout': args.timeout}
                cap = session.get_task(con, args.task).get('constraints', {}).get('max_active_resources')
                if status == 'active' and cap is not None:
                    active = session.active_resource_count(con, args.task, exclude=ident)
                    if active >= int(cap):
                        raise ValueError('explicit max_active_resources budget exhausted')
                con.execute('INSERT OR REPLACE INTO resources VALUES(?,?,?)', (ident, args.task, session.packed(data)))
                session.event(con, 'job-' + status, data, task=args.task)
        def stop_tree():
            try:
                os.killpg(proc.pid, signal.SIGTERM)
            except ProcessLookupError:
                return
            try:
                proc.wait(timeout=args.grace)
            except subprocess.TimeoutExpired:
                pass
            # Always cover descendants even if their parent already exited.
            try:
                os.killpg(proc.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            proc.wait()
        last_output = [time.monotonic()]
        def reader():
            for line in proc.stdout:
                last_output[0] = time.monotonic()
                emit(line.rstrip('\n'))
        def heartbeat():
            while not finished.wait(args.heartbeat):
                if time.monotonic() - last_output[0] >= args.heartbeat:
                    emit('[guarded_run] alive elapsed=' + str(round(time.monotonic() - start, 1)), False)
        reader_thread = threading.Thread(target=reader, daemon=True)
        pulse = threading.Thread(target=heartbeat, daemon=True)
        reader_thread.start(); pulse.start()
        previous = {}
        def interrupted(signum, frame):
            raise KeyboardInterrupt()
        for sig in (signal.SIGINT, signal.SIGTERM):
            previous[sig] = signal.signal(sig, interrupted)
        rc = 1
        status = 'failed'
        try:
            register('active')
            rc = proc.wait(timeout=args.timeout)
            stop_tree()
            status = 'finished'
        except subprocess.TimeoutExpired:
            emit('[guarded_run] TIMEOUT; terminate process group', False)
            stop_tree(); rc = 124; status = 'timed-out'
        except KeyboardInterrupt:
            emit('[guarded_run] interrupted; terminate process group', False)
            stop_tree(); rc = 130; status = 'interrupted'
        except BaseException:
            stop_tree()
            raise
        finally:
            finished.set()
            reader_thread.join(timeout=args.grace + 1)
            for sig, old in previous.items():
                signal.signal(sig, old)
        register(status, rc)
        emit('[guarded_run] ' + status + ' rc=' + str(rc) + ' elapsed=' + str(round(time.monotonic() - start, 2)) + ' log=' + str(path))
        return rc

if __name__ == '__main__':
    sys.exit(main())
