"""Linux local worker, independent of model/transport/service connections."""
import fcntl
import json
import os
from pathlib import Path
import signal
import sqlite3
import subprocess
import sys
import tempfile
import threading
import time
from _re_evidence import canonical, read_json
from _re_owner_store import digest, identity, file_identity, task_still_running


def atomic(path,value):
    fd,tmp=tempfile.mkstemp(prefix='.owner-',dir=path.parent)
    try:
        with os.fdopen(fd,'wb') as f:f.write(canonical(value));f.flush();os.fsync(f.fileno())
        os.replace(tmp,path)
        d=os.open(path.parent,os.O_RDONLY|os.O_DIRECTORY)
        try:os.fsync(d)
        finally:os.close(d)
    finally:Path(tmp).unlink(missing_ok=True)


def group_running(pgid):
    for p in Path('/proc').iterdir():
        if not p.name.isdigit():continue
        try:
            fields=(p/'stat').read_text().rsplit(')',1)[1].split()
            if int(fields[2])==pgid and fields[0]!='Z':return True
        except (OSError,ValueError,IndexError):pass
    return False


def stop_group(process):
    # Caller has not reaped the leader, reserving its PID until the last signal.
    for sig in (signal.SIGTERM,signal.SIGKILL):
        try:os.killpg(process.pid,sig)
        except ProcessLookupError:pass
        if sig==signal.SIGTERM:time.sleep(.1)
    code=process.wait(timeout=3)
    until=time.monotonic()+2
    while group_running(process.pid) and time.monotonic()<until:time.sleep(.02)
    return code,not group_running(process.pid)


def run(root,jid):
    root=Path(root);jobdir=root/'jobs'/jid;plan=read_json(jobdir/'plan.json')
    lock=open(jobdir/'worker.lock','a+b')
    try:fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
    except BlockingIOError:return
    worker={'pid':os.getpid(),'birth':identity(os.getpid())}
    runtime={'job':jid,'nonce':plan['nonce'],'worker':worker,'phase':'starting','process':None}
    atomic(jobdir/'runtime.json',runtime)
    with sqlite3.connect((root/'owner.sqlite3').as_uri()+'?mode=ro',uri=True) as con:
        row=con.execute('SELECT data FROM jobs WHERE id=?',(jid,)).fetchone()
    current=json.loads(row[0]) if row else {}
    if current.get('nonce')!=plan['nonce'] or current.get('state') not in ('launching','cancel_requested'):
        return  # A reconciler fenced a delayed/duplicate worker; never replay.
    process=None;reaped=False;drainers=[];stats={};bytes_total=[0];output_limit=threading.Event();io_failed=threading.Event();counter_lock=threading.Lock()
    reason='not_started';code=None;clean=True
    try:
        if (jobdir/'cancel.json').exists() or current['state']=='cancel_requested' or not task_still_running(plan['state_root'],plan['principal']):
            reason='cancelled_before_start'
        else:
            env={k:v for k,v in os.environ.items() if k in ('PATH','HOME','LANG','TMPDIR','TEMP','TMP')}
            env.update(plan['backend'].get('env',{}))
            process=subprocess.Popen(plan['argv'],cwd=plan['cwd'],env=env,stdin=subprocess.DEVNULL,
                                     stdout=subprocess.PIPE,stderr=subprocess.PIPE,start_new_session=True)
            runtime.update(phase='running',process={'pid':process.pid,'birth':identity(process.pid,allow_zombie=True),'pgid':process.pid})
            atomic(jobdir/'runtime.json',runtime)
            def drain(name,pipe):
                import hashlib
                h=hashlib.sha256();written=0;observed=0
                try:
                    fd=os.open(jobdir/(name+'.bin'),os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
                    with os.fdopen(fd,'wb') as output:
                        while True:
                            block=os.read(pipe.fileno(),65536)
                            if not block:break
                            observed+=len(block)
                            with counter_lock:
                                amount=max(0,min(len(block),plan['backend']['output_bytes']-bytes_total[0]));bytes_total[0]+=amount
                            if amount:output.write(block[:amount]);h.update(block[:amount]);written+=amount
                            if amount<len(block):output_limit.set()
                        output.flush();os.fsync(output.fileno())
                except (OSError,ValueError):io_failed.set()
                finally:
                    pipe.close()
                    try:fid=file_identity((jobdir/(name+'.bin')).stat())
                    except OSError:fid=None;io_failed.set()
                    stats[name]={'bytes':written,'observed_bytes':observed,'sha256':h.hexdigest(),'file_identity':fid,'complete':observed==written and not io_failed.is_set()}
            for name,pipe in (('stdout',process.stdout),('stderr',process.stderr)):
                t=threading.Thread(target=drain,args=(name,pipe),daemon=True);t.start();drainers.append(t)
            reason='exited';last=0
            while True:
                ended=os.waitid(os.P_PID,process.pid,os.WEXITED|os.WNOHANG|os.WNOWAIT)
                if ended is not None:break
                if (jobdir/'cancel.json').exists():reason='cancelled';break
                if not task_still_running(plan['state_root'],plan['principal']):reason='scope_invalidated';break
                if output_limit.is_set():reason='output_limit';break
                if io_failed.is_set():reason='output_error';break
                if time.monotonic()-last>.5:
                    runtime['heartbeat_at']=time.time();atomic(jobdir/'runtime.json',runtime);last=time.monotonic()
                time.sleep(.05)
            runtime['phase']='settling';atomic(jobdir/'runtime.json',runtime)
            code,clean=stop_group(process)
            reaped=True
            for t in drainers:t.join(timeout=3)
            clean=clean and not any(t.is_alive() for t in drainers)
            if io_failed.is_set():reason='output_error'
            elif output_limit.is_set():reason='output_limit'
    except BaseException:
        reason='worker_error'
        if process is not None and not reaped:
            try:code,clean=stop_group(process)
            except BaseException:clean=False
            for t in drainers:t.join(timeout=1)
        elif process is not None:clean=not group_running(process.pid) and not any(t.is_alive() for t in drainers)
    finally:
        result={'job':jid,'nonce':plan['nonce'],'worker':worker,'process':runtime['process'],'reason':reason,
                'exit_code':code,'cleanup_confirmed':clean,'artifacts':stats,'at':time.time(),
                'target_accepted':None,'authority':'owned local process group only; no detached/remote-process coverage'}
        result['receipt_sha256']=digest(result)
        atomic(jobdir/'receipt.json',result)
        lock.close()


if __name__=='__main__':run(sys.argv[1],sys.argv[2])
