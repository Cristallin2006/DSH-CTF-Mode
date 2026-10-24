#!/usr/bin/env python3
"""Pure in-memory/static fixtures; no sockets, target processes or models."""
import contextlib,hashlib,importlib.util,io,json,os,struct,tempfile,unittest
from pathlib import Path
ROOT=Path(os.environ.get('DSH_RELAY_SKILL_ROOT',Path(__file__).resolve().parents[1]))
def load(skill,name):
    spec=importlib.util.spec_from_file_location(name,ROOT/'skills'/skill/'scripts'/f'{name}.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);return m
c=load('pwn-exploit','relay_codec');w=load('re-dynamic','worker_snapshot');r=load('re-dynamic','observation_receipt')
class MemoryStream:
    def __init__(self,replies,chunk=100000):self.data=bytearray(replies);self.sent=bytearray();self.chunk=chunk;self.writes=0
    def write(self,data):self.writes+=1;n=min(len(data),self.chunk);self.sent.extend(data[:n]);return n
    def read(self,n):n=min(n,self.chunk);data=bytes(self.data[:n]);del self.data[:n];return data
class Codec(unittest.TestCase):
    def test_fields_and_exact_boundary(self):
        raw=c.make_frame(123,9,255,2,bytes(range(256)),42);p=c.parse_exact(raw,magic=123,epoch=42);self.assertEqual(p['body'],bytes(range(256)));self.assertEqual(p['sub'],255)
        for wrong in [raw+b'extra',raw[:-1],raw[:12]]:
            with self.assertRaises(ValueError):c.parse_exact(wrong)
    def test_stream_keeps_sticky_frame(self):
        a=c.prefix(c.make_frame(1,2));b=c.prefix(c.make_frame(1,3,body=b'B'))
        p=c.split_stream(a+b);self.assertEqual(p['consumed'],len(a));self.assertEqual(p['remainder'],b);self.assertEqual(c.parse_exact(c.split_stream(p['remainder'])['frame'])['body'],b'B')
        for partial in (a[:2],a[:-1]):
            with self.assertRaises(c.NeedMore):c.split_stream(partial)
    def test_protocol_direct_and_byte_fragmentation(self):
        reply=c.make_frame(123,9,body=b'yes',epoch=1);t=MemoryStream(c.prefix(reply),1);s=c.Session(t,'fixture');p=c.Protocol(c.Direct(s),123,'direct',echo_epoch=True)
        self.assertEqual(p.call(8,expect_op=9)['body'],b'yes');sent=c.split_stream(bytes(t.sent));self.assertFalse(sent['remainder']);self.assertEqual(c.parse_exact(sent['frame'])['op'],8)
    def test_tunnel_composes_with_one_outer_exchange(self):
        inner_reply=c.make_frame(222,4,body=b'inner',epoch=1);outer_reply=c.make_frame(111,9,body=inner_reply,epoch=1);t=MemoryStream(c.prefix(outer_reply));s=c.Session(t,'nested');outer=c.Protocol(c.Direct(s),111,'outer',echo_epoch=True);inner=c.Protocol(c.Tunnel(outer,8,9),222,'inner',echo_epoch=True)
        self.assertEqual(inner.call(3)['body'],b'inner');self.assertEqual(t.writes,1);outer_wire=c.parse_exact(c.split_stream(bytes(t.sent))['frame']);self.assertEqual(c.parse_exact(outer_wire['body'])['op'],3);self.assertEqual(len(s.records),2)
    def test_explicit_prefixed_tunnel_reply(self):
        inner_reply=c.prefix(c.make_frame(222,4));t=MemoryStream(c.prefix(c.make_frame(111,9,body=inner_reply)));outer=c.Protocol(c.Direct(c.Session(t,'prefixed')),111,'outer');inner=c.Protocol(c.Tunnel(outer,8,9,reply_has_prefix=True),222,'inner');self.assertEqual(inner.call(3)['op'],4)
    def test_views_share_counter_and_buffer(self):
        t=MemoryStream(c.prefix(c.make_frame(7,2,epoch=1))+c.prefix(c.make_frame(7,2,epoch=2)));s=c.Session(t,'one-real-stream')
        for _ in range(2):c.Protocol(c.Direct(s),7,'same',echo_epoch=True).call(1)
        self.assertEqual(s.layers['same']['epoch'],2);snapshot=s.summary();snapshot['layers']['same']['epoch']=0;self.assertEqual(s.layers['same']['epoch'],2)
    def test_ranges_fail_before_send_or_counter_change(self):
        t=MemoryStream(b'');s=c.Session(t,'bad');p=c.Protocol(c.Direct(s),1,'layer')
        for op in (-1,256,True):
            with self.assertRaises(ValueError):p.call(op)
        s.layers['layer']['epoch']=0xffffffff
        with self.assertRaises(ValueError):p.call(1)
        self.assertEqual(t.writes,0);self.assertEqual(s.layers['layer']['epoch'],0xffffffff)
    def test_reply_mismatch_is_unknown_no_replay(self):
        for raw in [c.make_frame(8,2),c.make_frame(7,2,epoch=42),c.make_frame(7,3)]:
            t=MemoryStream(c.prefix(raw));s=c.Session(t,'mismatch');p=c.Protocol(c.Direct(s),7,'layer',echo_epoch=True)
            with self.assertRaises(c.ExchangeUnknown):p.call(1,expect_op=2)
            before=t.writes
            with self.assertRaises(c.ExchangeUnknown):p.call(1)
            self.assertEqual(t.writes,before);self.assertEqual(s.layers['layer']['epoch'],1)
    def test_partial_write_preserves_count_and_uncertainty(self):
        class Broken(MemoryStream):
            def write(self,data):
                if self.writes:raise TimeoutError('fixture lost ack')
                self.writes+=1;self.sent.extend(data[:3]);return 3
        t=Broken(b'');s=c.Session(t,'partial');p=c.Protocol(c.Direct(s),1,'layer')
        with self.assertRaises(c.ExchangeUnknown):p.call(1)
        self.assertEqual(s.sent_bytes,3);self.assertEqual(s.records[0]['state'],'outcome_unknown');self.assertEqual(s.state,'uncertain')
    def test_missing_response_does_not_rollback_epoch(self):
        t=MemoryStream(b'');s=c.Session(t,'lost-response');p=c.Protocol(c.Direct(s),1,'layer')
        with self.assertRaises(c.ExchangeUnknown):p.call(1)
        self.assertGreater(s.sent_bytes,0);self.assertEqual(s.layers['layer']['epoch'],1)
    def test_oversized_frame_not_allocated_or_truncated(self):
        with self.assertRaises(ValueError):c.split_stream(struct.pack('<I',10000000),max_frame=100)
        with self.assertRaises(ValueError):c.parse_exact(c.make_frame(1,2,body=b'x'*100),max_frame=32)
        raw=c.make_frame(1,2,body=b'x'*100);self.assertEqual(len(c.parse_exact(raw,max_frame=None)['body']),100)
    def test_raw_exchange_does_not_silently_fix_bytes(self):
        t=MemoryStream(c.prefix(b'R'*16));d=c.Direct(c.Session(t,'explicit-raw'));self.assertEqual(d.exchange(b'\xff'*16),b'R'*16);self.assertEqual(bytes(t.sent)[4:],b'\xff'*16)
    def test_explicit_reconciliation_performs_no_replay_or_history_rewrite(self):
        t=MemoryStream(b'');s=c.Session(t,'recoverable');p=c.Protocol(c.Direct(s),1,'layer',echo_epoch=True)
        with self.assertRaises(c.ExchangeUnknown):p.call(1)
        writes=t.writes;t.data.extend(c.prefix(c.make_frame(1,2,epoch=2)))
        s.reconcile(reason='Application dedup/status was checked outside this adapter',evidence_ref='controlled fixture status',layer_epochs={'layer':1},buffer_policy='preserve');self.assertEqual(t.writes,writes);self.assertEqual(s.records[0]['state'],'outcome_unknown');self.assertEqual(p.call(1)['op'],2)
    def test_reconciliation_cannot_silently_lose_buffer(self):
        s=c.Session(MemoryStream(b''),'buffer');s.layers['a']={'magic':1,'epoch':7};s.state='uncertain';s.buffer.extend(b'unparsed')
        with self.assertRaises(ValueError):s.reconcile(reason='',evidence_ref='ref',layer_epochs={'a':7},buffer_policy='discard')
        self.assertEqual(bytes(s.buffer),b'unparsed');s.reconcile(reason='Explicitly abandon retained bytes with source saved',evidence_ref='fixture capture',layer_epochs={'a':7},buffer_policy='discard');self.assertEqual(s.records[-1]['buffer_bytes_before'],8);self.assertFalse(s.buffer)

def elf(typ=3,segments=None):
    d=bytearray(0x4000);d[:7]=b'\x7fELF\x02\x01\x01';segments=segments or [(0x1000,0x2000),(0x2000,0x4000)];struct.pack_into('<HHIQQQIHHHHHH',d,16,typ,62,1,0,64,0,0,64,56,len(segments),64,0,0)
    for i,(off,va) in enumerate(segments):struct.pack_into('<IIQQQQQQ',d,64+i*56,1,5,off,va,0,0x1000,0x1000,0x1000)
    return bytes(d)
class ModuleViews(unittest.TestCase):
    def test_bias_from_segment_offsets_not_first_mapping(self):
        maps='702000-703000 r-xp 00001000 08:01 42 /irrelevant\n704000-705000 r--p 00002000 08:01 42 /irrelevant'
        self.assertEqual(w.module_bias(elf(),maps,(8,1),42,4096)['load_bias'],0x700000)
    def test_wrong_file_map_is_not_module(self):
        maps='100000-101000 r--p 00000000 08:01 999 /first\n702000-703000 r-xp 00001000 08:01 42 /same-name'
        self.assertEqual(w.module_bias(elf(),maps,(8,1),42,4096)['load_bias'],0x700000)
    def test_exec_elf_va_is_not_mapping_relative_offset(self):
        maps='400000-401000 r-xp 00001000 08:01 42 /fixed';self.assertEqual(w.module_bias(elf(2,[(0x1000,0x400000)]),maps,(8,1),42,4096)['load_bias'],0)
    def test_ambiguous_segments_are_not_selected(self):
        maps='702000-703000 r-xp 00001000 08:01 42 /ambiguous';r0=w.module_bias(elf(3,[(0x1000,0x2000),(0x1000,0x4000)]),maps,(8,1),42,4096);self.assertEqual(r0['state'],'ambiguous');self.assertIsNone(r0['load_bias'])
    def test_bad_format_or_unmatched_file(self):
        with self.assertRaises(ValueError):w.load_segments(b'notELF')
        self.assertEqual(w.module_bias(elf(),'',(8,1),42,4096)['state'],'unknown')
        with self.assertRaises(ValueError):w.module_bias(elf(),'bad line',(8,1),42,4096)

class Receipts(unittest.TestCase):
    def setUp(self):self.tmp=tempfile.TemporaryDirectory();self.root=Path(self.tmp.name)
    def tearDown(self):self.tmp.cleanup()
    def plan(self,values):
        runs=[]
        for i,value in enumerate(values):
            name=f'out{i}';(self.root/name).write_bytes(value);runs.append({'id':str(i),'instance_id':'instance-'+str(i),'connection_id':'connection-'+str(i),'execution_status':'completed','exit_code':0,'stdout':name})
        return {'pattern':r'TEST\{[^}]+\}','runs':runs}
    def test_different_instance_values_not_rejected(self):
        report=r.build(self.plan([b'TEST{one}',b'TEST{two}']),self.root);self.assertEqual(report['comparison'],'varying_candidate_sets');self.assertTrue(all(x['program_accept']==x['platform_accept']=='unknown' for x in report['runs']))
    def test_same_output_does_not_prove_acceptance_or_independence(self):
        report=r.build(self.plan([b'TEST{one}',b'TEST{one}']),self.root);self.assertEqual(report['comparison'],'same_candidate_sets');self.assertIsNone(report['target_accepted']);self.assertTrue(report['repeated_content_locations'])
    def test_input_echo_and_failed_exit_remain_observations(self):
        plan=self.plan([b'TEST{echo}']);(self.root/'input').write_bytes(b'TEST{echo}');plan['runs'][0].update(input='input',execution_status='failed',exit_code=3);run=r.build(plan,self.root)['runs'][0];self.assertTrue(run['candidates'][0]['occurs_in_input']);self.assertEqual(run['platform_accept'],'unknown');self.assertEqual(run['exit_code'],3)
    def test_multiple_matches_and_stderr_not_last_wins(self):
        plan=self.plan([b'TEST{one} TEST{two}']);(self.root/'err').write_bytes(b'TEST{diagnostic}');plan['runs'][0]['stderr']='err';run=r.build(plan,self.root)['runs'][0];self.assertEqual(len(run['candidates']),3);self.assertEqual(run['candidate_state'],'multiple_candidates');self.assertNotIn('value_hex',run['candidates'][0])
    def test_expected_bytes_and_acceptance_file_are_separate(self):
        plan=self.plan([b'TEST{one}']);(self.root/'expect').write_bytes(b'TEST{one}');(self.root/'claim').write_text('not a trusted platform receipt');plan['runs'][0].update(expected='expect',acceptance_evidence=['claim']);run=r.build(plan,self.root,True)['runs'][0];self.assertEqual(run['explicit_expectation_state'],'candidate_matches');self.assertEqual(run['platform_accept'],'unknown');self.assertIn('value_hex',run['candidates'][0])
    def test_empty_missing_and_command_fields_rejected(self):
        for plan in [{'pattern':'x','runs':[]},self.plan([b'no candidate'])]:
            if plan['runs']:self.assertEqual(r.build(plan,self.root)['comparison'],'insufficient_candidates')
            else:
                with self.assertRaises(ValueError):r.build(plan,self.root)
        plan=self.plan([b'TEST{one}']);plan['runs'][0]['command']='never execute'
        with self.assertRaises(ValueError):r.build(plan,self.root)
    def test_evidence_path_escape_refused(self):
        plan=self.plan([b'TEST{one}']);plan['runs'][0]['stdout']='../outside'
        with self.assertRaises((ValueError,OSError)):r.build(plan,self.root)
    def test_cli_preserves_output_and_original_bytes(self):
        plan=self.plan([b'\xffTEST{one}\0']);p=self.root/'plan.json';p.write_text(json.dumps(plan));out=self.root/'receipt.json';before=(self.root/'out0').read_bytes()
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(r.main(['--plan',str(p),'--out',str(out)]),0);saved=out.read_bytes();self.assertEqual(r.main(['--plan',str(p),'--out',str(out)]),4)
        self.assertEqual(out.read_bytes(),saved);self.assertEqual((self.root/'out0').read_bytes(),before);self.assertEqual(json.loads(saved)['runs'][0]['candidates'][0]['offset'],1)
if __name__=='__main__':unittest.main()
