#!/usr/bin/env python3
"""Offline and owned-host contracts; no Android, real models or challenge targets."""
import copy
import hashlib
import json
import os
from pathlib import Path
import struct
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'skills/re-dynamic/scripts'))
import _re_evidence as evidence
import re_lab
from re_mcp_probe import inspect_stdio


def elf(bits=64,endian='<',segments=None):
    segments=segments or [(0x1000,0x3000,0x300,0x800)]
    data=bytearray(0x4000)
    data[:7]=b'\x7fELF'+bytes([1 if bits==32 else 2,1 if endian=='<' else 2,1])
    struct.pack_into(endian+'HHI',data,16,3,40 if bits==32 else 183,1)
    header,size=(52,32) if bits==32 else (64,56)
    struct.pack_into(endian+('I' if bits==32 else 'Q'),data,28 if bits==32 else 32,header)
    struct.pack_into(endian+'HH',data,42 if bits==32 else 54,size,len(segments))
    for i,(offset,va,filesz,memsz) in enumerate(segments):
        values=(1,offset,va,0,filesz,memsz,5,0x1000) if bits==32 else (1,5,offset,va,0,filesz,memsz,0x1000)
        struct.pack_into(endian+('IIIIIIII' if bits==32 else 'IIQQQQQQ'),data,header+i*size,*values)
    return bytes(data)


def context(data):
    return {'image_sha256':hashlib.sha256(data).hexdigest(),'process_identity':'synthetic-device-boot:pid:birth',
            'load_instance_id':'synthetic-load-1','load_bias':'0x70000000','ghidra_rebase_delta':'0x100000'}


class Coordinates(unittest.TestCase):
    def test_roundtrip_segment_interior_and_rebase(self):
        for bits in (32,64):
            for endian in ('<','>'):
                data=elf(bits,endian);c=context(data)
                expected={'elf_va':'0x3180','runtime_addr':'0x70003180','ghidra_va':'0x103180','file_offset':'0x1180'}
                for key,value in expected.items():
                    r=evidence.map_address(data,c,key,value)
                    self.assertEqual(r['state'],'mapped')
                    self.assertFalse(r['runtime_identity_verified'])
                    for k,v in expected.items():self.assertEqual(r['candidates'][0][k],v)

    def test_bss_has_no_file_offset(self):
        data=elf();r=evidence.map_address(data,context(data),'elf_va','0x3350')
        self.assertIsNone(r['candidates'][0]['file_offset'])
        self.assertFalse(r['candidates'][0]['file_backed'])
        self.assertEqual(evidence.map_address(data,context(data),'file_offset','0x1350')['state'],'unmapped')

    def test_ambiguous_segments_not_first_match(self):
        data=elf(segments=[(0x1000,0x3000,0x300,0x800),(0x2000,0x3000,0x300,0x800)])
        r=evidence.map_address(data,context(data),'elf_va','0x3180')
        self.assertEqual(r['state'],'ambiguous');self.assertEqual(len(r['candidates']),2)
        self.assertNotEqual(r['candidates'][0]['file_offset'],r['candidates'][1]['file_offset'])

    def test_identity_and_context_revision(self):
        data=elf();a=context(data);b=dict(a,load_instance_id='synthetic-load-2')
        first=evidence.map_address(data,a,'elf_va',0x3180);second=evidence.map_address(data,b,'elf_va',0x3180)
        self.assertNotEqual(first['context_sha256'],second['context_sha256'])
        with self.assertRaises(ValueError):evidence.map_address(data,dict(a,image_sha256='0'*64),'elf_va',0x3180)

    def test_unmapped_endpoints_and_no_pointer_stripping(self):
        data=elf();c=context(data)
        for value in (0x2fff,0x3800,0xaa00000000003180):self.assertEqual(evidence.map_address(data,c,'elf_va',value)['state'],'unmapped')
        self.assertEqual(evidence.map_address(data,c,'elf_va',0x3181)['candidates'][0]['elf_va'],'0x3181')

    def test_invalid_width_header_and_overflow(self):
        for data in (b'',b'not ELF',elf()[:80]):
            with self.assertRaises(ValueError):evidence.elf_segments(data)
        data=elf(32)
        with self.assertRaises(ValueError):evidence.map_address(data,dict(context(data),load_bias=0xfffff000),'elf_va',0x3180)
        for v in (True,-1,'-0x1','0x10000000000000000'):
            with self.assertRaises(ValueError):evidence.number(v)

    def test_negative_rebase_and_unknown_context_extensions(self):
        data=elf();c=dict(context(data),ghidra_rebase_delta='-0x1000',experiment_note={'custom':'not a required gate'})
        self.assertEqual(evidence.map_address(data,c,'ghidra_va','0x2180')['candidates'][0]['elf_va'],'0x3180')


class PassiveDiscovery(unittest.TestCase):
    def test_no_subprocess_import_or_device_probe(self):
        with patch.object(subprocess,'Popen',side_effect=AssertionError('No active process allowed')):
            result=re_lab.doctor()
        self.assertEqual(result['commands_executed'],0)
        self.assertTrue(all(v['state']=='not_probed' for v in result['operations'].values()))
        self.assertNotIn('ready',result)

    def test_explicit_executable_is_only_discovered(self):
        with tempfile.TemporaryDirectory() as d:
            p=Path(d)/'custom-tool';p.write_text('This is not executable')
            result=re_lab.doctor({'tools':{'custom-observer':str(p)}})
            self.assertEqual(result['tools']['custom-observer']['state'],'discovered')
            self.assertFalse(result['tools']['custom-observer']['executable_tested'])

    def test_venv_metadata_does_not_import_package(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d);(root/'pyvenv.cfg').write_text('fixture')
            scripts=root/'bin';scripts.mkdir();python=scripts/'python3';python.write_text('fixture')
            packages=root/'lib/python3.12/site-packages';dist=packages/'frida-17.0.0.dist-info';dist.mkdir(parents=True)
            (dist/'METADATA').write_text('Name: frida\nVersion: 17.0.0\n')
            module=packages/'frida';module.mkdir();(module/'__init__.py').write_text('raise RuntimeError("must not import")')
            result=re_lab.inspect_python(python)
            self.assertEqual(result['packages']['frida']['metadata'][0]['version'],'17.0.0')
            self.assertFalse(result['packages']['frida']['runtime_tested'])

    def test_unknown_and_missing_do_not_block_other_methods(self):
        result=re_lab.doctor({'tools':{'custom-optional':'/no-such-re-lab-tool'}})
        self.assertTrue(result['ok']);self.assertEqual(result['tools']['custom-optional']['state'],'not_discovered')
        self.assertTrue(result['fallbacks'])
        for config in ([],{'commands':['adb devices']},{'tools':{'a':['not a path']}}):
            with self.assertRaises(ValueError):re_lab.doctor(config)


class Evidence(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.root=Path(self.tmp.name);self.source=self.root/'original.bin';self.source.write_bytes(bytes(range(256))*64)
        self.store=self.root/'store';self.provenance={'backend':'synthetic','run_id':'run-1','source_kind':'synthetic','notes':{'custom':True}}

    def test_immutable_copy_reopens_without_backend(self):
        result=evidence.store_file(self.store,self.source,self.provenance)
        self.source.write_bytes(b'changed source')
        saved=evidence.verify_record(self.store,result['record_id'])
        self.assertTrue(saved['verified_local_hash']);self.assertTrue(saved['local_copy_complete'])
        self.assertEqual(saved['stream_completeness'],'unknown');self.assertIsNone(saved['target_accepted'])
        self.assertEqual(saved['provenance'],self.provenance)

    def test_duplicate_content_keeps_run_provenance(self):
        a=evidence.store_file(self.store,self.source,self.provenance)
        b=evidence.store_file(self.store,self.source,dict(self.provenance,run_id='run-2'))
        self.assertEqual(a['sha256'],b['sha256']);self.assertNotEqual(a['record_id'],b['record_id'])
        self.assertEqual(len(list((self.store/'objects').iterdir())),1)

    def test_cli_reopen_without_original_or_backend(self):
        metadata=self.root/'provenance.json';metadata.write_text(json.dumps(self.provenance))
        cli=ROOT/'skills/re-dynamic/scripts/re_lab.py'
        saved=json.loads(subprocess.check_output([sys.executable,str(cli),'seal','--store',str(self.store),'--file',str(self.source),'--provenance',str(metadata)],text=True))
        self.source.unlink()
        checked=json.loads(subprocess.check_output([sys.executable,str(cli),'verify','--store',str(self.store),'--record',saved['record_id']],text=True))
        self.assertTrue(checked['verified_local_hash']);self.assertEqual(saved['sha256'],checked['sha256'])

    def test_corrupted_object_or_record_never_verifies(self):
        result=evidence.store_file(self.store,self.source,self.provenance)
        object_path=self.store/'objects'/result['sha256'];object_path.write_bytes(b'corrupt')
        with self.assertRaises(ValueError):evidence.verify_record(self.store,result['record_id'])
        record=self.store/'records'/(result['record_id']+'.json');record.write_text('{"schema":"changed"}')
        with self.assertRaises(ValueError):evidence.verify_record(self.store,result['record_id'])

    def test_non_object_record_and_interrupted_publish(self):
        evidence.store_file(self.store,self.source,self.provenance)
        malformed=b'[]';digest=hashlib.sha256(malformed).hexdigest()
        (self.store/'records'/(digest+'.json')).write_bytes(malformed)
        with self.assertRaises(ValueError):evidence.verify_record(self.store,digest)
        count=len(list((self.store/'records').glob('*.json')))
        with patch.object(evidence,'publish',side_effect=OSError('synthetic manifest failure')),self.assertRaises(OSError):
            evidence.store_file(self.store,self.source,dict(self.provenance,run_id='new-run'))
        self.assertEqual(len(list((self.store/'records').glob('*.json'))),count)
        self.assertFalse(list((self.store/'objects').glob('.re-pending-*')))

    def test_limits_and_bad_provenance_do_not_publish_receipts(self):
        for p in ({},dict(self.provenance,source_kind='invented')):
            with self.assertRaises(ValueError):evidence.store_file(self.store,self.source,p)
        self.assertFalse(self.store.exists())
        with self.assertRaises(ValueError):evidence.store_file(self.store,self.source,self.provenance,max_bytes=100)
        self.assertFalse(self.store.exists())

    def test_path_injection_and_snapshot_copy_race(self):
        with self.assertRaises(ValueError):evidence.verify_record(self.store,'../original.bin')
        original=evidence.fingerprint;calls=[0]
        def changed(info):
            calls[0]+=1
            value=original(info)
            return value if calls[0]==1 else (*value[:-1],value[-1]+1)
        with patch.object(evidence,'fingerprint',side_effect=changed),self.assertRaises(ValueError):
            evidence.store_file(self.store,self.source,self.provenance)
        self.assertEqual(list((self.store/'records').glob('*.json')),[])
        self.assertEqual(list((self.store/'objects').glob('.re-pending-*')),[])

    @unittest.skipUnless(os.name=='posix','POSIX special-file and symlink checks')
    def test_fifo_and_symlink_refusal(self):
        fifo=self.root/'fifo';os.mkfifo(fifo)
        with self.assertRaises(ValueError):evidence.store_file(self.store,fifo,self.provenance)
        link=self.root/'link';link.symlink_to(self.source)
        with self.assertRaises(ValueError):evidence.store_file(self.store,link,self.provenance)
        self.assertFalse(self.store.exists())


class Stdio(unittest.TestCase):
    def run_fixture(self,mode,**options):
        with tempfile.TemporaryDirectory() as d:
            audit=Path(d)/'audit.json'
            descriptor={'argv':[sys.executable,str(ROOT/'tests/fixtures/re-lab-mcp.py'),mode,str(audit)]}
            try:
                return inspect_stdio(descriptor,**options),json.loads(audit.read_text())
            finally:
                if audit.exists() and os.name=='posix':
                    pid=json.loads(audit.read_text())['pid']
                    with self.assertRaises(ProcessLookupError):os.kill(pid,0)

    def test_initialize_full_tool_pages_without_tool_execution(self):
        with patch.dict(os.environ,{'RE_LAB_SYNTHETIC_PROVIDER_SECRET':'not-a-real-secret'}):
            result,audit=self.run_fixture('normal')
        self.assertEqual(result['advertised_tools'],['frida_attach','frida_spawn'])
        self.assertEqual(audit['requests'],['initialize','notifications/initialized','tools/list','tools/list'])
        self.assertFalse(audit['provider_secret_inherited']);self.assertEqual(result['tool_calls'],0)
        self.assertEqual(result['frida_attach'],'not_probed');self.assertTrue(result['owned_process_reaped'])

    def test_malformed_version_host_service_and_repeated_cursor(self):
        for mode in ('malformed','version','host-request','cursor','duplicate','bool-id','nonfinite'):
            with self.subTest(mode=mode),self.assertRaises(ValueError):self.run_fixture(mode)

    def test_deadline_and_transport_bound_are_explicit(self):
        with self.assertRaises(ValueError):self.run_fixture('timeout',timeout=.25)
        with self.assertRaises(ValueError):self.run_fixture('oversized',max_message=4096)

    @unittest.skipUnless(sys.platform.startswith('linux'),'Linux owned process group observation')
    def test_owned_descendant_does_not_survive_server_exit(self):
        result,audit=self.run_fixture('grandchild')
        status=Path('/proc')/str(audit['child_pid'])/'stat'
        if status.exists():self.assertEqual(status.read_text().rsplit(')',1)[1].split()[0],'Z')
        self.assertEqual(result['cleanup_scope'],'owned process group')

    def test_shell_string_and_implicit_actions_refused(self):
        for descriptor in ({'argv':'adb devices'},{'argv':['anything'],'auto_attach':True},{'argv':[]},{'argv':['node'],'env':{'bad=key':'value'}}):
            with self.assertRaises(ValueError):inspect_stdio(descriptor)


if __name__=='__main__':unittest.main(verbosity=2)
