#!/usr/bin/env python3
"""Explicit Linux acceptance using authored local children only; no challenge files/models."""
import importlib.util
import json
import os
from pathlib import Path
import signal
import socket
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

ROOT=Path(os.environ.get('DSH_LOCAL_SKILL_ROOT',Path(__file__).resolve().parents[1]));SCRIPT=ROOT/'skills/pwn-exploit/scripts/local_lab.py'
spec=importlib.util.spec_from_file_location('lab',SCRIPT);lab=importlib.util.module_from_spec(spec);spec.loader.exec_module(lab)
NATIVE='--native-local' in sys.argv
if NATIVE:sys.argv.remove('--native-local')
SERVER='''import json,os,socket,sys,time
from pathlib import Path
w=Path(os.environ['DSH_LAB_WORK']);mode=sys.argv[1];name=sys.argv[2]
if mode=='fail':raise SystemExit(2)
r={'instance':os.environ['DSH_LAB_INSTANCE'],'nonce':os.environ['DSH_LAB_NONCE'],'pid':os.getpid()}
if mode in ('tcp','bad'):
 s=socket.socket();s.bind(('127.0.0.1',0));s.listen(1);r.update(host='127.0.0.1',port=s.getsockname()[1] if mode=='tcp' else int(sys.argv[3]))
elif mode=='unix':
 s=socket.socket(socket.AF_UNIX);path=w/(name+'.sock');s.bind(str(path));s.listen(1);r['socket_path']=str(path)
(w/(name+'.json')).write_text(json.dumps(r))
if mode=='echo':
 time.sleep(.1);data=bytearray()
 while True:
  part=os.read(0,65536)
  if not part:break
  data.extend(part)
 view=memoryview(bytes(data))
 while view:
  n=os.write(1,view[:65536]);view=view[n:]
 raise SystemExit(0)
if mode=='tcp':
 c,a=s.accept();(w/(name+'.accepted')).write_text('one connection');c.close();s.close()
time.sleep(60)
'''

@unittest.skipUnless(NATIVE and sys.platform=='linux' and hasattr(os,'pidfd_open'),'explicit Linux --native-local required')
class LabLifecycle(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory(prefix='dsh-owned-lab-');self.root=Path(self.tmp.name);self.src=self.root/'fixture';self.src.mkdir();(self.src/'server.py').write_text(SERVER);self.runners=[]
    def tearDown(self):
        for p in self.runners:
            if p.poll() is None:p.send_signal(signal.SIGINT)
            try:p.communicate(timeout=5)
            except subprocess.TimeoutExpired:p.kill();p.communicate()
        self.tmp.cleanup()
    def service(self,name='svc',mode='tcp',**extra):
        return {'id':name,'argv':['{python}','{work}/server.py',mode,name],'ready':{'kind':mode if mode in ('tcp','unix') else 'receipt','path':name+'.json'},'startup_seconds':1,**extra}
    def plan(self,services):return {'backend':'private_paths','source':str(self.src),'services':services}
    def launch(self,name,plan):
        file=self.root/(name+'.plan');file.write_text(json.dumps(plan));out=self.root/name
        p=subprocess.Popen([sys.executable,str(SCRIPT),'--plan',str(file),'--out',str(out)],stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True);self.runners.append(p);return p,out
    def wait_ready(self,p,out,name='svc'):
        file=out/'work'/(name+'.json');until=time.monotonic()+5
        while time.monotonic()<until:
            if file.exists():
                try:return json.loads(file.read_text())
                except ValueError:pass
            if p.poll() is not None:break
            time.sleep(.02)
        raise AssertionError('Own fixture failed to become ready')
    def stop(self,p,out):
        p.send_signal(signal.SIGINT);stdout,stderr=p.communicate(timeout=5);self.assertNotIn('Traceback',stderr);r=json.loads((out/'receipt.json').read_text());self.assertEqual(r['cleanup'],'confirmed');return r
    def test_two_instances_and_no_probe_connection(self):
        a,oa=self.launch('a',self.plan([self.service()]));ra=self.wait_ready(a,oa)
        b,ob=self.launch('b',self.plan([self.service()]));rb=self.wait_ready(b,ob);time.sleep(.1)
        self.assertNotEqual(ra['port'],rb['port']);self.assertFalse((oa/'work/svc.accepted').exists());self.assertFalse((ob/'work/svc.accepted').exists())
        self.stop(a,oa);self.assertIsNone(b.poll())
        with socket.create_connection(('127.0.0.1',rb['port']),timeout=1):pass
        self.stop(b,ob);self.assertTrue((ob/'work/svc.accepted').exists())
    def test_partial_start_failure_cleans_first_child(self):
        plan=self.plan([self.service('one',mode='receipt'),self.service('two',mode='fail',after=['one'])]);out=self.root/'partial';r=lab.run(plan,out,.1)
        self.assertFalse(r['ok']);self.assertEqual(r['cleanup'],'confirmed');self.assertEqual(len(r['children']),2)
        self.assertTrue(all(c['returncode'] is not None for c in r['children']))
    def test_foreign_listener_is_not_readiness(self):
        foreign=socket.socket();foreign.bind(('127.0.0.1',0));foreign.listen(1)
        try:
            service=self.service(mode='bad',startup_seconds=.15);service['ready']['kind']='tcp';service['argv'].append(str(foreign.getsockname()[1]));r=lab.run(self.plan([service]),self.root/'wrong',.1)
            self.assertFalse(r['ok']);self.assertEqual(r['cleanup'],'confirmed');self.assertIn('readiness',r['error']);self.assertGreater(foreign.fileno(),0)
        finally:foreign.close()
    def test_socketpair_complete_binary_input_output(self):
        data=bytes(range(256))*1600;service=self.service(mode='echo',io='socketpair',input_hex=data.hex());out=self.root/'echo';r=lab.run(self.plan([service]),out)
        self.assertTrue(r['ok'],r);self.assertEqual((out/'svc.stdout.bin').read_bytes(),data);self.assertEqual(r['children'][0]['input_bytes_sent'],len(data));self.assertTrue(r['children'][0]['socket_output_eof'])
    def test_unix_fixture_does_not_delete_foreign_same_name(self):
        sentinel=self.root/'svc.sock';foreign=socket.socket(socket.AF_UNIX);foreign.bind(str(sentinel));before=sentinel.stat().st_ino
        try:
            r=lab.run(self.plan([self.service(mode='unix')]),self.root/'unix',.03);self.assertTrue(r['ok'],r);self.assertEqual(sentinel.stat().st_ino,before);self.assertTrue((self.root/'unix/work/svc.sock').exists())
        finally:foreign.close()
    def test_unsupported_backend_has_no_output_or_host_effect(self):
        plan=self.plan([self.service()]);plan['backend']='mount_namespace';out=self.root/'unsupported'
        with self.assertRaises(ValueError):lab.run(plan,out,.1)
        self.assertFalse(out.exists());self.assertEqual((self.src/'server.py').read_text(),SERVER)
    def test_identity_mismatch_does_not_signal(self):
        p=subprocess.Popen([sys.executable,'-c','import time;time.sleep(30)']);fd=os.pidfd_open(p.pid);stdout=(self.root/'out').open('wb');stderr=(self.root/'err').open('wb')
        item={'spec':{'id':'owned'},'process':p,'pidfd':fd,'identity':lab.identity(p.pid),'stdout':stdout,'stderr':stderr,'socket':None}
        try:
            with patch.object(lab,'identity',return_value='other-process'):r=lab.cleanup([item])
            self.assertEqual(r[0]['state'],'cleanup_unknown');self.assertIsNone(p.poll())
        finally:
            if p.poll() is None:p.kill()
            p.wait()
    def test_output_collision_refused(self):
        out=self.root/'exists';out.mkdir();(out/'keep').write_text('keep')
        with self.assertRaises(FileExistsError):lab.run(self.plan([self.service()]),out,.1)
        self.assertEqual((out/'keep').read_text(),'keep')

if __name__=='__main__':unittest.main()
