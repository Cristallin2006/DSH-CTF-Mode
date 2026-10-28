#!/usr/bin/env python3
"""Opt-in Linux owner for configured local experiments, not an OS sandbox."""
import argparse
import base64
import fcntl
import hashlib
import hmac
import json
import os
from pathlib import Path
import secrets
import socket
import socketserver
import sqlite3
import subprocess
import sys
import threading
import time
import uuid
from _re_evidence import canonical, read_json
from _re_owner_store import ACTIVE, TERMINAL, Store, binding, conflicts, digest, identity, file_identity, principal, register_job, resource
from _re_owner_worker import atomic, group_running

MAX_RPC=131072


def configuration(path):
    c=read_json(path)
    if set(c)!={'realms','backends'} or not isinstance(c['realms'],dict) or not c['realms'] or not isinstance(c['backends'],dict):raise ValueError('Config requires realms and backends')
    c['realms']={k:str(Path(v).resolve(strict=True)) for k,v in c['realms'].items()}
    for name,b in c['backends'].items():
        if not name or not isinstance(b,dict) or set(b)-{'argv','cwd','resources','allow_arguments','output_bytes','env'}:raise ValueError('Invalid backend config')
        if not isinstance(b.get('argv'),list) or not b['argv'] or any(not isinstance(a,str) or '\0' in a for a in b['argv']) or not Path(b['argv'][0]).is_absolute():raise ValueError('Backend needs an absolute trusted executable argv')
        b.setdefault('resources',[]);b.setdefault('allow_arguments',False);b.setdefault('output_bytes',8388608);b.setdefault('env',{})
        if type(b['allow_arguments']) is not bool or type(b['output_bytes']) is not int or b['output_bytes']<1:raise ValueError('Invalid backend policy')
        if not isinstance(b['env'],dict) or any(not isinstance(k,str) or not isinstance(v,str) or '\0' in k+v or '=' in k for k,v in b['env'].items()):raise ValueError('Invalid backend environment')
        if not isinstance(b['resources'],list):raise ValueError('Invalid resource declaration')
        # Validate declarations without requiring old targets to stay alive just
        # to restart/recover the owner. Resolve/live-check only on NEW submission.
        for r in b['resources']:
            if not isinstance(r,dict) or not (r.get('kind')=='directory' and set(r)=={'kind','path'} and isinstance(r['path'],str) and Path(r['path']).is_absolute() or r.get('kind')=='host_process' and set(r)=={'kind','pid','birth'} and type(r['pid']) is int and r['pid']>0 and isinstance(r['birth'],str)):raise ValueError('Invalid resource declaration')
        if 'cwd' in b and (not isinstance(b['cwd'],str) or not Path(b['cwd']).is_absolute()):raise ValueError('Backend cwd must be absolute')
    return c


class Owner:
    def __init__(self,root,config):
        self.root=Path(root).resolve();self.config=config;self.store=Store(self.root);self.lock=threading.RLock();self.workers={}
        (self.root/'jobs').mkdir(mode=0o700,exist_ok=True)
    def public(self,j):
        return {k:j[k] for k in ('id','operation_id','backend','state','created_at','updated_at','reason','resources','receipt','registry') if k in j}|{'target_accepted':None}
    def set(self,j,state,reason):
        j.update(state=state,reason=reason,updated_at=time.time())
        with self.store.transaction():self.store.save(j);self.store.event(j,state,{'reason':reason})
    def publish(self,j):
        status={'accepted':'launching','cancel_requested':'stopping'}.get(j['state'],j['state'])
        register_job(j['state_root'],j['principal'],j,status)
    def finish(self,j,state,reason,receipt=None):
        # Persist terminal receipt first; keep leases until DSH lifecycle metadata is durable.
        j.update(state=state,reason=reason,updated_at=time.time(),receipt=receipt)
        with self.store.transaction():self.store.save(j);self.store.event(j,state,{'reason':reason})
        self.publish(j)
        with self.store.transaction():self.store.release(j)
    def refresh(self,j):
        if j['state'] in TERMINAL:
            self.publish(j)
            with self.store.transaction():self.store.release(j)
            return j
        jobdir=self.root/'jobs'/j['id'];rp=jobdir/'receipt.json'
        proc=self.workers.get(j['id'])
        if proc and proc.poll() is not None:self.workers.pop(j['id'],None)
        if rp.exists():
            try:
                r=read_json(rp);checksum=r.pop('receipt_sha256');valid=hmac.compare_digest(digest(r),checksum)
                if not valid or r['job']!=j['id'] or r['nonce']!=j['nonce'] or not r['cleanup_confirmed']:raise ValueError('Unconfirmed receipt')
                runtime=read_json(jobdir/'runtime.json')
                if r['worker']!=runtime['worker'] or r['process']!=runtime['process']:raise ValueError('Receipt identity mismatch')
                if r['process'] and group_running(r['process']['pgid']):raise ValueError('Owned group cleanup unconfirmed')
                for name,a in r['artifacts'].items():
                    if name not in ('stdout','stderr'):raise ValueError('Unexpected artifact')
                    p=jobdir/(name+'.bin')
                    with open(p,'rb') as f:
                        if file_identity(os.fstat(f.fileno()))!=a['file_identity']:raise ValueError('Artifact snapshot changed')
                        h=hashlib.sha256()
                        for block in iter(lambda:f.read(65536),b''):h.update(block)
                        if file_identity(os.fstat(f.fileno()))!=a['file_identity']:raise ValueError('Artifact snapshot changed')
                    if p.stat().st_size!=a['bytes'] or h.hexdigest()!=a['sha256']:raise ValueError('Artifact mismatch')
                r['receipt_sha256']=checksum
                state='cancelled' if r['reason'] in ('cancelled','cancelled_before_start','scope_invalidated') else 'finished' if r['reason']=='exited' and r['exit_code']==0 else 'failed'
                self.finish(j,state,r['reason'],r);return j
            except (OSError,ValueError,KeyError,TypeError):
                if j['state']!='cleanup_unknown':self.set(j,'cleanup_unknown','receipt_missing_or_unconfirmed')
        else:
            try:
                runtime=read_json(jobdir/'runtime.json');w=runtime['worker']
                if runtime['nonce']!=j['nonce'] or identity(w['pid'])!=w['birth']:
                    if j['state']!='cleanup_unknown':self.set(j,'cleanup_unknown','worker_lost; reconcile required')
                elif runtime['phase']=='running' and j['state']=='launching':self.set(j,'running','worker_claimed')
            except FileNotFoundError:
                if time.time()-j['created_at']>2 and j['state'] not in ('cleanup_unknown',):self.set(j,'cleanup_unknown','launch_uncertain; no replay')
            except (OSError,ValueError,KeyError,TypeError):
                if j['state']!='cleanup_unknown':self.set(j,'cleanup_unknown','runtime_unconfirmed')
        self.publish(j);return j
    def submit(self,p,request):
        if set(request)!={'operation_id','backend','arguments'}:raise ValueError('submit requires operation_id, backend, arguments only')
        op=request['operation_id'];args=request['arguments']
        if not isinstance(op,str) or not op or len(op)>240 or not isinstance(args,list) or any(not isinstance(a,str) or '\0' in a for a in args):raise ValueError('Invalid operation or arguments')
        opkey=digest({k:p[k] for k in ('realm','owner','task','work','actor')}|{'operation_id':op});intent=digest(request)
        old=self.store.db.execute('SELECT id,intent FROM jobs WHERE opkey=?',(opkey,)).fetchone()
        if old:
            if old['intent']!=intent:raise ValueError('operation_id intent conflict; original operation was not repeated')
            j=self.store.get(old['id']);self.store.authorize(p,j);return self.public(self.refresh(j))
        state=binding(self.config,p,launch=True)
        b=self.config['backends'].get(request['backend'])
        if b is None:raise ValueError('Backend unavailable; configure it outside model tools')
        if args and not b['allow_arguments']:raise ValueError('This backend does not accept model arguments')
        resources=[resource(r) for r in b['resources']]
        b=dict(b)
        if 'cwd' in b:
            cwd=resource({'kind':'directory','path':b['cwd']});b['cwd']=cwd['path'];resources.append(cwd)
        unique={digest(r):r for r in resources};resources=list(unique.values())
        now=time.time();jid=uuid.uuid4().hex
        j={'id':jid,'operation_id':op,'backend':request['backend'],'principal':p,'state_root':str(state),'owner_root':str(self.root),'registry':self.store.registry,'state':'accepted','reason':'durable_intent','created_at':now,'updated_at':now,'nonce':secrets.token_hex(24),'resources':resources,'receipt':None}
        with self.store.transaction():
            for row in self.store.db.execute('SELECT data FROM leases'):
                if any(conflicts(r,json.loads(row[0])) for r in resources):raise ValueError('Resource busy or cleanup unconfirmed; no external job was started')
            self.store.db.execute('INSERT INTO jobs VALUES(?,?,?,?)',(jid,opkey,intent,json.dumps(j)))
            for key,r in unique.items():self.store.db.execute('INSERT INTO leases VALUES(?,?,?)',(key,jid,json.dumps(r)))
            self.store.event(j,'accepted')
        jobdir=self.root/'jobs'/jid
        try:
            jobdir.mkdir(mode=0o700)
            self.publish(j)
            # Check again after lifecycle registration, before a worker can have effects.
            binding(self.config,p,launch=True)
            plan={'job':jid,'nonce':j['nonce'],'principal':p,'state_root':str(state),'backend':b,'argv':b['argv']+args,'cwd':b.get('cwd',str(jobdir))}
            atomic(jobdir/'plan.json',plan);self.set(j,'launching','worker_launch_intent');self.publish(j)
            # Exactly one spawn attempt. An ambiguous launch is never automatically repeated.
            self.workers[jid]=subprocess.Popen([sys.executable,str(Path(__file__).with_name('_re_owner_worker.py')),str(self.root),jid],stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,start_new_session=True,close_fds=True)
        except BaseException:
            if jid in self.workers:self.set(j,'cleanup_unknown','launch_or_registration_uncertain');self.publish(j)
            else:self.finish(j,'failed','launch_not_started')
            raise
        return self.public(j)
    def reconcile(self,j):
        j=self.refresh(j)
        if j['state'] in TERMINAL:return j
        jobdir=self.root/'jobs'/j['id']
        with open(jobdir/'worker.lock','a+b') as lock:
            try:fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
            except BlockingIOError:return j
            try:r=read_json(jobdir/'runtime.json')
            except FileNotFoundError:r=None
            except (OSError,ValueError):return j
            if r is not None:
                process=r.get('process')
                # A worker can die between Popen and saving process identity. No safe inference.
                if not process or identity(process['pid'])==process['birth'] or group_running(process['pgid']):return j
            # Hold the same worker lock while fencing the state, blocking delayed launches.
            self.finish(j,'failed','reconciled_local_group_absent; output incomplete',{'target_accepted':None,'artifacts_complete':False})
        return j
    def call(self,p,action,o):
        with self.lock:
            p=principal(p);binding(self.config,p)
            if action=='submit':return self.submit(p,o)
            if action=='list':
                if set(o)-{'after','limit'}:raise ValueError('Unknown list fields')
                after=o.get('after','');limit=self.number(o.get('limit',20),1,100)
                rows=[]
                for row in self.store.db.execute('SELECT id FROM jobs WHERE id>? ORDER BY id',(after,)):
                    j=self.store.get(row[0])
                    try:self.store.authorize(p,j)
                    except ValueError:continue
                    rows.append(self.public(self.refresh(j)))
                    if len(rows)==limit+1:break
                return {'items':rows[:limit],'next':rows[limit-1]['id'] if len(rows)>limit else None}
            if not isinstance(o.get('job'),str):raise ValueError('Exact job required')
            j=self.store.get(o['job']);self.store.authorize(p,j);j=self.refresh(j)
            if action in ('status','cancel','reconcile'):
                if set(o)!={'job'}:raise ValueError('Unknown job fields')
                if action=='cancel' and j['state'] not in TERMINAL:
                    atomic(self.root/'jobs'/j['id']/'cancel.json',{'at':time.time()});self.set(j,'cancel_requested','cancel_requested');self.publish(j)
                if action=='reconcile':j=self.reconcile(j)
                return self.public(j)
            if action=='events':
                if set(o)-{'job','after','limit'}:raise ValueError('Unknown event fields')
                after=self.number(o.get('after',0),0,2**53-1);limit=self.number(o.get('limit',20),1,100)
                rows=[json.loads(r[0]) for r in self.store.db.execute('SELECT data FROM events WHERE job=? AND seq>? ORDER BY seq LIMIT ?',(j['id'],after,limit+1))]
                return {'items':rows[:limit],'next':rows[limit-1]['seq'] if len(rows)>limit else None}
            if action=='read_artifact':
                if set(o)-{'job','name','offset','max_bytes','sha256'} or o.get('name') not in ('stdout','stderr'):raise ValueError('Invalid artifact request')
                a=(j.get('receipt') or {}).get('artifacts',{}).get(o['name'])
                if not a:raise ValueError('Sealed artifact unavailable; no live-output completeness claim')
                if o.get('sha256') not in (None,a['sha256']):raise ValueError('Artifact snapshot changed')
                offset=self.number(o.get('offset',0),0,a['bytes']);limit=self.number(o.get('max_bytes',8192),1,32768)
                with open(self.root/'jobs'/j['id']/(o['name']+'.bin'),'rb') as f:
                    if file_identity(os.fstat(f.fileno()))!=a['file_identity']:raise ValueError('Artifact snapshot changed after sealing')
                    f.seek(offset);body=f.read(limit)
                    if file_identity(os.fstat(f.fileno()))!=a['file_identity'] or len(body)!=min(limit,a['bytes']-offset):raise ValueError('Artifact changed or short read')
                return {**a,'offset':offset,'next':offset+len(body) if offset+len(body)<a['bytes'] else None,'encoding':'base64','data':base64.b64encode(body).decode()}
            raise ValueError('Unknown owner action')
    @staticmethod
    def number(v,lo,hi):
        if type(v) is not int or not lo<=v<=hi:raise ValueError('Invalid page range')
        return v
    def tick(self):
        with self.lock:
            for row in self.store.db.execute("SELECT id FROM jobs WHERE json_extract(data,'$.state') IN ('accepted','launching','running','cancel_requested','cleanup_unknown') OR id IN (SELECT job FROM leases)").fetchall():
                try:self.refresh(self.store.get(row[0]))
                except (OSError,ValueError,sqlite3.Error):pass  # Retain lease; never infer cleanup from an error.


def serve(root,config):
    os.umask(0o077);root=Path(root).absolute()
    if root.is_symlink():raise ValueError('Owner root must not be a symlink')
    root.mkdir(mode=0o700,parents=True,exist_ok=True)
    if root.stat().st_uid!=os.getuid() or root.stat().st_mode&0o077:raise ValueError('Owner root must be private and owned by this user')
    with open(root/'owner.lock','a+b') as lock:
        try:fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        except BlockingIOError:raise ValueError('Owner already running for this root')
        if (root/'token').exists():token=(root/'token').read_text().strip()
        else:token=secrets.token_hex(32);(root/'token').write_text(token)
        owner=Owner(root,configuration(config));sock=root/'owner.sock';sock.unlink(missing_ok=True)
        class Handler(socketserver.StreamRequestHandler):
            def handle(self):
                self.connection.settimeout(5)
                try:
                    line=self.rfile.readline(MAX_RPC+1)
                    if len(line)>MAX_RPC or not line.endswith(b'\n'):raise ValueError('Request exceeds transport budget')
                    req=json.loads(line)
                    if set(req)!={'token','principal','action','options'} or not hmac.compare_digest(req['token'],token):raise ValueError('Owner authentication failed')
                    result={'ok':True,'value':owner.call(req['principal'],req['action'],req['options'])}
                    data=canonical(result)
                    if len(data)>MAX_RPC:raise ValueError('Response exceeds budget; request smaller pages')
                except Exception as e:data=canonical({'ok':False,'error':str(e) if isinstance(e,(ValueError,OSError,sqlite3.Error)) else 'Owner request failed'})
                try:self.wfile.write(data+b'\n')
                except OSError:pass  # Lost response never retries the operation.
        class Server(socketserver.ThreadingUnixStreamServer):daemon_threads=True
        with Server(str(sock),Handler) as server:
            os.chmod(sock,0o600);server.timeout=.2
            atomic(root/'health.json',{'pid':os.getpid(),'birth':identity(os.getpid()),'registry':owner.store.registry,'coverage':'configured local process groups; shared root only'})
            while True:server.handle_request();owner.tick()


def rpc(root,p,action,options,timeout=5):
    root=Path(root);req={'token':(root/'token').read_text().strip(),'principal':p,'action':action,'options':options};data=canonical(req)+b'\n'
    if len(data)>MAX_RPC:raise ValueError('Request exceeds transport budget')
    with socket.socket(socket.AF_UNIX,socket.SOCK_STREAM) as s:
        s.settimeout(timeout);s.connect(str(root/'owner.sock'));s.sendall(data);buf=b''
        while b'\n' not in buf:
            block=s.recv(min(65536,MAX_RPC+1-len(buf)))
            if not block:raise ValueError('Owner disconnected; query same operation_id before retrying')
            buf+=block
            if len(buf)>MAX_RPC:raise ValueError('Response exceeds transport budget')
    result=json.loads(buf)
    if not result['ok']:raise ValueError(result['error'])
    return result['value']


def main():
    p=argparse.ArgumentParser(description=__doc__);sub=p.add_subparsers(dest='action',required=True)
    s=sub.add_parser('serve');s.add_argument('--root',required=True);s.add_argument('--config',required=True)
    args=p.parse_args()
    if sys.platform!='linux':raise ValueError('Managed owner currently requires Linux; offline lab tools remain portable')
    serve(args.root,args.config)


if __name__=='__main__':
    try:main()
    except (ValueError,OSError) as e:print(json.dumps({'ok':False,'error':str(e)}),file=sys.stderr);sys.exit(2)
