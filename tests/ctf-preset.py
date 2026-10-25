#!/usr/bin/env python3
"""Isolated CTF overlay/launcher tests; no DSH, profile or model starts."""
import contextlib
import importlib.util
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT=Path(__file__).resolve().parents[1]
def load(name,file):
    spec=importlib.util.spec_from_file_location(name,ROOT/file)
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module
setup=load('ctf_setup','tools/setup.py');launch=load('ctf_launch','tools/ctf.py')

class PresetTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(prefix='ctf-preset-',dir=ROOT)
        self.addCleanup(self.temp.cleanup);base=Path(self.temp.name);self.home=base/'home';self.source=base/'source'
        files={'skills/ctf-mode/SKILL.md':b'# CTF fixture','skills/analysis-session/SKILL.md':b'# State fixture',
               'plugins/ctf-mode/index.mjs':b'// fixture','plugins/ctf-mode/core.mjs':b'// fixture',
               'plugins/analysis-hooks-sandbox/index.mjs':b'// fixture',
               'plugins/analysis-hooks-sandbox/hook-readiness.mjs':b'// fixture',
               'plugins/analysis-memory/index.mjs':b'// fixture','plugins/analysis-orchestration/index.mjs':b'// fixture',
               'runtime/analysis-v1/session.py':b'# fixture','dsh-hooks/analysis_hook.py':b'# fixture',
               'tools/ctf.py':(ROOT/'tools/ctf.py').read_bytes()}
        for rel,data in files.items():
            p=self.source/rel;p.parent.mkdir(parents=True,exist_ok=True);p.write_bytes(data)
        (self.source/'tools/install-manifest.json').write_text(json.dumps(list(files)),encoding='utf-8')
        self.addCleanup(patch.stopall);patch.object(setup,'ROOT',self.source).start()
    def call(self,*args):
        with patch.object(sys,'argv',['setup.py','--home',str(self.home),*args]),contextlib.redirect_stdout(io.StringIO()) as out:
            code=setup.main()
        return code,json.loads(out.getvalue())
    def test_plain_full_does_not_enable_ctf(self):
        result=setup.plan(self.home,'full')
        self.assertNotIn('launch/ctf-mode.patch.json',result)
        self.assertNotIn('ctf-mode',[r['id'] for r in json.loads(result['launch/ctf-orchestration.patch.json'])[0]['insert']])
    def test_preview_and_isolated_apply(self):
        with patch.object(sys,'platform','linux'):
            code,preview=self.call('--mode','full','--preset','ctf')
            self.assertEqual(code,0);self.assertFalse(self.home.exists());self.assertEqual(preview['preset'],'ctf')
            code,result=self.call('--mode','full','--preset','ctf','--apply')
        self.assertEqual(code,0);self.assertTrue(result['applied'])
        rows=json.loads((self.home/'launch/ctf-mode.patch.json').read_text()) [0]['insert']
        self.assertEqual(len(rows),len({r['id'] for r in rows}))
        self.assertEqual(next(r for r in rows if r['id']=='ctf-mode')['config'],{'enabled':True,'mode':'auto'})
        self.assertIn('SessionStart',json.loads((self.home/'hooks/hooks.json').read_text())['hooks'])
        self.assertEqual((self.home/'launch/ctf.py').read_bytes(),(ROOT/'tools/ctf.py').read_bytes())
        self.assertFalse((self.home/'profiles').exists());self.assertFalse((self.home/'analysis-state/state.sqlite3').exists())
        command=launch.command(self.home,'ctf','web',['--port','1234'])
        self.assertIn(str(self.home/'launch/ctf-mode.patch.json'),command);self.assertIn('--from-default-profile',command)
        with self.assertRaises(ValueError):launch.command(self.home,'ctf',extra=['--patch=other.json'])
    def test_requires_full_and_manifest_sources(self):
        with self.assertRaisesRegex(ValueError,'requires --mode full'):self.call('--preset','ctf')
        manifest=self.source/'tools/install-manifest.json';items=json.loads(manifest.read_text());items.remove('plugins/ctf-mode/core.mjs');manifest.write_text(json.dumps(items))
        with self.assertRaisesRegex(ValueError,'source missing'):setup.plan(self.home,'full','ctf')
    def test_pinned_preference_and_missing_overlay(self):
        rows=json.loads(setup.overlay(self.home,'solo'))[0]['insert']
        self.assertEqual(rows[-1]['config']['mode'],'solo')
        with self.assertRaisesRegex(ValueError,'Install'):launch.command(self.home,'ctf')

if __name__=='__main__':unittest.main()
