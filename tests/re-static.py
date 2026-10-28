#!/usr/bin/env python3
"""Offline DEX and association contracts; authored fixtures, no models/devices."""
import base64
from contextlib import closing
import importlib.util
import json
import os
from pathlib import Path
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
import warnings
import zipfile

ROOT=Path(__file__).resolve().parents[1];FIX=ROOT/'tests/fixtures/re-static'
sys.path[:0]=[str(ROOT/'skills/android-re/scripts'),str(ROOT/'skills/re-dynamic/scripts')]
import _android_tools as tools
import _dex_index as dex
import dex_index
import re_correlate as link
from _re_evidence import canonical,sha
spec=importlib.util.spec_from_file_location('re_static_fixture',ROOT/'tests/re-lab-contract.py');fixture=importlib.util.module_from_spec(spec);spec.loader.exec_module(fixture)


class Discovery(unittest.TestCase):
    def test_native_sdk_names_and_version_fallback(self):
        with tempfile.TemporaryDirectory() as td:
            root=Path(td);suffix='.bat' if os.name=='nt' else ''
            for version in ('9.0','10.0'):
                p=root/'cmdline-tools'/version/'bin'/('apkanalyzer'+suffix);p.parent.mkdir(parents=True);p.write_text('fixture')
            name='d8.bat' if os.name=='nt' else 'd8';p=root/'build-tools/36.1.0'/name;p.parent.mkdir(parents=True);p.write_text('fixture')
            with patch.dict(os.environ,{'ANDROID_SDK_ROOT':td,'PATH':''},clear=True):
                self.assertIn('10.0',tools.apkanalyzer());self.assertEqual(tools.d8(),str(p))
    def test_explicit_override_and_broken_interpreter_fallback(self):
        with tempfile.TemporaryDirectory() as td:
            file=Path(td)/'chosen';file.write_text('fixture')
            with patch.dict(os.environ,{'APKANALYZER':str(file)}):self.assertEqual(tools.apkanalyzer(),str(file))
        calls=[subprocess.TimeoutExpired('configured interpreter',60),subprocess.CompletedProcess([],0)]
        with patch.object(tools.os.path,'isfile',return_value=True),patch.object(tools.subprocess,'run',side_effect=calls):self.assertIsNotNone(tools.agpy())
    def test_passive_doctor_never_executes(self):
        with patch.object(subprocess,'run',side_effect=AssertionError('Passive discovery executed a command')):
            result=dex_index.doctor()
        self.assertEqual(result['commands_executed'],0);self.assertFalse(result['sample_parsed'])


class DEX(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.python=tools.agpy()
        if not cls.python:
            if os.environ.get('DSH_RE_STATIC_REQUIRED')=='1':raise AssertionError('Required Androguard backend unavailable')
            raise unittest.SkipTest('Androguard unavailable; no static parsing claim')
        cls.tmp=tempfile.TemporaryDirectory(prefix='dex-static-test-');cls.base=Path(cls.tmp.name);cls.apk=cls.base/'multi.apk';cls.index=cls.base/'index.sqlite3'
        with warnings.catch_warnings():
            warnings.simplefilter('ignore',UserWarning)
            with zipfile.ZipFile(cls.apk,'w') as z:
                z.write(FIX/'entry.dex','classes.dex');z.write(FIX/'other.dex','classes2.dex');z.write(FIX/'other-alt.dex','classes2.dex')
        cls.build(cls.apk,cls.index)
    @classmethod
    def tearDownClass(cls):cls.tmp.cleanup()
    @classmethod
    def build(cls,path,out,*extra):
        r=subprocess.run([cls.python,str(ROOT/'skills/android-re/scripts/dex_index.py'),'build','--worker','--input',str(path),'--output',str(out),*extra],capture_output=True,text=True)
        if r.returncode:raise AssertionError(r.stdout+r.stderr)
        return json.loads(r.stdout)
    def methods(self,sig):return dex.query(self.index,signature_filter=sig)['items']
    def test_complete_signatures_overloads_and_native_declaration(self):
        self.assertEqual(len(self.methods('Lfixture/Entry;->overloaded(I)I')),1)
        self.assertEqual(len(self.methods('Lfixture/Entry;->overloaded(Ljava/lang/String;)I')),1)
        native=self.methods('Lfixture/Entry;->nativeCheck(Ljava/lang/String;)I')[0]
        self.assertFalse(native['has_code']);self.assertIsNone(native['instructions_file_offset_bytes'])
    def test_duplicate_zip_entries_and_same_named_class_remain_distinct(self):
        sources=dex.query(self.index,'sources')['items'];self.assertEqual(len(sources),3)
        others=self.methods('Lfixture/Other;->compute(I)I');self.assertEqual(len(others),2)
        self.assertNotEqual(others[0]['id'],others[1]['id']);self.assertNotEqual(others[0]['code_sha256'],others[1]['code_sha256'])
    def test_cross_dex_references_are_declared_not_runtime_dispatch(self):
        rows=dex.query(self.index,'refs',kind='call',target='Lfixture/Other;->compute(I)I')['items'];self.assertEqual(len(rows),1)
        self.assertFalse(rows[0]['runtime_dispatch_verified']);self.assertEqual(len(dex.definitions(self.index,rows[0]['target'])['items']),2)
    def test_fields_and_actual_string_use_sites(self):
        self.assertTrue(dex.query(self.index,'refs',kind='field',target='Lfixture/Entry;->counter:I')['items'])
        self.assertTrue(dex.query(self.index,'refs',kind='string',target='STATIC_TOKEN')['items'])
    def test_instruction_offsets_bytes_and_code_units_match_original(self):
        m=self.methods('Lfixture/Entry;->verify(I)I')[0];body=(FIX/'entry.dex').read_bytes();start=int(m['instructions_file_offset_bytes'],16)
        self.assertEqual(sha(body[start:start+m['code_bytes']]),m['code_sha256'])
        for ins in dex.query(self.index,'instructions',method=m['id'])['items']:
            self.assertEqual(ins['offset_bytes'],2*ins['offset_code_units']);off=int(ins['file_offset_bytes'],16)
            self.assertEqual(body[off:off+ins['length_bytes']].hex(),ins['raw_hex'])
    def test_exception_and_wide_methods_are_indexed(self):
        for sig in ('Lfixture/Entry;->guarded(I)I','Lfixture/Entry;->wide(J)J'):
            method=self.methods(sig)[0];self.assertTrue(method['has_code']);self.assertTrue(dex.query(self.index,'instructions',method=method['id'])['items'])
    def test_missing_reference_is_a_scoped_empty_result(self):
        r=dex.query(self.index,'refs',target='missing');self.assertEqual(r['items'],[]);self.assertIn('absence',r['authority'])
    def test_partial_bad_dex_is_not_an_empty_complete_index(self):
        path=self.base/'bad.apk';out=self.base/'bad.sqlite3'
        with zipfile.ZipFile(path,'w') as z:z.write(FIX/'entry.dex','classes.dex');z.writestr('assets/broken.dex',b'not a dex')
        report=self.build(path,out);self.assertEqual(report['coverage'],'partial');self.assertEqual(report['failures'],1)
        sources=dex.query(out,'sources')['items'];self.assertTrue(any(s['state']=='parse_failed' for s in sources));self.assertGreater(report['counts']['methods'],0)
    def test_per_entry_budget_refuses_without_silent_truncation(self):
        report=self.build(FIX/'entry.dex',self.base/'budget.sqlite3','--max-dex-bytes','100');self.assertEqual(report['coverage'],'partial');self.assertEqual(report['counts']['methods'],0)
    def test_empty_container_does_not_claim_whole_apk_coverage(self):
        path=self.base/'opaque.apk'
        with zipfile.ZipFile(path,'w') as z:z.writestr('opaque.payload',b'dex\n035\0')
        r=self.build(path,self.base/'opaque.sqlite3');self.assertEqual(r['coverage'],'partial')
    def test_exact_pagination_and_changed_snapshot_refusal(self):
        first=dex.query(self.index,limit=1);all_rows=[];cursor=0
        while cursor is not None:
            page=dex.query(self.index,after=cursor,limit=1,snapshot=first['snapshot']);all_rows+=page['items'];cursor=page['next']
        self.assertEqual(len(all_rows),11)
        with self.assertRaisesRegex(ValueError,'snapshot'):dex.query(self.index,snapshot='wrong')
    def test_large_row_has_lossless_document_pages(self):
        path=self.base/'large.sqlite3';shutil.copyfile(self.index,path);value={'text':'你好🌊'*20000}
        with closing(sqlite3.connect(path)) as con:con.execute('UPDATE inputs SET data=?',(canonical(value).decode(),));con.commit()
        p=dex.query(path,'inputs',max_bytes=2048);item=p['items'][0];self.assertTrue(item['large_fields_omitted']);offset=0;parts=[]
        while offset is not None:
            page=dex.document(path,'inputs',item['row'],offset,901,p['snapshot']);parts.append(base64.b64decode(page['data']));offset=page['next']
        self.assertEqual(json.loads(b''.join(parts)),value)
    def test_dex_request_keeps_loader_unknown_and_conflicting_identity(self):
        evidence=self.base/'dex-observation.txt';evidence.write_text('Authored observation')
        method=self.methods('Lfixture/Entry;->verify(I)I')[0];r=link.dex_request(self.index,method['id'],evidence)
        self.assertFalse(r['runtime_context_complete']);self.assertFalse(r['runtime_identity_verified']);self.assertTrue(r['queries'])
        wrong=link.dex_request(self.index,method['id'],evidence,{'dex_sha256':'other'});self.assertTrue(wrong['runtime_context_conflict'])
    def test_build_does_not_overwrite_original_or_index(self):
        before=sha(self.apk.read_bytes());r=subprocess.run([self.python,str(ROOT/'skills/android-re/scripts/dex_index.py'),'build','--worker','--input',str(self.apk),'--output',str(self.index)],capture_output=True);self.assertNotEqual(r.returncode,0);self.assertEqual(sha(self.apk.read_bytes()),before)


class Association(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup);self.base=Path(self.tmp.name);self.image=self.base/'image';self.image.write_bytes(fixture.elf());self.ev=self.base/'observed.txt';self.ev.write_text('Authored saved observation')
        self.request=link.native_request(self.image,fixture.context(self.image.read_bytes()),'runtime_addr','0x70003180',self.ev)
    def snapshot(self,request=None):
        r=request or self.request;q=r['queries'][0]
        return {'schema':'dsh-re-static-snapshot-v1','request_sha256':sha(canonical(r)),'program_sha256':r['image_sha256'],'space':'ram','producer_epoch':'authored-synthetic-exporter',
                'program_modification_before':'5','program_modification_after':'5','program_unchanged':True,'queries':[{'key':q['key'],'state':'candidates','file_offset_bytes':q['file_offset_bytes'],
                'matches':[{'address':q['expected_ghidra_address'],'space':'ram','state':'read','bytes':q['bytes'],'bytes_sha256':q['sha256'],'bytes_match':True,'function':{'name':'synthetic'}}]}]}
    def test_byte_match_is_static_not_runtime_or_semantic_acceptance(self):
        r=link.correlate(canonical(self.request),canonical(self.snapshot()));self.assertEqual(r['state'],'matched_static_snapshot');self.assertFalse(r['runtime_identity_verified']);self.assertIsNone(r['target_accepted'])
    def test_missing_snapshot_remains_pending(self):self.assertEqual(link.correlate(canonical(self.request))['state'],'awaiting_static_snapshot')
    def test_program_file_identity_mismatch_refused(self):
        s=self.snapshot();s['program_sha256']='other'
        with self.assertRaisesRegex(ValueError,'hash mismatch'):link.correlate(canonical(self.request),canonical(s))
    def test_reloaded_or_changed_request_cannot_reuse_snapshot(self):
        s=self.snapshot();r=json.loads(canonical(self.request));r['observation']['load_instance_id']='new-load'
        with self.assertRaisesRegex(ValueError,'another request'):link.correlate(canonical(r),canonical(s))
    def test_changed_program_counter_refused(self):
        s=self.snapshot();s['program_modification_after']='6'
        with self.assertRaisesRegex(ValueError,'changed'):link.correlate(canonical(self.request),canonical(s))
    def test_patched_memory_is_a_conflict(self):
        s=self.snapshot();s['queries'][0]['matches'][0]['bytes_sha256']='other';self.assertEqual(link.correlate(canonical(self.request),canonical(s))['state'],'static_bytes_conflict')
    def test_unread_and_duplicate_mapping_remain_partial_or_ambiguous(self):
        s=self.snapshot();s['queries'][0].update(state='not_read_budget',matches=[]);self.assertEqual(link.correlate(canonical(self.request),canonical(s))['state'],'partial_static_snapshot')
        s=self.snapshot();s['queries'][0]['matches']*=2;self.assertEqual(link.correlate(canonical(self.request),canonical(s))['state'],'ambiguous_static_locations')
    def test_wrong_declared_rebase_is_not_silently_corrected(self):
        s=self.snapshot();s['queries'][0]['matches'][0]['address']='0x203180';self.assertEqual(link.correlate(canonical(self.request),canonical(s))['state'],'declared_coordinate_conflict')
    def test_evidence_recheck_refuses_changed_original(self):
        req=self.base/'request.json';req.write_bytes(canonical(self.request));self.ev.write_text('changed')
        with patch('sys.stdout'):
            code=link.main(['link','--request',str(req),'--output',str(self.base/'result.json'),'--evidence',str(self.ev)])
        self.assertEqual(code,2);self.assertFalse((self.base/'result.json').exists())


if __name__=='__main__':
    if '--required-backend' in sys.argv:sys.argv.remove('--required-backend');os.environ['DSH_RE_STATIC_REQUIRED']='1'
    unittest.main(verbosity=2)
