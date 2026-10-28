"""Managed local experiment metadata. DSH remains authoritative for tasks/work."""
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import time
import uuid
from contextlib import contextmanager
from _re_evidence import canonical, read_json, directory

ACTIVE = ('accepted','launching','running','cancel_requested','cleanup_unknown')
TERMINAL = ('finished','failed','cancelled')


def identity(pid,allow_zombie=False):
    try:
        p=Path('/proc')/str(pid)
        fields=(p/'stat').read_text().rsplit(')',1)[1].split()
        if fields[0]=='Z' and not allow_zombie:return None
        return Path('/proc/sys/kernel/random/boot_id').read_text().strip()+':'+fields[19]
    except (OSError,IndexError):return None


def resource(value):
    if not isinstance(value,dict):raise ValueError('Resource must be an object')
    if value.get('kind')=='directory' and set(value)=={'kind','path'}:
        p=Path(value['path']).expanduser().resolve(strict=True)
        if not p.is_dir():raise ValueError('Directory resource does not exist')
        return {'kind':'directory','path':str(p)}
    if value.get('kind')=='host_process' and set(value)=={'kind','pid','birth'}:
        pid=value['pid']
        if type(pid) is not int or pid<=0 or not isinstance(value['birth'],str) or identity(pid)!=value['birth']:
            raise ValueError('Host process resource identity is stale or unknown')
        return {'kind':'host_process','pid':pid,'birth':value['birth']}
    raise ValueError('Supported resource shapes: directory path or exact host_process pid/birth; no task/backend in resource keys')


def conflicts(left,right):
    if left['kind']!=right['kind']:return False
    if left['kind']=='host_process':return left['pid']==right['pid'] and left['birth']==right['birth']
    a,b=Path(left['path']),Path(right['path'])
    return a.is_relative_to(b) or b.is_relative_to(a)


def digest(value):return hashlib.sha256(canonical(value)).hexdigest()


def file_identity(st):
    # Opaque identity, not arithmetic. Preserve nanoseconds/inodes through JS JSON.
    return [str(v) for v in (st.st_dev,st.st_ino,st.st_size,st.st_mtime_ns,st.st_ctime_ns)]


def principal(value):
    keys={'realm','owner','actor','task','work','role','targets'}
    if not isinstance(value,dict) or set(value)!=keys:raise ValueError('Invalid managed principal')
    if any(not isinstance(value[k],str) or not value[k] or len(value[k])>240 for k in ('realm','owner','actor','task')):raise ValueError('Invalid principal references')
    if value['role'] not in ('parent','solver') or value['work'] is not None and not isinstance(value['work'],str):raise ValueError('Invalid principal role')
    if not isinstance(value['targets'],list) or any(not isinstance(t,dict) or set(t)!={'id','generation'} or not isinstance(t['id'],str) or type(t['generation']) is not int for t in value['targets']):raise ValueError('Invalid target basis')
    return value


def binding(config,p,launch=False):
    p=principal(p)
    realm=config['realms'].get(p['realm'])
    if not realm:raise ValueError('Scope unavailable')
    state=Path(realm).resolve(strict=True)
    con=sqlite3.connect((state/'state.sqlite3').as_uri()+'?mode=ro',uri=True,timeout=3)
    try:
        owner=con.execute('SELECT task FROM sessions WHERE id=?',(p['owner'],)).fetchone()
        row=con.execute('SELECT data FROM tasks WHERE id=?',(p['task'],)).fetchone()
        if not owner or owner[0]!=p['task'] or not row:raise ValueError('Scope unavailable')
        task=json.loads(row[0])
        if launch and task['status']!='running':raise ValueError('Task is not running')
        if p['role']=='parent':
            if p['actor']!=p['owner'] or p['work'] is not None:raise ValueError('Scope unavailable')
            if launch and con.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='orch_runs'").fetchone():
                run=con.execute('SELECT data FROM orch_runs WHERE task=?',(p['task'],)).fetchone()
                if run and json.loads(run[0]).get('state')=='enabled':raise ValueError('Coordinator delegates experiment execution to a Solver')
        else:
            row=con.execute('SELECT data FROM orch_work WHERE task=? AND id=?',(p['task'],p['work'])).fetchone()
            if not row:raise ValueError('Scope unavailable')
            work=json.loads(row[0])
            if work.get('child')!=p['actor'] or work.get('role')=='observer':raise ValueError('Scope unavailable')
            if launch:
                run=con.execute('SELECT data,owner FROM orch_runs WHERE task=?',(p['task'],)).fetchone()
                if not run or run[1]!=p['owner'] or json.loads(run[0]).get('state')!='enabled' or work.get('state') not in ('launching','running') or work.get('epoch')!=json.loads(run[0]).get('epoch'):raise ValueError('Solver execution is not current')
                if 'dsh_re_experiment' not in work.get('tools',[]):raise ValueError('Managed experiment tool was not granted')
        if launch:
            if p['role']=='parent':
                expected=[{'id':r[0],'generation':r[1]} for r in con.execute('SELECT id,MAX(generation) FROM targets WHERE task=? GROUP BY id',(p['task'],))]
            else:expected=json.loads(run[0]).get('targets',[])
            if sorted(expected,key=lambda t:t['id'])!=sorted(p['targets'],key=lambda t:t['id']):raise ValueError('Target basis differs from authoritative scope')
            for target in p['targets']:
                row=con.execute('SELECT MAX(generation) FROM targets WHERE task=? AND id=?',(p['task'],target['id'])).fetchone()
                if not row or row[0]!=target['generation']:raise ValueError('Target basis is stale')
        return state
    finally:con.close()


def task_still_running(state,p):
    """Worker follows task/target invalidation, not the model's idle state."""
    try:
        with sqlite3.connect((Path(state)/'state.sqlite3').as_uri()+'?mode=ro',uri=True,timeout=1) as con:
            row=con.execute('SELECT data FROM tasks WHERE id=?',(p['task'],)).fetchone()
            if not row or json.loads(row[0])['status']!='running':return False
            if con.execute('SELECT task FROM sessions WHERE id=?',(p['owner'],)).fetchone()!=(p['task'],):return False
            for t in p['targets']:
                if con.execute('SELECT MAX(generation) FROM targets WHERE task=? AND id=?',(p['task'],t['id'])).fetchone()!=(t['generation'],):return False
            if p['role']=='solver':
                row=con.execute('SELECT data FROM orch_work WHERE task=? AND id=?',(p['task'],p['work'])).fetchone()
                if not row:return False
                w=json.loads(row[0])
                if w.get('child')!=p['actor'] or w.get('state') in ('stopping','cancelled','cleanup_unknown','retired','failed','interrupted'):return False
                row=con.execute('SELECT data,owner FROM orch_runs WHERE task=?',(p['task'],)).fetchone()
                if not row or row[1]!=p['owner'] or json.loads(row[0]).get('state')!='enabled' or w.get('epoch')!=json.loads(row[0]).get('epoch'):return False
        return True
    except (OSError,sqlite3.Error,ValueError):return False


def register_job(state,p,job,status):
    # Only additive lifecycle metadata; no task/work/target mutation.
    with sqlite3.connect(Path(state)/'state.sqlite3',timeout=5) as con:
        con.execute('CREATE TABLE IF NOT EXISTS analysis_native_jobs(id TEXT PRIMARY KEY,task TEXT NOT NULL,owner TEXT NOT NULL,data TEXT NOT NULL)')
        key='re-owner:'+job['registry']+':'+job['id']
        data={'kind':'re_owner','registry':job['registry'],'job_id':job['id'],'status':status,
              'work':p['work'],'target_basis':p['targets'],'owner_root':job['owner_root']}
        old=con.execute('SELECT task,owner FROM analysis_native_jobs WHERE id=?',(key,)).fetchone()
        if old and old!=(p['task'],p['owner']):raise ValueError('Lifecycle registration conflict')
        con.execute('INSERT INTO analysis_native_jobs VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data',(key,p['task'],p['owner'],json.dumps(data)))


class Store:
    def __init__(self,root):
        self.root=directory(root,True)
        self.db=sqlite3.connect(self.root/'owner.sqlite3',timeout=5,check_same_thread=False)
        os.chmod(self.root/'owner.sqlite3',0o600)
        self.db.row_factory=sqlite3.Row
        self.db.executescript('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT); CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY,opkey TEXT UNIQUE,intent TEXT,data TEXT); CREATE TABLE IF NOT EXISTS leases(key TEXT PRIMARY KEY,job TEXT,data TEXT); CREATE TABLE IF NOT EXISTS events(job TEXT,seq INTEGER,data TEXT,PRIMARY KEY(job,seq));')
        if not self.db.execute("SELECT value FROM meta WHERE key='registry'").fetchone():
            self.db.execute('INSERT INTO meta VALUES(?,?)',('registry',uuid.uuid4().hex));self.db.commit()
        self.registry=self.db.execute("SELECT value FROM meta WHERE key='registry'").fetchone()[0]
    @contextmanager
    def transaction(self):
        self.db.execute('BEGIN IMMEDIATE')
        try:yield;self.db.commit()
        except BaseException:self.db.rollback();raise
    def get(self,jid):
        row=self.db.execute('SELECT data FROM jobs WHERE id=?',(jid,)).fetchone()
        if not row:raise ValueError('Experiment unavailable')
        return json.loads(row[0])
    def save(self,j):self.db.execute('UPDATE jobs SET data=? WHERE id=?',(json.dumps(j),j['id']))
    def event(self,j,kind,details=None):
        seq=self.db.execute('SELECT COALESCE(MAX(seq),0)+1 FROM events WHERE job=?',(j['id'],)).fetchone()[0]
        self.db.execute('INSERT INTO events VALUES(?,?,?)',(j['id'],seq,json.dumps({'seq':seq,'kind':kind,'at':time.time(),'details':details or {}})))
    def release(self,j):self.db.execute('DELETE FROM leases WHERE job=?',(j['id'],))
    def authorize(self,p,j):
        owner=j['principal']
        if any(p[k]!=owner[k] for k in ('realm','owner','task')) or p['role']=='solver' and (p['work']!=owner['work'] or p['actor']!=owner['actor']):raise ValueError('Experiment unavailable')
    def close(self):self.db.close()
