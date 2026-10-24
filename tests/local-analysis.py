#!/usr/bin/env python3
"""Synthetic static evidence checks; no challenge files, filters or models executed."""
import contextlib
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import struct
import tempfile
import unittest

ROOT=Path(os.environ.get('DSH_LOCAL_SKILL_ROOT',Path(__file__).resolve().parents[1]))
def load(name):
    spec=importlib.util.spec_from_file_location(name,ROOT/'skills/pwn-exploit/scripts'/f'{name}.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);return m
bpf=load('seccomp_bpf');api=load('sqlite_api_map');lab=load('local_lab')
def elf_fixture(duplicate=False,reloc=8):
    d=bytearray(0x2000);d[:7]=b'\x7fELF\x02\x01\x01';struct.pack_into('<HHIQQQIHHHHHH',d,16,3,62,1,0,64,0x1000,0,64,56,1,64,4,0)
    struct.pack_into('<IIQQQQQQ',d,64,1,6,0,0x400000,0,0x2000,0x3000,0x1000)
    strings=b'\0sqlite3_a\0sqlite3_b\0sqlite3_c\0sqlite3_d\0';d[0x600:0x600+len(strings)]=strings
    for i in range(1,5):struct.pack_into('<IBBHQQ',d,0x400+i*24,1+(i-1)*10,0x12,0,1,0x400c00+i*16,4)
    for i in range(4):
        value=0x400c00+(i+1)*16;struct.pack_into('<QQq',d,0x800+i*24,0x400200+i*8,reloc,value)
        if duplicate:struct.pack_into('<Q',d,0x300+i*8,value)
    sections=[(0,0,0,0,0,0,0,0,0,0),(0,3,0,0,0x600,len(strings),0,0,1,0),(0,11,0,0,0x400,120,1,0,8,24),(0,4,0,0,0x800,96,2,0,8,24)]
    for i,s in enumerate(sections):struct.pack_into('<IIQQQQIIQQ',d,0x1000+i*64,*s)
    return d

class BPFEvidence(unittest.TestCase):
    def test_generated_policies_against_independent_expected_actions(self):
        for mode in ('allowlist','denylist'):
            rows=bpf.generate(mode,[59,322])
            for nr in (0,1,59,322,999,0x4000003b):
                for arch in (0xc000003e,0x40000003):
                    listed=nr in (59,322);expected=0x80000000 if arch!=0xc000003e or nr&0x40000000 else (0x7fff0000 if (listed==(mode=='allowlist')) else 0x50001 if mode=='denylist' else 0x80000000)
                    self.assertEqual(bpf.evaluate(rows,arch,nr)['result']['raw'],expected)
    def test_three_encodings_preserve_fields(self):
        rows=[(0x20,0,0,16),(0x15,0,1,31),(6,0,0,0x50007),(6,0,0,0x7fff0000)];raw=b''.join(struct.pack('<HBBI',*r) for r in rows)
        forms=[('bytes-le',raw),('u64-words',(' '.join(hex(int.from_bytes(raw[i:i+8],'little')) for i in range(0,len(raw),8))).encode()),('tuples',json.dumps(rows).encode())]
        for kind,data in forms:self.assertEqual(bpf.instructions(data,kind),rows)
        self.assertEqual(bpf.evaluate(rows,0xc000003e,1,[31])['result']['data'],7)
        self.assertEqual(bpf.evaluate(rows,0xc000003e,1,[32])['result']['action'],'ALLOW')
    def test_invalid_input_and_jumps(self):
        for data in (b'',b'123',b'0'*9):
            with self.assertRaises(ValueError):bpf.instructions(data)
        for row in [(0x15,255,0,0),(5,0,0,999)]:
            with self.assertRaises(ValueError):bpf.decode([row,(6,0,0,0)])
        with self.assertRaises(ValueError):bpf.instructions(b'[[true,0,0,0]]','tuples')
    def test_unknown_never_becomes_allow(self):
        for rows in [[(0xffff,0,0,0)],[(0x20,0,0,99),(0x16,0,0,0)],[(0x16,0,0,0)],[(6,0,0,0x12340000)]]:self.assertEqual(bpf.evaluate(rows,0xc000003e,0)['state'],'unknown')
    def test_alu_width_and_fallthrough(self):
        rows=[(0,0,0,0xffffffff),(4,0,0,2),(0x16,0,0,0)];self.assertEqual(bpf.evaluate(rows,0xc000003e,0)['result']['raw'],1)
        self.assertEqual(bpf.evaluate([(0,0,0,1)],0xc000003e,0)['state'],'invalid')
        self.assertEqual(bpf.evaluate([(0,0,0,1),(0x34,0,0,0)],0xc000003e,0)['state'],'unknown')
    def test_source_hash_and_no_overwrite(self):
        with tempfile.TemporaryDirectory() as td:
            p=Path(td);raw=struct.pack('<HBBI',6,0,0,0x7fff0000);(p/'in').write_bytes(b'prefix!!'+raw)
            with contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(bpf.main(['--input',str(p/'in'),'--offset','8','--length','8','--out',str(p/'out')]),0)
                first=(p/'out').read_bytes();self.assertEqual(bpf.main(['--generate','denylist','--out',str(p/'out')]),4)
            r=json.loads(first);self.assertEqual(r['source']['fragment_sha256'],hashlib.sha256(raw).hexdigest());self.assertEqual((p/'out').read_bytes(),first)

class SQLiteEvidence(unittest.TestCase):
    def test_relative_relocations_and_symbols(self):
        elf=api.ELF(elf_fixture());e=elf.entry(0x400200);self.assertEqual(e['value'],0x400c10);self.assertEqual(e['symbols'],['sqlite3_a']);self.assertEqual(e['state'],'relative_to_load_bias');self.assertIsNone(e['runtime_address'])
    def test_candidates_not_automatically_selected(self):
        elf=api.ELF(elf_fixture(True));c=elf.candidates(4,4);self.assertEqual({v['table_va'] for v in c},{0x400200,0x400300})
        d=elf_fixture();d=bytes(d).replace(b'sqlite3_',b'xxxxxxx_');self.assertEqual(api.ELF(d).candidates(4,4),[])
    def test_unknown_relocation_hides_symbol_guess(self):
        d=elf_fixture(reloc=37);struct.pack_into('<Q',d,0x200,0x400c10);e=api.ELF(d).entry(0x400200);self.assertEqual(e['state'],'unknown');self.assertEqual(e['symbols'],[])
    def test_named_relocation_is_reference_not_runtime_address(self):
        d=elf_fixture(reloc=1)
        for i in range(4):struct.pack_into('<QQq',d,0x800+i*24,0x400200+i*8,((i+1)<<32)|1,0)
        elf=api.ELF(d);e=elf.entry(0x400200);self.assertIsNone(e['value']);self.assertIsNone(e['runtime_address']);self.assertEqual(e['symbols'],[]);self.assertEqual(e['relocation_symbol']['name'],'sqlite3_a');self.assertEqual(len(elf.candidates(4,4)),1)
    def test_repeatable_needed_tags_are_not_conflicting_relocations(self):
        d=elf_fixture();struct.pack_into('<H',d,56,2);struct.pack_into('<IIQQQQQQ',d,120,2,6,0xa00,0x400a00,0,48,48,8);struct.pack_into('<qQqQqQ',d,0xa00,1,11,1,22,0,0)
        self.assertEqual(api.ELF(d).entry(0x400200)['symbols'],['sqlite3_a'])
    def test_wrong_abi_and_malformed_file(self):
        for index,value in [(4,1),(5,2),(18,3)]:
            d=elf_fixture();d[index]=value
            with self.assertRaises(ValueError):api.ELF(d)
        with self.assertRaises(ValueError):api.ELF(elf_fixture()[:100])
    def test_raw_and_virtual_bounds(self):
        e=api.ELF(elf_fixture())
        for va in (0x3ffff8,0x402000,0x402100):
            with self.assertRaises(ValueError):e.entry(va)
    def test_unsupported_relocation_format(self):
        for typ in (9,19):
            d=elf_fixture();struct.pack_into('<I',d,0x1000+3*64+4,typ)
            with self.assertRaises(ValueError):api.ELF(d)
    def test_dynamic_relocations_must_have_parsed_section_coverage(self):
        d=elf_fixture();struct.pack_into('<H',d,56,2);struct.pack_into('<IIQQQQQQ',d,120,2,6,0xa00,0x400a00,0,64,64,8)
        for i,(tag,val) in enumerate([(7,0x400800),(8,96),(9,24),(0,0)]):struct.pack_into('<qQ',d,0xa00+i*16,tag,val)
        self.assertEqual(api.ELF(d).entry(0x400200)['symbols'],['sqlite3_a'])
        struct.pack_into('<Q',d,0xa08,0x400b00)
        with self.assertRaises(ValueError):api.ELF(d)
    def test_dynamic_relr_cannot_hide_behind_missing_section(self):
        d=elf_fixture();struct.pack_into('<H',d,56,2);struct.pack_into('<IIQQQQQQ',d,120,2,6,0xa00,0x400a00,0,32,32,8);struct.pack_into('<qQqQ',d,0xa00,36,0x400b00,0,0)
        with self.assertRaises(ValueError):api.ELF(d)
    def test_layout_hash_and_version(self):
        with tempfile.TemporaryDirectory() as td:
            p=Path(td);header=p/'sqlite3ext.h';header.write_bytes(b'controlled header fixture');manifest=p/'layout.json';layout={'pointer_bytes':8,'machine':'x86_64','sqlite_version':'fixture','header_sha256':hashlib.sha256(header.read_bytes()).hexdigest(),'fields':[{'offset':0,'name':'a'}]};manifest.write_text(json.dumps(layout))
            self.assertEqual(api.layout_file(manifest,header,None)['library_version_match'],'unknown')
            with self.assertRaises(ValueError):api.layout_file(manifest,header,'other')
            header.write_bytes(b'changed')
            with self.assertRaises(ValueError):api.layout_file(manifest,header,None)

class BoundaryExamples(unittest.TestCase):
    def test_circular_equation_does_not_prove_pointer(self):
        guard,record=12345,98765
        for wrong_pointer in (1,2,3):
            key=guard^wrong_pointer^record;self.assertEqual(key^wrong_pointer^record,guard)
    def test_fd_is_not_a_fixed_small_range(self):
        if os.name!='posix':self.skipTest('POSIX fd duplication fixture; run in Linux regression')
        import socket
        a,b=socket.socketpair()
        try:
            # A duplicated live endpoint above 15 remains a socket, without global guessing.
            if os.name=='posix':
                import fcntl
                fd=fcntl.fcntl(a.fileno(),fcntl.F_DUPFD,32)
                try:self.assertTrue(__import__('stat').S_ISSOCK(os.fstat(fd).st_mode));self.assertGreaterEqual(fd,32)
                finally:os.close(fd)
        finally:a.close();b.close()

if __name__=='__main__':unittest.main()
