#!/usr/bin/env python3
"""Authored PE metadata cases; --native-windows also runs only known local fixtures."""
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import struct
import subprocess
import sys
import tempfile
import unittest

ROOT=Path(__file__).resolve().parents[1]
SOURCE=Path(os.environ.get('DSH_WINDOWS_SKILL_ROOT',str(ROOT)))
def load(name,relative):
    spec=importlib.util.spec_from_file_location(name,SOURCE/relative);module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module
pe=load('pe_triage', 'skills/pwn-exploit/scripts/pe_triage.py')
debug=load('windows_debug','skills/re-dynamic/scripts/windows_debug.py')
NATIVE='--native-windows' in sys.argv
if NATIVE:sys.argv.remove('--native-windows')

def fixture(bits=64,config_size=None,flags=0,cet=None,managed=False):
    data=bytearray(0xa00);data[:2]=b'MZ';struct.pack_into('<I',data,60,0x80);data[0x80:0x84]=b'PE\0\0'
    struct.pack_into('<HH',data,0x84,0x8664 if bits==64 else 0x14c,1);struct.pack_into('<HH',data,0x94,240 if bits==64 else 224,0x22 if bits==64 else 0x102)
    opt=0x98;struct.pack_into('<H',data,opt,0x20b if bits==64 else 0x10b);struct.pack_into('<I',data,opt+16,0x1000)
    struct.pack_into('<I',data,opt+4,0x800);struct.pack_into('<I',data,opt+20,0x1000)
    struct.pack_into('<HH',data,opt+40,6,0);struct.pack_into('<HH',data,opt+48,6,0)
    struct.pack_into('<Q' if bits==64 else '<I',data,opt+(24 if bits==64 else 28),0x140000000 if bits==64 else 0x400000)
    struct.pack_into('<II',data,opt+32,0x1000,0x200);struct.pack_into('<II',data,opt+56,0x2000,0x200);struct.pack_into('<HH',data,opt+68,3,flags)
    if bits==64:struct.pack_into('<QQQQ',data,opt+72,0x100000,0x1000,0x100000,0x1000)
    else:struct.pack_into('<IIII',data,opt+72,0x100000,0x1000,0x100000,0x1000)
    dirs=opt+(112 if bits==64 else 96);struct.pack_into('<I',data,dirs-4,16)
    section=opt+(240 if bits==64 else 224);data[section:section+8]=b'.test\0\0\0';struct.pack_into('<IIII',data,section+8,0x800,0x1000,0x800,0x200);struct.pack_into('<I',data,section+36,0xe0000020)
    data[0x200:0x202]=b'\x0f\x0b' # Explicit harmless illegal-instruction fixture, no imports or payload.
    if config_size is not None:
        struct.pack_into('<II',data,dirs+10*8,0x1100,config_size);struct.pack_into('<I',data,0x300,config_size)
    if cet is not None:
        struct.pack_into('<II',data,dirs+6*8,0x1300,28);struct.pack_into('<IIII',data,0x500+12,20,4,0x1400,0x600);struct.pack_into('<I',data,0x600,cet)
    if managed:
        struct.pack_into('<II',data,dirs+14*8,0x1600,72);struct.pack_into('<IHHIII',data,0x800,72,2,5,0x1700,16,1);data[0x900:0x904]=b'BSJB'
    return data

class MetadataTests(unittest.TestCase):
    def test_architectures_and_declarations(self):
        for bits in (32,64):
            value=pe.inspect(fixture(bits,flags=0x4140))
            self.assertEqual(value['bits'],bits);self.assertTrue(value['static_declarations']['dynamic_base']);self.assertTrue(value['static_declarations']['guard_cf']);self.assertEqual(value['runtime_policy']['state'],'unknown');self.assertIsNone(value['target_accepted'])
    def test_cet_comes_from_debug_not_regular_flags(self):
        self.assertIsNone(pe.inspect(fixture(flags=1))['static_declarations']['extended_dll_characteristics']['cet_compat'])
        self.assertTrue(pe.inspect(fixture(cet=1))['static_declarations']['extended_dll_characteristics']['cet_compat'])
        self.assertFalse(pe.inspect(fixture(cet=0))['static_declarations']['extended_dll_characteristics']['cet_compat'])
    def test_old_load_config_fields_remain_unknown(self):
        for bits in (32,64):
            d=pe.inspect(fixture(bits,config_size=4))['static_declarations']['load_config']
            self.assertEqual(d['fields']['GuardEHContinuationTable']['state'],'unknown');self.assertEqual(d['fields']['SecurityCookie']['state'],'unknown')
    def test_cookie_and_tables_are_metadata_only(self):
        for bits,size,cookie,seh,count,eh,ehcount in [(32,172,60,64,68,164,168),(64,280,88,96,104,264,272)]:
            data=fixture(bits,config_size=size);base=0x140000000 if bits==64 else 0x400000;fmt='<Q' if bits==64 else '<I'
            for offset in (cookie,seh,eh):struct.pack_into(fmt,data,0x300+offset,base+0x1500)
            for offset in (count,ehcount):struct.pack_into(fmt,data,0x300+offset,1)
            value=pe.inspect(data);fields=value['static_declarations']['load_config']['fields']
            self.assertEqual(fields['SecurityCookie']['value'],base+0x1500);self.assertEqual(fields['GuardEHContinuationCount']['value'],1);self.assertEqual(value['exploitability'],'not-determined')
    def test_inconsistent_or_nonbacked_table_warns(self):
        data=fixture(config_size=280);struct.pack_into('<Q',data,0x300+128,0x140005000)
        self.assertTrue(pe.inspect(data)['warnings'])
    def test_managed_header_is_not_pure_il_claim(self):
        value=pe.inspect(fixture(managed=True));self.assertEqual(value['static_declarations']['managed_metadata']['state'],'present');self.assertNotIn('pure_il',value)
    def test_invalid_headers_rejected(self):
        cases=[b'',b'MZ',bytes(64)]
        data=fixture();data[0x80:0x84]=b'NOPE';cases.append(data)
        data=fixture();struct.pack_into('<I',data,60,0xfffffff0);cases.append(data)
        data=fixture();struct.pack_into('<H',data,0x98,0x999);cases.append(data)
        for data in cases:
            with self.subTest(length=len(data)),self.assertRaises(pe.PEError):pe.inspect(data)
    def test_directory_count_and_structure_size_bounds(self):
        data=fixture();struct.pack_into('<I',data,0x98+108,17)
        with self.assertRaises(pe.PEError):pe.inspect(data)
        data=fixture(config_size=4);struct.pack_into('<I',data,0x300,280)
        with self.assertRaises(pe.PEError):pe.inspect(data)
    def test_ambiguous_rva_and_virtual_padding_rejected(self):
        data=fixture(cet=1);section=0x188;struct.pack_into('<I',data,section+12,0)
        with self.assertRaises(pe.PEError):pe.PE(data).rva(0x100,4)
        data=fixture();struct.pack_into('<I',data,section+8,0x2000)
        with self.assertRaises(pe.PEError):pe.PE(data).rva(0x1900,4)
    def test_raw_ranges_and_machine_consistency(self):
        data=fixture();struct.pack_into('<I',data,0x188+20,0xfffffff0)
        with self.assertRaises(pe.PEError):pe.inspect(data)
        data=fixture();struct.pack_into('<H',data,0x84,0x14c)
        with self.assertRaises(pe.PEError):pe.inspect(data)
    def test_short_debug_and_cli_metadata_rejected(self):
        data=fixture(cet=1);struct.pack_into('<I',data,0x98+112+6*8+4,27)
        with self.assertRaises(pe.PEError):pe.inspect(data)
        data=fixture(managed=True);struct.pack_into('<I',data,0x800,24)
        with self.assertRaises(pe.PEError):pe.inspect(data)
    def test_cli_and_existing_dispatch_preserve_input(self):
        with tempfile.TemporaryDirectory() as folder:
            p=Path(folder)/'sample.exe';body=bytes(fixture());p.write_bytes(body)
            for script in ('pe_triage.py','pwn_triage.py'):
                v=subprocess.run([sys.executable,str(SOURCE/'skills/pwn-exploit/scripts'/script),str(p)],capture_output=True,text=True)
                self.assertEqual(v.returncode,0,v.stderr);self.assertEqual(json.loads(v.stdout)['format'],'PE32+');self.assertEqual(p.read_bytes(),body)
            p.write_bytes(b'not a pe');v=subprocess.run([sys.executable,str(SOURCE/'skills/pwn-exploit/scripts/pe_triage.py'),str(p)],capture_output=True,text=True);self.assertEqual(v.returncode,4);self.assertFalse(json.loads(v.stdout)['ok'])
    def test_describe_is_offline(self):
        for script in ('skills/pwn-exploit/scripts/pe_triage.py','skills/re-dynamic/scripts/windows_debug.py'):
            p=subprocess.run([sys.executable,str(SOURCE/script),'--describe'],capture_output=True,text=True);self.assertEqual(p.returncode,0,p.stderr);self.assertIsNone(json.loads(p.stdout)['target_accepted'])
    def test_nonfinite_budget_and_existing_output_refused(self):
        for value in ('nan','inf','-1'):
            stream=io.StringIO()
            with contextlib.redirect_stdout(stream):code=debug.main(['--timeout',value])
            self.assertEqual(code,4);self.assertFalse(json.loads(stream.getvalue())['ok'])

@unittest.skipUnless(NATIVE and debug.native_host(),'explicit --native-windows and Windows x64 Python required')
class NativeTests(unittest.TestCase):
    def test_real_images_static_without_running_them(self):
        for p in [Path(sys.executable),Path(os.environ['SystemRoot'])/'System32/kernel32.dll',Path(os.environ['SystemRoot'])/'System32/ntdll.dll']:
            value=pe.inspect(p.read_bytes());self.assertTrue(value['ok']);self.assertEqual(value['runtime_policy']['state'],'unknown')
    def test_raw_output_and_output_collision(self):
        with tempfile.TemporaryDirectory() as folder:
            out=Path(folder)/'new';value=debug.observe(sys.executable,['-c','import sys;sys.stdout.buffer.write(bytes([0,255,13,10]));sys.stderr.buffer.write(bytes([128,0]))'],out)
            self.assertTrue(value['ok']);self.assertEqual((out/'stdout.bin').read_bytes(),bytes([0,255,13,10]));self.assertEqual((out/'stderr.bin').read_bytes(),bytes([128,0]))
            with self.assertRaises(FileExistsError):debug.observe(sys.executable,['-c','pass'],out)
    def test_stdin_snapshot_preserves_binary_and_source(self):
        with tempfile.TemporaryDirectory() as folder:
            original=Path(folder)/'input.bin';data=bytes([0,255,13,10])*100000;original.write_bytes(data);out=Path(folder)/'new'
            value=debug.observe(sys.executable,['-c','import sys;sys.stdout.buffer.write(sys.stdin.buffer.read())'],out,stdin_path=original)
            self.assertTrue(value['ok']);self.assertEqual((out/'stdin.bin').read_bytes(),data);self.assertEqual((out/'stdout.bin').read_bytes(),data);self.assertEqual(original.read_bytes(),data);self.assertEqual(value['stdin']['bytes'],len(data))
    def test_real_baseline_io_argv_and_policy(self):
        with tempfile.TemporaryDirectory() as folder:
            out=Path(folder)/'new';arguments=['space value','引号"尾\\'];value=debug.observe(sys.executable,['-c','import json,sys;print(json.dumps(sys.argv[1:]))',*arguments],out)
            self.assertTrue(value['ok'],value.get('error'));self.assertEqual(value['exit_code'],0);self.assertEqual(json.loads((out/'stdout.bin').read_bytes()),arguments);self.assertEqual(value['cleanup']['state'],'confirmed');self.assertTrue(value['sample_file_unchanged']);self.assertIsNone(value['target_accepted']);self.assertTrue(value['modules']);self.assertEqual(value['initial_process_policy']['state'],'queried')
            events=[e for e in value['events'] if e['event']==1];self.assertTrue(events);self.assertEqual(events[0]['context']['state'],'observed');self.assertGreater(events[0]['context']['stack_snapshot']['read_bytes'],0)
    def test_known_x64_and_wow64_faults(self):
        with tempfile.TemporaryDirectory() as folder:
            for bits in (64,32):
                sample=Path(folder)/f'owned-{bits}.exe';sample.write_bytes(fixture(bits));out=Path(folder)/f'result-{bits}';value=debug.observe(sample,[],out,timeout=10)
                self.assertTrue(value['ok'],value.get('error'));self.assertEqual(value['exit_code'],0xc000001d);events=[e for e in value['events'] if e.get('exception_code')==0xc000001d];self.assertTrue(events);self.assertTrue(any(not e['first_chance'] for e in events));event=events[0];self.assertEqual(event['context']['state'],'observed');pc=event['context']['registers']['rip' if bits==64 else 'eip'];base=value['modules'][0]['base'];self.assertEqual(pc,base+0x1000);self.assertIsNone(value['target_accepted'])
    def test_event_limit_and_timeout_only_clean_own_child(self):
        with tempfile.TemporaryDirectory() as folder:
            for timeout,limit,reason in [(0.15,1024,'experiment_timeout'),(10,1,'event_capture_limit')]:
                out=Path(folder)/reason;value=debug.observe(sys.executable,['-c','import time;time.sleep(30)'],out,timeout=timeout,max_events=limit)
                self.assertFalse(value['ok']);self.assertEqual(value['stop_reason'],reason);self.assertEqual(value['cleanup']['state'],'confirmed')
    def test_check_and_policy_query_do_not_spawn(self):
        api=debug.API();handle=api.check(api.k.OpenProcess(0x400,False,os.getpid()),'Read own policy')
        try:self.assertEqual(api.policies(handle)['state'],'queried')
        finally:api.close(handle)
        output=io.StringIO()
        with contextlib.redirect_stdout(output):code=debug.main(['--check',sys.executable])
        self.assertEqual(code,0);self.assertFalse(json.loads(output.getvalue())['execution'])

if __name__=='__main__':unittest.main()
