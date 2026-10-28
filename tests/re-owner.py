#!/usr/bin/env python3
"""Linux owner lifecycle/fault contracts using only authored local processes."""
import base64
from concurrent.futures import ThreadPoolExecutor
import importlib.util
import json
import os
from pathlib import Path
import signal
import socket
import sqlite3
import subprocess
import sys
import tempfile
import time
import unittest

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'skills/re-dynamic/scripts'))
if sys.platform!='linux':sys.exit('Managed RE owner tests require Linux')
from re_owner import rpc
from _re_owner_store import identity, resource, conflicts, Store
from _re_owner_worker import atomic, group_running


def until(fn,seconds=8):
    end=time.monotonic()+seconds
    while time.monotonic()<end:
        result=fn()
        if result:return result
        time.sleep(.03)
    raise AssertionError('Local fixture did not reach expected state')


class OwnerContracts(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory(prefix='re-own-');self.base=Path(self.tmp.name);self.root=self.base/'owner';self.state=self.base/'state';self.state.mkdir();self.shared=self.base/'shared';self.shared.mkdir();self.alias=self.base/'alias';self.alias.symlink_to(self.shared,target_is_directory=True)
        self.db=sqlite3.connect(self.state/'state.sqlite3');self.db.executescript('CREATE TABLE tasks(id TEXT PRIMARY KEY,data TEXT);CREATE TABLE sessions(id TEXT PRIMARY KEY,task TEXT,cwd TEXT);CREATE TABLE targets(task TEXT,id TEXT,generation INTEGER,data TEXT);CREATE TABLE orch_runs(task TEXT PRIMARY KEY,data TEXT,owner TEXT);CREATE TABLE orch_work(task TEXT,id TEXT,data TEXT,PRIMARY KEY(task,id));')
        for i in ('1','2'):
            self.db.execute('INSERT INTO tasks VALUES(?,?)',('t'+i,json.dumps({'status':'running'})));self.db.execute('INSERT INTO sessions VALUES(?,?,?)',('p'+i,'t'+i,str(self.base)));self.db.execute('INSERT INTO targets VALUES(?,?,?,?)',('t'+i,'local',1,'{}'))
        self.db.commit();self.p={'realm':'test','owner':'p1','actor':'p1','task':'t1','work':None,'role':'parent','targets':[{'id':'local','generation':1}]}
        fixture=str(ROOT/'tests/fixtures/re-owner-local.py')
        b={'argv':[sys.executable,fixture],'allow_arguments':True,'resources':[{'kind':'directory','path':str(self.shared)}]}
        self.config={'realms':{'test':str(self.state)},'backends':{'local':b,'alias':{**b,'resources':[{'kind':'directory','path':str(self.alias)}]},'small':{**b,'output_bytes':32}}};self.conf=self.base/'config.json';self.conf.write_text(json.dumps(self.config));self.service=None;self.start()
    def start(self):
        if (self.root/'owner.sock').exists():(self.root/'owner.sock').unlink()
        with open(self.base/'service.log','ab') as log:self.service=subprocess.Popen([sys.executable,str(ROOT/'skills/re-dynamic/scripts/re_owner.py'),'serve','--root',str(self.root),'--config',str(self.conf)],stdout=subprocess.DEVNULL,stderr=log,start_new_session=True)
        until(lambda:(self.root/'owner.sock').exists() or self.service.poll() is not None)
        if self.service.poll() is not None:raise AssertionError((self.base/'service.log').read_text())
    def stop(self):
        if self.service and self.service.poll() is None:self.service.kill();self.service.wait()
    def call(self,action,options,p=None):return rpc(self.root,p or self.p,action,options)
    def submit(self,op='op',backend='local',args=None,p=None):return self.call('submit',{'operation_id':op,'backend':backend,'arguments':args or []},p)
    def status(self,j):return self.call('status',{'job':j['id']})
    def settled(self,j):return until(lambda:(r if (r:=self.status(j))['state'] in ('finished','failed','cancelled') else None))
    def running(self,j):
        until(lambda:(self.root/'jobs'/j['id']/'runtime.json').exists() and json.loads((self.root/'jobs'/j['id']/'runtime.json').read_text()).get('process'))
        return json.loads((self.root/'jobs'/j['id']/'runtime.json').read_text())
    def tearDown(self):
        self.stop()
        for f in self.root.glob('jobs/*/runtime.json'):
            r=json.loads(f.read_text());p=r.get('process');w=r['worker']
            if p and identity(p['pid'])==p['birth']:
                try:os.killpg(p['pgid'],signal.SIGKILL)
                except ProcessLookupError:pass
            if identity(w['pid'])==w['birth']:
                try:os.kill(w['pid'],signal.SIGKILL)
                except ProcessLookupError:pass
        self.db.close();time.sleep(.06);self.tmp.cleanup()
    def test_duplicate_operation_exactly_one_launch_and_conflict(self):
        count=self.base/'count.txt';args=['count',str(count)]
        with ThreadPoolExecutor(4) as pool:jobs=list(pool.map(lambda _:self.submit(args=args),range(4)))
        self.assertEqual(len({j['id'] for j in jobs}),1);until(lambda:count.exists());self.assertEqual(count.read_text(),'one launch\n')
        with self.assertRaisesRegex(ValueError,'intent conflict'):self.submit(args=['fail'])
        self.call('cancel',{'job':jobs[0]['id']});self.assertEqual(self.settled(jobs[0])['state'],'cancelled')
    def test_alias_backend_and_cross_task_cannot_bypass_lease(self):
        j=self.submit();self.running(j)
        with self.assertRaisesRegex(ValueError,'Resource busy'):self.submit('second','alias')
        p={**self.p,'owner':'p2','actor':'p2','task':'t2'}
        with self.assertRaisesRegex(ValueError,'Resource busy'):self.submit('second',p=p)
        self.call('cancel',{'job':j['id']});self.settled(j);k=self.submit('second','alias');self.call('cancel',{'job':k['id']});self.settled(k)
    def test_distinct_profile_databases_share_the_same_lease(self):
        other=self.base/'other-state';other.mkdir()
        with sqlite3.connect(other/'state.sqlite3') as con:self.db.backup(con)
        self.config['realms']['other']=str(other);self.conf.write_text(json.dumps(self.config));self.stop();self.start()
        j=self.submit();self.running(j)
        with self.assertRaisesRegex(ValueError,'Resource busy'):self.submit('other-profile',p={**self.p,'realm':'other'})
        with self.assertRaisesRegex(ValueError,'unavailable'):self.call('status',{'job':j['id']},{**self.p,'realm':'other'})
    def test_lost_response_queries_original_operation(self):
        count=self.base/'count.txt';options={'operation_id':'lost','backend':'local','arguments':['count',str(count)]}
        req={'token':(self.root/'token').read_text().strip(),'principal':self.p,'action':'submit','options':options}
        with socket.socket(socket.AF_UNIX,socket.SOCK_STREAM) as s:s.connect(str(self.root/'owner.sock'));s.sendall(json.dumps(req).encode()+b'\n')
        until(lambda:count.exists());j=self.call('submit',options);self.assertEqual(count.read_text(),'one launch\n');self.assertEqual(len(self.call('list',{})['items']),1);self.call('cancel',{'job':j['id']});self.settled(j)
    def test_process_resource_conflicts_across_backends(self):
        r={'kind':'host_process','pid':os.getpid(),'birth':identity(os.getpid())}
        for b in self.config['backends'].values():b['resources']=[r]
        self.conf.write_text(json.dumps(self.config));self.stop();self.start();j=self.submit();self.running(j)
        with self.assertRaisesRegex(ValueError,'Resource busy'):self.submit('different-backend','alias')
    def test_owner_can_restart_with_a_stale_declared_process(self):
        self.config['backends']['stale']={'argv':[sys.executable,'-c','pass'],'resources':[{'kind':'host_process','pid':os.getpid(),'birth':'stale-birth'}]}
        self.conf.write_text(json.dumps(self.config));self.stop();self.start()
        with self.assertRaisesRegex(ValueError,'stale'):self.submit(backend='stale')
    def test_directory_ancestor_and_process_birth(self):
        child=self.shared/'sub';child.mkdir();self.assertTrue(conflicts(resource({'kind':'directory','path':str(self.alias)}),resource({'kind':'directory','path':str(child)})))
        a=resource({'kind':'host_process','pid':os.getpid(),'birth':identity(os.getpid())});self.assertTrue(conflicts(a,a))
        with self.assertRaisesRegex(ValueError,'stale'):resource({**a,'birth':'other'})
    def test_unbound_and_stale_basis_refused(self):
        for p in ({**self.p,'targets':[]},{**self.p,'actor':'p2'},{**self.p,'targets':[{'id':'local','generation':0}]}):
            with self.assertRaises(ValueError):self.submit(p=p)
    def test_cross_task_read_and_cancel_refused(self):
        j=self.submit();p={**self.p,'owner':'p2','actor':'p2','task':'t2'}
        for action in ('status','cancel','events','read_artifact'):
            with self.assertRaisesRegex(ValueError,'unavailable'):self.call(action,{'job':j['id']},p)
        self.assertEqual(self.call('list',{},p)['items'],[])
    def test_service_restart_does_not_relaunch_or_cancel(self):
        count=self.base/'count.txt';j=self.submit(args=['count',str(count)]);r=self.running(j);self.stop();time.sleep(.2);self.assertEqual(identity(r['worker']['pid']),r['worker']['birth']);self.start()
        self.assertEqual(self.submit(args=['count',str(count)])['id'],j['id']);self.assertEqual(count.read_text(),'one launch\n');self.call('cancel',{'job':j['id']});self.settled(j)
    def test_worker_loss_quarantines_until_group_absent(self):
        j=self.submit();r=self.running(j);os.kill(r['worker']['pid'],signal.SIGKILL)
        until(lambda:self.status(j)['state']=='cleanup_unknown')
        self.assertEqual(self.call('reconcile',{'job':j['id']})['state'],'cleanup_unknown')
        with self.assertRaisesRegex(ValueError,'Resource busy'):self.submit('new')
        os.killpg(r['process']['pgid'],signal.SIGKILL);until(lambda:not group_running(r['process']['pgid']))
        result=self.call('reconcile',{'job':j['id']});self.assertEqual(result['state'],'failed');self.assertFalse(result['receipt']['artifacts_complete'])
    def test_corrupt_receipt_does_not_release(self):
        j=self.submit();r=self.running(j);self.stop();self.call_if_possible=False
        atomic(self.root/'jobs'/j['id']/'cancel.json',{'at':time.time()});until(lambda:(self.root/'jobs'/j['id']/'receipt.json').exists());f=self.root/'jobs'/j['id']/'receipt.json';v=json.loads(f.read_text());v['cleanup_confirmed']=False;atomic(f,v);self.start();self.assertEqual(self.status(j)['state'],'cleanup_unknown')
        with self.assertRaisesRegex(ValueError,'Resource busy'):self.submit('new')
    def test_output_binary_pages_and_sealed_snapshot(self):
        j=self.submit(args=['output']);r=self.settled(j);self.assertEqual(r['state'],'finished');out=b'';offset=0;sha=None
        while offset is not None:
            page=self.call('read_artifact',{'job':j['id'],'name':'stdout','offset':offset,'max_bytes':777,**({'sha256':sha} if sha else {})});out+=base64.b64decode(page['data']);offset=page['next'];sha=page['sha256']
        self.assertEqual(out,b'ABCD'*10000);self.assertTrue(page['complete'])
        with self.assertRaisesRegex(ValueError,'snapshot'):self.call('read_artifact',{'job':j['id'],'name':'stdout','sha256':'wrong'})
        with self.assertRaises(ValueError):self.call('read_artifact',{'job':j['id'],'name':'../plan'})
    def test_output_limit_explicit_incomplete(self):
        j=self.submit(backend='small',args=['output']);r=self.settled(j);self.assertEqual(r['reason'],'output_limit');self.assertLessEqual(sum(a['bytes'] for a in r['receipt']['artifacts'].values()),32);self.assertTrue(any(not a['complete'] for a in r['receipt']['artifacts'].values()))
    def test_artifact_mutation_after_sealing_is_not_silent(self):
        j=self.submit(args=['output']);self.settled(j);p=self.root/'jobs'/j['id']/'stdout.bin';p.write_bytes(b'changed')
        with self.assertRaisesRegex(ValueError,'snapshot changed'):self.call('read_artifact',{'job':j['id'],'name':'stdout'})
    def test_natural_exit_cleans_descendants(self):
        j=self.submit(args=['descendant']);r=self.running(j);v=self.settled(j);self.assertEqual(v['state'],'finished');self.assertFalse(group_running(r['process']['pgid']))
    def test_scope_change_cancels_without_service(self):
        j=self.submit();self.running(j);self.stop();self.db.execute('UPDATE tasks SET data=? WHERE id=?',(json.dumps({'status':'paused'}),'t1'));self.db.commit();until(lambda:(self.root/'jobs'/j['id']/'receipt.json').exists());self.start();self.assertEqual(self.status(j)['state'],'cancelled')
    def test_target_change_invalidates_worker(self):
        j=self.submit();self.running(j);self.db.execute('INSERT INTO targets VALUES(?,?,?,?)',('t1','local',2,'{}'));self.db.commit();self.assertEqual(self.settled(j)['reason'],'scope_invalidated')
    def test_native_lifecycle_metadata_and_target_guard(self):
        j=self.submit();self.running(j)
        sys.path.insert(0,str(ROOT/'runtime/analysis-v1'));spec=importlib.util.spec_from_file_location('re_owner_session',ROOT/'runtime/analysis-v1/session.py');module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
        with self.assertRaisesRegex(ValueError,'cleanup unconfirmed'):module.require_native_jobs_stopped(self.db,'t1','local')
        self.call('cancel',{'job':j['id']});self.settled(j);module.require_native_jobs_stopped(self.db,'t1','local')
    def test_solver_identity_and_idle_continuity(self):
        run={'state':'enabled','targets':self.p['targets'],'epoch':'e1'};w={'child':'c1','role':'solver','epoch':'e1','state':'running','tools':['dsh_re_experiment']};self.db.execute('INSERT INTO orch_runs VALUES(?,?,?)',('t1',json.dumps(run),'p1'));self.db.execute('INSERT INTO orch_work VALUES(?,?,?)',('t1','w1',json.dumps(w)));self.db.commit()
        p={**self.p,'actor':'c1','work':'w1','role':'solver'}
        with self.assertRaisesRegex(ValueError,'Coordinator'):self.submit()
        j=self.submit(p=p);r=self.running(j);w['state']='returned';self.db.execute('UPDATE orch_work SET data=?',(json.dumps(w),));self.db.commit();time.sleep(.2);self.assertEqual(identity(r['process']['pid']),r['process']['birth'])
        w['state']='cancelled';self.db.execute('UPDATE orch_work SET data=?',(json.dumps(w),));self.db.commit();self.assertEqual(self.settled(j)['state'],'cancelled')
    def test_delayed_worker_is_fenced_without_launch_replay(self):
        # Authored crash state before any worker claim. Reconcile holds worker lock
        # while fencing; a delayed worker subsequently sees terminal state.
        self.stop();s=Store(self.root);jid='fenced';jobdir=self.root/'jobs'/jid;jobdir.mkdir();now=time.time();j={'id':jid,'operation_id':'fenced','backend':'local','principal':self.p,'state_root':str(self.state),'owner_root':str(self.root),'registry':s.registry,'state':'launching','reason':'launch_uncertain','created_at':now-10,'updated_at':now,'nonce':'testnonce','resources':[],'receipt':None}
        with s.transaction():s.db.execute('INSERT INTO jobs VALUES(?,?,?,?)',(jid,'fenced','fenced',json.dumps(j)))
        s.close();count=self.base/'should-not-exist';atomic(jobdir/'plan.json',{'nonce':'testnonce','principal':self.p,'state_root':str(self.state),'backend':{'output_bytes':1000},'argv':[sys.executable,str(ROOT/'tests/fixtures/re-owner-local.py'),'count',str(count)],'cwd':str(jobdir)});self.start();self.assertEqual(self.call('reconcile',{'job':jid})['state'],'failed')
        subprocess.run([sys.executable,str(ROOT/'skills/re-dynamic/scripts/_re_owner_worker.py'),str(self.root),jid],check=True);self.assertFalse(count.exists())
    def test_events_and_jobs_are_paged(self):
        for i in range(3):j=self.submit(str(i),args=['fail']);self.settled(j)
        page=self.call('list',{'limit':1});self.assertEqual(len(page['items']),1);self.assertIsNotNone(page['next']);self.assertEqual(len(self.call('list',{'after':page['next'],'limit':10})['items']),2)
        page=self.call('events',{'job':j['id'],'limit':1});self.assertIsNotNone(page['next']);self.assertEqual(page['items'][0]['kind'],'accepted')
    def test_unknown_fields_and_unconfigured_backend_refused(self):
        with self.assertRaises(ValueError):self.call('submit',{'operation_id':'x','backend':'local','arguments':[],'principal':self.p})
        with self.assertRaisesRegex(ValueError,'Backend unavailable'):self.submit(backend='missing')
    def test_interrupted_old_work_cannot_continue_after_resume(self):
        run={'state':'enabled','targets':self.p['targets'],'epoch':'e1'};w={'child':'c1','role':'solver','epoch':'e1','state':'running','tools':['dsh_re_experiment']};self.db.execute('INSERT INTO orch_runs VALUES(?,?,?)',('t1',json.dumps(run),'p1'));self.db.execute('INSERT INTO orch_work VALUES(?,?,?)',('t1','w1',json.dumps(w)));self.db.commit()
        p={**self.p,'actor':'c1','work':'w1','role':'solver'};j=self.submit(p=p);self.running(j);w['state']='interrupted';self.db.execute('UPDATE orch_work SET data=?',(json.dumps(w),));self.db.commit();self.assertEqual(self.settled(j)['state'],'cancelled')


if __name__=='__main__':unittest.main(verbosity=2)
