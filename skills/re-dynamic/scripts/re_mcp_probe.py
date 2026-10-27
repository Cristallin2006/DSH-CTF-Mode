"""Explicit, temporary MCP stdio handshake. No device/target tool calls."""
import hashlib
import json
import os
from pathlib import Path
import queue
import signal
import subprocess
import threading
import time


def inspect_stdio(descriptor, timeout=20, max_message=2*1024*1024, max_total=8*1024*1024):
    if not isinstance(descriptor, dict) or set(descriptor)-{'argv', 'cwd', 'env'}:
        raise ValueError('Descriptor accepts argv, cwd and explicit env only')
    argv = descriptor.get('argv')
    if not isinstance(argv, list) or not argv or not all(isinstance(s, str) and s and '\x00' not in s for s in argv):
        raise ValueError('Explicit argv array required; no shell command strings')
    if not isinstance(timeout, (int, float)) or isinstance(timeout, bool) or not 0 < timeout < float('inf'):
        raise ValueError('A positive per-handshake timeout is required')
    if any(type(v) is not int or v <= 0 for v in (max_message, max_total)):
        raise ValueError('Positive transport byte bounds required')
    extra = descriptor.get('env', {})
    if not isinstance(extra, dict) or not all(isinstance(k, str) and isinstance(v, str) and k and '=' not in k and '\x00' not in k+v for k, v in extra.items()):
        raise ValueError('env must contain explicit string keys and values')
    # Normal provider/DSH credentials are not forwarded. This is not filesystem isolation.
    allowed = {'PATH','HOME','USERPROFILE','SYSTEMROOT','SystemRoot','WINDIR','TEMP','TMP','TMPDIR','LANG'}
    env = {k:v for k,v in os.environ.items() if k in allowed}
    env.update(extra)
    cwd = descriptor.get('cwd')
    if cwd is not None and (not isinstance(cwd, str) or not Path(cwd).is_dir()):
        raise ValueError('cwd must be an existing directory')
    kwargs = {'start_new_session': True} if os.name != 'nt' else {'creationflags': subprocess.CREATE_NO_WINDOW}
    process = subprocess.Popen(argv, cwd=cwd, env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                               stderr=subprocess.PIPE, **kwargs)
    messages = queue.Queue(maxsize=32)
    stop = threading.Event()
    stderr_digest, stderr_bytes, stdout_bytes = hashlib.sha256(), [0], [0]
    deadline = time.monotonic()+timeout

    def deliver(value):
        while not stop.is_set():
            try:
                messages.put(value, timeout=.05)
                return
            except queue.Full:
                pass

    def output():
        try:
            pending = bytearray()
            while not stop.is_set():
                block = os.read(process.stdout.fileno(),65536)
                if not block:
                    deliver(ValueError('MCP stdout closed before requested reply'))
                    return
                stdout_bytes[0] += len(block)
                pending.extend(block)
                if stdout_bytes[0] > max_total:
                    raise ValueError('MCP transport output exceeds explicit total byte bound')
                while b'\n' in pending:
                    end = pending.index(b'\n')+1
                    if end > max_message:
                        raise ValueError('MCP message exceeds explicit byte bound')
                    line = bytes(pending[:end]);del pending[:end]
                    def invalid_constant(_):
                        raise ValueError('Non-finite JSON constant in MCP message')
                    value = json.loads(line,parse_constant=invalid_constant)
                    if not isinstance(value, dict) or value.get('jsonrpc') != '2.0':
                        raise ValueError('Expected newline-delimited JSON-RPC 2.0')
                    deliver(value)
                if len(pending) > max_message:
                    raise ValueError('MCP message exceeds explicit byte bound')
        except (OSError, ValueError, RecursionError) as error:
            deliver(error)

    def errors():
        try:
            while True:
                data = os.read(process.stderr.fileno(),4096)
                if not data:
                    break
                stderr_digest.update(data)
                stderr_bytes[0] += len(data)
        except (OSError,ValueError):
            pass

    threads = [threading.Thread(target=output,daemon=True), threading.Thread(target=errors,daemon=True)]
    for worker in threads:
        worker.start()
    serial, notifications = [0], [0]

    def send(message):
        process.stdin.write((json.dumps(message,separators=(',',':'))+'\n').encode())
        process.stdin.flush()

    def request(method, params):
        serial[0] += 1
        ident = serial[0]
        send({'jsonrpc':'2.0','id':ident,'method':method,'params':params})
        while True:
            remaining = deadline-time.monotonic()
            if remaining <= 0:
                raise ValueError('MCP handshake deadline exceeded; no target operation was requested')
            try:
                response = messages.get(timeout=remaining)
            except queue.Empty:
                raise ValueError('MCP handshake deadline exceeded; no target operation was requested')
            if isinstance(response, Exception):
                raise ValueError(str(response))
            if 'method' in response:
                if 'id' in response:
                    if response['method'] == 'ping':
                        send({'jsonrpc':'2.0','id':response['id'],'result':{}})
                    else:
                        raise ValueError('Server requested unsupported host services')
                else:
                    notifications[0] += 1
                continue
            if type(response.get('id')) is not int or response['id'] != ident:
                raise ValueError('Unexpected MCP response identity')
            if 'error' in response:
                raise ValueError('MCP returned a protocol error for '+method)
            if not isinstance(response.get('result'), dict):
                raise ValueError('MCP result must be an object')
            return response['result']

    try:
        initialized = request('initialize', {'protocolVersion':'2025-03-26','capabilities':{},
                                            'clientInfo':{'name':'dsh-re-host-inspection','version':'0.1.0'}})
        if initialized.get('protocolVersion') != '2025-03-26':
            raise ValueError('Server selected a protocol version not supported by this inspection client')
        if not isinstance(initialized.get('serverInfo'),dict) or not isinstance(initialized.get('capabilities'),dict) or 'tools' not in initialized['capabilities']:
            raise ValueError('Server did not advertise a tool catalog')
        send({'jsonrpc':'2.0','method':'notifications/initialized'})
        tools, cursor, seen = [], None, set()
        while True:
            result = request('tools/list', {} if cursor is None else {'cursor':cursor})
            page = result.get('tools')
            if not isinstance(page, list) or not all(isinstance(t,dict) and isinstance(t.get('name'),str) for t in page):
                raise ValueError('Invalid MCP tools page')
            tools.extend(page)
            cursor = result.get('nextCursor')
            if cursor is None:
                break
            if not isinstance(cursor,str) or not cursor or cursor in seen:
                raise ValueError('Invalid/repeated MCP pagination cursor')
            seen.add(cursor)
        names = [t['name'] for t in tools]
        if len(names) != len(set(names)):
            raise ValueError('Duplicate MCP tool names')
        result = {'ok':True,'schema':'dsh-re-mcp-inspection-v1','protocol_initialized':True,
                  'server_info':initialized.get('serverInfo',{}),'protocol_version':initialized.get('protocolVersion'),
                  'advertised_tools':names,'tool_catalog_sha256':hashlib.sha256(json.dumps(tools,sort_keys=True).encode()).hexdigest(),
                  'methods_requested':['initialize','tools/list'], 'tool_calls':0,
                  'client_device_queries':0,'target_operations_requested':0,'capability_level':'advertised only',
                  'frida_attach':'not_probed','frida_spawn':'not_probed','persistent_recovery':'not_probed',
                  'host_services_offered':False,'transport_notifications':notifications[0],
                  'isolation':'owned subprocess with minimized environment; not an OS or filesystem sandbox'}
        return result
    finally:
        stop.set()
        try:
            process.stdin.close()
        except OSError:
            pass
        if os.name == 'nt':
            try:
                process.wait(timeout=.5)
            except subprocess.TimeoutExpired:
                process.terminate()
            try:
                process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=3)
        else:
            # Do not reap the group leader before the last group signal: its
            # unreaped PID prevents a new unrelated group from reusing this ID.
            time.sleep(.1)
            for sig in (signal.SIGTERM,signal.SIGKILL):
                try:
                    os.killpg(process.pid,sig)
                except ProcessLookupError:
                    pass
                if sig==signal.SIGTERM:
                    time.sleep(.1)
            process.wait(timeout=3)
        for worker in threads:
            worker.join(timeout=1)
        process.stdout.close()
        process.stderr.close()
        if 'result' in locals() and result.get('schema') == 'dsh-re-mcp-inspection-v1':
            result.update({'owned_process_reaped':True, 'cleanup_scope':'owned process group' if os.name != 'nt' else 'direct child only',
                           'stdout_bytes':stdout_bytes[0],'stderr_bytes':stderr_bytes[0], 'stderr_sha256':stderr_digest.hexdigest()})
