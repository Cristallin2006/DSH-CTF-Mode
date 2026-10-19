#!/usr/bin/env python3
"""Independent synthetic recovery regressions; no models, targets or real sessions."""
import copy
import hashlib
import importlib.util
import itertools
import json
import os
from pathlib import Path
import random
import subprocess
import sys
import tempfile
import unittest

ROOT=Path(os.environ.get('DSH_RECOVERY_TEST_ROOT',str(Path(__file__).resolve().parent.parent)))
TOOL=ROOT/'skills/ghidra-core/scripts/transform_search.py'
spec=importlib.util.spec_from_file_location('recovery_tool',TOOL)
tool=importlib.util.module_from_spec(spec);spec.loader.exec_module(tool)
xspec=importlib.util.spec_from_file_location('xor_scanner',ROOT/'skills/ghidra-core/scripts/xor_scan.py')
xor=importlib.util.module_from_spec(xspec);xspec.loader.exec_module(xor)


def reference(data,op):
    # Separate fixture/checker implementation, never calls the searcher's helpers.
    result=[]
    for i,byte in enumerate(data):
        if op['op']=='xor':
            key=bytes.fromhex(op['key_hex']);value=byte^key[(i+op.get('phase',0))%len(key)]
        elif op['op'] in ('rol','ror'):
            bits=f'{byte:08b}';count=op['count']%8
            if op['op']=='ror':count=(-count)%8
            value=int(bits[count:]+bits[:count],2)
        elif op['op']=='affine':value=(op['a']*byte+op['b'])%256
        elif op['op']=='add':value=(byte+op['value'])%256
        elif op['op']=='sub':value=(byte-op['value'])%256
        elif op['op']=='index_xor':value=byte^((op['a']*i+op['b'])%256)
        elif op['op']=='index_add':value=(byte+op['a']*i+op['b'])%256
        else:raise AssertionError('unsupported checker operation')
        result.append(value)
    return bytes(result)


def request(data,pipelines,**updates):
    value={'version':1,'source':{'hex':data.hex(),'basis':'synthetic'},'width':8,'direction':'forward',
           'pipelines':pipelines,'criteria':{},'budget':{'max_input_bytes':4096,'max_paths':10000,'max_byte_ops':10000000},'top':1000}
    value.update(updates);return value


class Recovery(unittest.TestCase):
    def test_byte_semantics_and_inverses(self):
        data=bytes(range(256))
        ops=[{'op':op,'count':n} for op in ('rol','ror') for n in range(9)]
        ops += [{'op':'affine','a':a,'b':b} for a in range(1,256,2) for b in (0,7,255)]
        ops += [{'op':'xor','key_hex':'000750','phase':p} for p in range(3)]
        ops += [{'op':op,'a':a,'b':255} for op in ('index_xor','index_add') for a in (0,3,255)]
        for op in ops:
            encoded=reference(data,op);self.assertEqual(tool.apply_op(data,tool.operation(op,len(data))),encoded)
            self.assertEqual(tool.apply_op(encoded,tool.operation(op,len(data),True)),data)

    def test_same_family_and_order(self):
        data=b'\x00\x7f\x80\xff';x={'op':'xor','key_hex':'5a'};a={'op':'add','value':19}
        expected=reference(reference(data,x),a)
        self.assertNotEqual(expected,reference(reference(data,a),x))
        r=tool.search(request(data,[[[x],[a]],[[a],[x]]]))
        self.assertEqual(r['coverage']['evaluated_paths'],2)
        self.assertEqual({c['output_sha256'] for c in r['candidates']},{tool.sha(expected),tool.sha(reference(reference(data,a),x))})

    def test_independent_generated_holdout(self):
        rng=random.Random(18437)
        for _ in range(32):
            original=rng.randbytes(24)
            ops=[{'op':'xor','key_hex':bytes([0,rng.randrange(1,256),rng.randrange(256)]).hex(),'phase':rng.randrange(3)},
                 {'op':'rol','count':rng.randrange(1,8)}, {'op':'affine','a':rng.choice(range(1,256,2)),'b':rng.randrange(256)}]
            rng.shuffle(ops);encoded=original
            for op in ops:encoded=reference(encoded,op)
            # Two choices per stage; target checker uses full bytes, not a printable-string guess.
            stages=[]
            for op in ops:
                alternative=copy.deepcopy(op)
                if op['op']=='xor':alternative['phase']=(op['phase']+1)%3
                elif op['op']=='rol':alternative['count']=(op['count']+1)%8
                else:alternative['b']=(op['b']+1)%256
                stages.append([op,alternative])
            r=tool.search(request(encoded,[stages],direction='inverse',criteria={'sha256':hashlib.sha256(original).hexdigest()}))
            self.assertEqual(r['status'],'complete');self.assertTrue(r['candidates'][0]['matches_declared_criteria'])
            self.assertEqual(tool.replay(r,1),original)

    def test_equivalence_is_exact_not_output_coincidence(self):
        data=bytes(range(32));x={'op':'xor','key_hex':'63'}
        r=tool.search(request(data,[[],[[x],[x]],[[{'op':'affine','a':3,'b':7}],[{'op':'affine','a':5,'b':9}]],[[{'op':'affine','a':15,'b':44}]]]))
        self.assertEqual(r['coverage']['considered_paths'],4);self.assertEqual(r['coverage']['equivalence_skips'],2)
        # Distinct index functions can agree on a one-byte input, but must not be claimed globally equivalent.
        r=tool.search(request(b'\x00',[[[{'op':'index_xor','a':1,'b':0},{'op':'index_xor','a':2,'b':0}]]]))
        self.assertEqual(r['coverage']['equivalence_skips'],0)

    def test_cache_eviction_preserves_coverage(self):
        q=request(b'ABCD',[[[{'op':'xor','key_hex':f'{i:02x}'} for i in (1,2,1)]]]);q['budget']['cache_entries']=1
        r=tool.search(q);self.assertEqual(r['status'],'complete');self.assertEqual(r['coverage']['evaluated_paths'],3);self.assertEqual(r['coverage']['cache_evictions'],2)

    def test_budget_incomplete_and_no_match_are_distinct(self):
        q=request(b'ABCD',[[[{'op':'add','value':i} for i in range(4)]]],criteria={'sha256':'0'*64})
        r=tool.search(q);self.assertEqual(r['status'],'complete');self.assertEqual(r['matched_evaluations'],0);self.assertTrue(r['candidates'])
        q['budget']['max_paths']=2;r=tool.search(q);self.assertEqual(r['status'],'incomplete');self.assertEqual(r['coverage']['unconsidered_paths'],2)
        q['budget']['max_byte_ops']=1;r=tool.search(q);self.assertEqual(r['status'],'incomplete');self.assertEqual(r['coverage']['considered_paths'],0)

    def test_binary_unicode_and_no_intermediate_pruning(self):
        plain='数据资源'.encode('utf-16le');op={'op':'xor','key_hex':'f500'};encoded=reference(plain,op)
        r=tool.search(request(encoded,[[[op]]],criteria={'sha256':tool.sha(plain)}));self.assertEqual(tool.replay(r,1),plain)
        self.assertTrue(r['candidates'][0]['matches_declared_criteria'])

    def test_layout_and_case(self):
        data=b'SYN{ABCD';q=request(data,[[[{'op':'word_reverse','size':4}],[{'op':'word_reverse','size':4}]]],criteria={'prefix_hex':b'syn{'.hex(),'ascii_case_insensitive':True})
        r=tool.search(q);self.assertTrue(r['candidates'][0]['matches_declared_criteria']);self.assertEqual(tool.replay(r,1),data)
        self.assertEqual(tool.apply_op(b'\x12\x80',{'op':'nibble_swap'}),b'\x21\x08')
        self.assertEqual(tool.apply_op(b'\x12\x80',{'op':'bit_reverse'}),b'\x48\x01')

    def test_model_and_input_failures(self):
        q=request(b'ab',[[[{'op':'affine','a':2,'b':7}]]],direction='inverse')
        with self.assertRaises(tool.Unsupported):tool.search(q)
        q['direction']='forward';self.assertEqual(tool.search(q)['status'],'complete')
        q['width']=32
        with self.assertRaises(tool.Unsupported):tool.search(q)
        q=request(b'abc',[[[{'op':'word_reverse','size':2}]]])
        with self.assertRaises(tool.Unsupported):tool.search(q)
        q=request(b'abc',[[]]);q['source']['length']=5
        with self.assertRaises(ValueError):tool.search(q)
        q['source']={'hex':'616263','sha256':'0'*64}
        with self.assertRaisesRegex(ValueError,'hash mismatch'):tool.search(q)

    def test_replay_source_and_output_integrity(self):
        r=tool.search(request(b'abc',[[]]));r['candidates'][0]['output_sha256']='0'*64
        with self.assertRaisesRegex(ValueError,'output hash mismatch'):tool.replay(r,1)
        with tempfile.TemporaryDirectory() as directory:
            folder=Path(directory);(folder/'data').write_bytes(b'abcd')
            q=request(b'abcd',[[]]);q['source']={'path':'data','offset':1,'length':2}
            r=tool.search(q,folder);self.assertEqual(tool.replay(r,1),b'bc');(folder/'data').write_bytes(b'xxxx')
            with self.assertRaisesRegex(ValueError,'source hash mismatch'):tool.replay(r,1)

    def test_estimate_does_not_execute_and_top_is_output_only(self):
        q=request(b'ABCD',[[[{'op':'add','value':i} for i in range(4)]]],top=1)
        estimate=tool.search(q,estimate=True);self.assertEqual(estimate['estimate']['declared_paths'],4);self.assertEqual(estimate['coverage']['evaluated_paths'],0)
        r=tool.search(q);self.assertEqual(r['coverage']['considered_paths'],4);self.assertEqual(len(r['candidates']),1);self.assertTrue(r['candidate_list_truncated'])

    def test_xor_zero_key_and_periodic_heuristic(self):
        self.assertEqual(xor.rolling_key_guess(b' '*60,3),b'\0\0\0')
        with tempfile.TemporaryDirectory() as directory:
            file=Path(directory)/'blob';file.write_bytes(b'SYN{synthetic_identity_data}')
            report=Path(directory)/'report.json'
            p=subprocess.run([sys.executable,str(ROOT/'skills/ghidra-core/scripts/xor_scan.py'),str(file),'--json',str(report)],capture_output=True,text=True,encoding='utf-8')
            self.assertEqual(p.returncode,0,p.stdout+p.stderr);r=json.loads(report.read_text(encoding='utf-8'))
            self.assertTrue(any(c['key']=='0x00' for c in r['candidates']));self.assertFalse(r['coverage']['compound_search'])

    def test_cli_private_report_replay_and_no_clobber(self):
        with tempfile.TemporaryDirectory() as directory:
            folder=Path(directory);source=folder/'spec.json';report=folder/'report.json';out=folder/'restored'
            q=request(b'ABCD',[[[{'op':'xor','key_hex':'03672d59'}]]]);source.write_text(json.dumps(q))
            def run(*args):return subprocess.run([sys.executable,str(TOOL),*map(str,args)],capture_output=True,text=True,encoding='utf-8')
            p=run('search',source,'--report',report);self.assertEqual(p.returncode,0,p.stdout+p.stderr);self.assertNotIn('03672d59',p.stdout)
            self.assertNotIn('chain',json.loads(p.stdout)['candidates'][0])
            if sys.platform!='win32':self.assertEqual(report.stat().st_mode&0o777,0o600)
            self.assertEqual(run('replay',report,'--rank',1,'--output',out).returncode,0)
            self.assertEqual(out.read_bytes(),reference(b'ABCD',q['pipelines'][0][0][0]))
            self.assertEqual(run('replay',report,'--rank',1,'--output',out).returncode,2)
            self.assertEqual(run('search',source,'--report',report).returncode,2)
            source.write_text('{"version":1,"version":2}')
            p=run('search',source);self.assertEqual(p.returncode,2);self.assertIn('duplicate JSON',p.stdout)


if __name__=='__main__':unittest.main(verbosity=2)
