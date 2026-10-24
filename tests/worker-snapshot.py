#!/usr/bin/env python3
"""Explicit Linux tests for read-only snapshots of authored own child workers."""
import importlib.util,json,os,signal,socket,subprocess,sys,tempfile,time,unittest
from pathlib import Path
from unittest.mock import patch
ROOT=Path(os.environ.get('DSH_RELAY_SKILL_ROOT',Path(__file__).resolve().parents[1]));SCRIPT=ROOT/'skills/re-dynamic/scripts/worker_snapshot.py'
spec=importlib.util.spec_from_file_location('worker',SCRIPT);w=importlib.util.module_from_spec(spec);spec.loader.exec_module(w)
NATIVE='--native-local' in sys.argv
if NATIVE:sys.argv.remove('--native-local')
WORKER='''import json,os,socket,sys,time
from pathlib import Path
s=socket.socket(fileno=int(sys.argv[3]))
Path(sys.argv[4]).write_text(json.dumps({'pid':os.getpid(),'inode':os.fstat(s.fileno()).st_ino}))
time.sleep(40)
'''
@unittest.skipUnless(NATIVE and sys.platform=='linux' and hasattr(os,'pidfd_open'),'explicit Linux --native-local required')
class Workers(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory(prefix='dsh-worker-review-');self.root=Path(self.tmp.name);self.script=self.root/'worker.py';self.script.write_text(WORKER);self.children=[];self.peers=[]
    def tearDown(self):
        for p in self.children:
            if p.poll() is None:p.terminate()
            try:p.wait(timeout=3)
            except subprocess.TimeoutExpired:p.kill();p.wait()
        for s in self.peers:s.close()
        self.tmp.cleanup()
    def launch(self,token='--serve'):
        a,b=socket.socketpair();ready=self.root/(str(len(self.children))+'.json');p=subprocess.Popen([sys.executable,str(self.script),token,'TOP_SECRET_ARG_SENTINEL',str(b.fileno()),str(ready)],pass_fds=(b.fileno(),));b.close();self.children.append(p);self.peers.append(a)
        until=time.monotonic()+5
        while time.monotonic()<until:
            if ready.exists():
                try:return p,json.loads(ready.read_text())
                except ValueError:pass
            if p.poll() is not None:break
            time.sleep(.01)
        raise AssertionError('Own worker failed to initialize')
    def test_exact_token_and_exe_no_full_argv_disclosure(self):
        p,_=self.launch();r=w.inspect_pid(p.pid,exe=sys.executable,tokens=['--serve']);self.assertEqual(r['state'],'observed',r);self.assertTrue(r['matched']);self.assertNotIn('TOP_SECRET_ARG_SENTINEL',json.dumps(r));self.assertIsNone(p.poll());self.assertEqual(r['module']['state'],'observed',r)
    def test_two_workers_socket_inode_selects_only_matching_endpoint(self):
        a,ra=self.launch();b,rb=self.launch();self.assertNotEqual(ra['inode'],rb['inode'])
        aa=w.inspect_pid(a.pid,tokens=['--serve'],socket_inode=ra['inode']);bb=w.inspect_pid(b.pid,tokens=['--serve'],socket_inode=ra['inode']);self.assertTrue(aa['matched'],aa);self.assertFalse(bb['matched']);self.assertIsNone(a.poll());self.assertIsNone(b.poll())
    def test_argv_substring_is_not_exact_token(self):
        p,_=self.launch('--serve-extra');self.assertFalse(w.inspect_pid(p.pid,tokens=['--serve'])['matched'])
    def test_stale_identity_and_exit_remain_unknown(self):
        p,_=self.launch();r=w.inspect_pid(p.pid,expected_identity='other-boot:other-start');self.assertEqual(r['state'],'unknown');self.assertFalse(r['matched']);self.assertIsNone(p.poll());p.terminate();p.wait();self.assertEqual(w.inspect_pid(p.pid)['state'],'unknown')
    def test_image_change_during_observation_invalidates_result(self):
        p,_=self.launch();real=w.identity(p.pid)
        with patch.object(w,'identity',side_effect=[real,'changed']):r=w.inspect_pid(p.pid)
        self.assertEqual(r['state'],'unknown');self.assertFalse(r['matched']);self.assertIsNone(p.poll())
    def test_denied_access_does_not_fall_back_to_guessing(self):
        p,_=self.launch()
        with patch.object(w.os,'pidfd_open',side_effect=PermissionError('controlled denial')):r=w.inspect_pid(p.pid)
        self.assertEqual(r['state'],'unknown');self.assertNotIn('module',r);self.assertIsNone(p.poll())
    def test_root_candidates_never_auto_select_latest(self):
        a,_=self.launch();b,_=self.launch();out=self.root/'snapshot.json'
        p=subprocess.run([sys.executable,str(SCRIPT),'--root-pid',str(os.getpid()),'--argv-token=--serve','--out',str(out)],capture_output=True,text=True,timeout=10);self.assertEqual(p.returncode,0,p.stdout+p.stderr);r=json.loads(out.read_text());self.assertEqual(r['matching_candidates'],2,r);self.assertIsNone(r['selected_pid']);self.assertEqual({i['pid'] for i in r['items'] if i['matched']},{a.pid,b.pid});self.assertIsNone(a.poll());self.assertIsNone(b.poll())
if __name__=='__main__':unittest.main()
