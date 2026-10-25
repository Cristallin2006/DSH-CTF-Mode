#!/usr/bin/env python3
"""Authored bytes, typed fake I/O and owned local descriptors. No challenge/model calls."""
import contextlib,hashlib,importlib.util,io,json,os,random,socket,struct,tempfile,unittest
from pathlib import Path
ROOT=Path(os.environ.get('DSH_RUNTIME_SKILL_ROOT',Path(__file__).resolve().parents[1]))
def load(name):
    spec=importlib.util.spec_from_file_location(name,ROOT/'skills/pwn-exploit/scripts'/f'{name}.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);return m
s=load('stream_io');r=load('bundled_runtime');relay=load('relay_codec')

class Fake:
    deadline_io=True
    def __init__(self,chunks=(),writes=None):self.chunks=list(chunks);self.writes=list(writes) if writes is not None else None;self.sent=bytearray();self.deadlines=[]
    def read(self,n,*,deadline=None):
        self.deadlines.append(deadline);v=self.chunks.pop(0) if self.chunks else b''
        if isinstance(v,Exception):raise v
        return v
    def write(self,data,*,deadline=None):
        self.deadlines.append(deadline);v=self.writes.pop(0) if self.writes else len(data)
        if isinstance(v,Exception):raise v
        if type(v) is int and 0<v<=len(data):self.sent.extend(data[:v])
        return v

class Streams(unittest.TestCase):
    def test_fragmentation_and_sticky_frames(self):
        fmt=s.FrameFormat(2);wire=fmt.encode(b'A'*17)+fmt.encode(b'B'*9)
        for seed in range(30):
            rand=random.Random(seed);chunks=[];i=0
            while i<len(wire):n=rand.randint(1,12);chunks.append(wire[i:i+n]);i+=n
            st=s.Stream(Fake(chunks));self.assertEqual(st.read_frame(fmt)['body'],b'A'*17);self.assertEqual(st.read_frame(fmt)['body'],b'B'*9);self.assertFalse(st.buffer)
    def test_explicit_layouts(self):
        for width in (2,4):
            for endian in ('big','little'):
                for first in (True,False):
                    for convention in ('body','payload','frame'):
                        fmt=s.FrameFormat(width,endian,opcode=True,opcode_first=first,length_includes=convention);wire=fmt.encode(b'hello',9);out=s.Stream(Fake([wire])).read_frame(fmt);self.assertEqual((out['body'],out['opcode'],out['wire']),(b'hello',9,wire))
    def test_short_body_is_failure_and_all_bytes_retained(self):
        st=s.Stream(Fake([b'\0\4AB']))
        with self.assertRaises(s.StreamFailure) as cm:st.read_frame(s.FrameFormat(2))
        self.assertEqual(cm.exception.kind,'eof');self.assertEqual(cm.exception.partial,b'\0\4AB');self.assertEqual(st.buffer,b'\0\4AB')
    def test_short_header_eof_not_timeout(self):
        st=s.Stream(Fake([b'\0']))
        with self.assertRaises(s.StreamFailure) as cm:st.read_frame(s.FrameFormat(2))
        self.assertEqual(cm.exception.kind,'eof');self.assertEqual(cm.exception.partial,b'\0')
    def test_timeout_resume_preserves_header_and_partial(self):
        st=s.Stream(Fake([b'\0\4AB',TimeoutError(),b'CD']))
        with self.assertRaises(s.StreamFailure) as cm:st.read_frame(s.FrameFormat(2))
        self.assertEqual(cm.exception.kind,'timeout');self.assertFalse(st.eof);self.assertEqual(st.read_frame(s.FrameFormat(2))['body'],b'ABCD')
    def test_all_read_apis_consume_one_buffer(self):
        st=s.Stream(Fake([b'abcdef']));self.assertEqual(st.read_exact(1),b'a');self.assertEqual(st.read_some(2),b'bc');self.assertEqual(st.read_exact(3),b'def');self.assertEqual(st.read_exact(0),b'')
    def test_zero_body_and_explicit_budget(self):
        fmt=s.FrameFormat(2);st=s.Stream(Fake([fmt.encode(b'')+fmt.encode(b'x'*50)]));self.assertEqual(st.read_frame(fmt)['body'],b'')
        with self.assertRaises(s.StreamFailure) as cm:st.read_frame(fmt,max_body=10)
        self.assertEqual(cm.exception.kind,'format');self.assertEqual(st.read_frame(fmt,max_body=None)['body'],b'x'*50)
    def test_invalid_included_length_retained(self):
        st=s.Stream(Fake([b'\0\0']))
        with self.assertRaises(s.StreamFailure):st.read_frame(s.FrameFormat(2,length_includes='frame'))
        self.assertEqual(st.buffer,b'\0\0')
    def test_one_absolute_deadline_across_exchange(self):
        t=Fake([b'\0',b'\2',b'ab'],[1,1]);st=s.Stream(t,clock=lambda:5);d=st.deadline_after(4);out=st.exchange(b'xx',s.FrameFormat(2),deadline=d);self.assertEqual(out['body'],b'ab');self.assertEqual(set(t.deadlines),{9})
    def test_deadline_not_restarted_after_progress(self):
        now=[0]
        class Delayed(Fake):
            def read(self,n,*,deadline=None):now[0]+=2;return super().read(n,deadline=deadline)
        st=s.Stream(Delayed([b'\0\4',b'A',b'BCD']),clock=lambda:now[0])
        with self.assertRaises(s.StreamFailure) as cm:st.read_frame(s.FrameFormat(2),deadline=3)
        self.assertEqual(cm.exception.kind,'timeout');self.assertEqual(st.buffer,b'\0\4A')
    def test_partial_write_and_unknown_callback_progress(self):
        st=s.Stream(Fake(writes=[2,TimeoutError()]))
        with self.assertRaises(s.StreamFailure) as cm:st.write_all(b'abcdef')
        self.assertEqual(cm.exception.known_written,2);self.assertTrue(cm.exception.unconfirmed_write);self.assertEqual(st.sent_bytes,2)
    def test_expired_before_write_does_not_call_transport(self):
        t=Fake();st=s.Stream(t,clock=lambda:2)
        with self.assertRaises(s.StreamFailure) as cm:st.write_all(b'a',deadline=1)
        self.assertFalse(t.deadlines);self.assertFalse(cm.exception.unconfirmed_write)
    def test_bad_read_and_write_types_do_not_become_eof(self):
        for val in (None,'bad',17):
            with self.assertRaises(s.StreamFailure) as cm:s.Stream(Fake([val])).read_exact(1)
            self.assertEqual(cm.exception.kind,'error')
        for val in (0,-1,True,None):
            class Bad(Fake):
                def write(self,data,*,deadline=None):return val
            with self.assertRaises(s.StreamFailure):s.Stream(Bad()).write_all(b'x')
    def test_legacy_refuses_deadline_without_io(self):
        class Old:
            calls=0
            def read(self,n):self.calls+=1;return b'x'
        old=Old();st=s.Stream(s.LegacyTransport(old))
        with self.assertRaises(s.StreamFailure):st.read_exact(1,deadline=st.deadline_after(1))
        self.assertEqual(old.calls,0)
    def test_socket_half_close_allows_reverse_write(self):
        a,b=socket.socketpair()
        try:
            a.setblocking(False);st=s.Stream(s.SocketTransport(a));b.sendall(b'\0\2ok');b.shutdown(socket.SHUT_WR);self.assertEqual(st.read_frame(s.FrameFormat(2),deadline=s.deadline_after(1))['body'],b'ok')
            with self.assertRaises(s.StreamFailure) as cm:st.read_exact(1,deadline=s.deadline_after(1))
            self.assertEqual(cm.exception.kind,'eof');st.write_all(b'ack',deadline=s.deadline_after(1));self.assertEqual(b.recv(3),b'ack')
        finally:a.close();b.close()
    def test_legacy_empty_is_unknown_without_false_eof_latch(self):
        class Old:
            chunks=[b'',b'ok']
            def read(self,n):return self.chunks.pop(0)
        st=s.Stream(s.LegacyTransport(Old()))
        with self.assertRaises(s.StreamFailure) as cm:st.read_exact(2)
        self.assertEqual(cm.exception.kind,'legacy_empty_unknown');self.assertFalse(st.eof);self.assertEqual(st.read_exact(2),b'ok')
    def test_relay_retains_old_api_and_shared_buffer(self):
        reply=relay.prefix(relay.make_frame(7,2,body=b'ok'));t=Fake([reply]);session=relay.Session(t,'owned-fake');out=relay.Protocol(relay.Direct(session,timeout=1),7,'one').call(1);self.assertEqual(out['body'],b'ok');self.assertIs(session.stream.buffer,session.buffer);self.assertEqual(session.sent_bytes,len(t.sent))
    def test_relay_short_body_marks_unknown_once(self):
        t=Fake([b'\x14\0\0\0AB']);session=relay.Session(t,'short');p=relay.Protocol(relay.Direct(session),7,'one')
        with self.assertRaises(relay.ExchangeUnknown):p.call(1)
        written=len(t.sent)
        with self.assertRaises(relay.ExchangeUnknown):p.call(1)
        self.assertEqual(len(t.sent),written);self.assertEqual(session.buffer,b'\x14\0\0\0AB')


def elf(*,needed=(),soname=None,machine=62,interp=None,rpath=None,runpath=None):
    data=bytearray(2048);strings=bytearray(b'\0');tags=[]
    for tag,value in [(1,n) for n in needed]+[(14,soname),(15,rpath),(29,runpath)]:
        if value is not None:tags.append((tag,len(strings)));strings.extend(value.encode()+b'\0')
    dynamic=[(5,0x1400),(10,len(strings)),*tags,(0,0)];data[0x400:0x400+len(strings)]=strings
    for i,pair in enumerate(dynamic):struct.pack_into('<qQ',data,0x200+i*16,*pair)
    ph=[(1,5,0,0x1000,0,2048,2304,0x1000),(2,6,0x200,0x1200,0,len(dynamic)*16,len(dynamic)*16,8)]
    if interp:
        body=interp.encode()+b'\0';data[0x600:0x600+len(body)]=body;ph.append((3,4,0x600,0x1600,0,len(body),len(body),1))
    ident=b'\x7fELF\x02\x01\x01'+b'\0'*9
    struct.pack_into('<16sHHIQQQIHHHHHH',data,0,ident,3,machine,1,0x1000,64,0,0,64,56,len(ph),0,0,0)
    for i,row in enumerate(ph):struct.pack_into('<IIQQQQQQ',data,64+i*56,*row)
    return bytes(data)

class Runtime(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup);self.root=Path(self.tmp.name);(self.root/'lib').mkdir();(self.root/'app with spaces').write_bytes(elf(needed=['liba.so'],interp='/not-used/ld'));(self.root/'lib/loader').write_bytes(elf(soname='loader.so'));(self.root/'lib/liba.so').write_bytes(elf(soname='liba.so'))
        self.plan={'schema':'bundled-runtime-plan-v1','binary':'app with spaces','loader':'lib/loader','loader_kind':'glibc','library_dirs':['lib'],'arguments':['a b','$(not a command)'],'environment':{'LANG':'C'}}
    def build(self):return r.build(self.plan,self.root)
    def test_static_plan_exact_argv_and_environment(self):
        out=self.build();self.assertEqual(out['launch_plan']['argv'][-2:],['a b','$(not a command)']);self.assertFalse(out['executed']);self.assertEqual(out['candidate_coverage'],'complete_in_explicit_inventory');self.assertIsNone(out['target_accepted']);self.assertEqual(out['launch_plan']['environment'],{'LANG':'C'});self.assertFalse(out['launch_plan']['inherit_environment']);self.assertEqual(out['target']['elf']['interp'],'/not-used/ld')
    def test_machine_mismatch_and_missing_loader_no_fallback(self):
        (self.root/'lib/loader').write_bytes(elf(machine=183))
        with self.assertRaisesRegex(ValueError,'machine differ'):self.build()
        self.plan['loader']='missing'
        with self.assertRaises(OSError):self.build()
    def test_transitive_dependency_and_cycle(self):
        (self.root/'lib/liba.so').write_bytes(elf(soname='liba.so',needed=['libb.so']));out=self.build();self.assertEqual(out['dependency_edges'][-1]['state'],'missing_in_inventory')
        (self.root/'lib/libb.so').write_bytes(elf(soname='libb.so',needed=['liba.so']));out=self.build();self.assertEqual(len(out['dependency_edges']),3);self.assertEqual(out['candidate_coverage'],'complete_in_explicit_inventory')
    def test_duplicate_soname_keeps_all_candidates(self):
        (self.root/'lib/other-file').write_bytes(elf(soname='liba.so'));out=self.build();self.assertEqual(out['dependency_edges'][0]['state'],'ambiguous_or_incompatible');self.assertEqual(len(out['dependency_edges'][0]['candidates']),2)
    def test_runpath_not_promoted_to_actual_resolution(self):
        (self.root/'app with spaces').write_bytes(elf(needed=['absent.so'],rpath='$ORIGIN/old',runpath='$ORIGIN/new'));out=self.build();self.assertEqual(out['target']['elf']['runpath'],['$ORIGIN/new']);self.assertIsNone(out['actual_loaded_libraries']);self.assertEqual(out['candidate_coverage'],'incomplete_or_ambiguous')
    def test_hash_pin_detects_drift(self):
        self.plan['expected_hashes']={'lib/liba.so':hashlib.sha256((self.root/'lib/liba.so').read_bytes()).hexdigest()};self.assertTrue(self.build())
        (self.root/'lib/liba.so').write_bytes(elf(soname='liba.so',needed=['changed.so']))
        with self.assertRaisesRegex(ValueError,'SHA-256 mismatch'):self.build()
    def test_unknown_execution_fields_rejected(self):
        self.plan['run']=True
        with self.assertRaises(ValueError):self.build()
    def test_malformed_and_unsupported_elf(self):
        for body in (b'bad',b'\x7fELF'+b'\0'*60,elf()[:100]):
            with self.assertRaises(ValueError):r.ELF(body)
        body=bytearray(elf());struct.pack_into('<Q',body,64+8,999999)
        with self.assertRaises(ValueError):r.ELF(bytes(body))
    def test_ambiguous_va_string_mapping_rejected(self):
        body=bytearray(elf(needed=['x']));struct.pack_into('<IIQQQQQQ',body,64+56,1,4,0,0x1000,0,2048,2048,8)
        # Both PT_LOAD mappings are candidates; keep a dynamic segment at the third entry.
        struct.pack_into('<H',body,56,3);struct.pack_into('<IIQQQQQQ',body,64+112,2,4,0x200,0x1200,0,64,64,8)
        with self.assertRaisesRegex(ValueError,'Non-unique'):r.ELF(bytes(body))
    def test_library_path_with_slash_is_not_guessed(self):
        (self.root/'app with spaces').write_bytes(elf(needed=['elsewhere/liba.so']));self.assertEqual(self.build()['dependency_edges'][0]['state'],'needs_loader_path_resolution')
    def test_cli_exclusive_output_and_unsupported_report(self):
        plan=self.root/'plan.json';plan.write_text(json.dumps(self.plan));out=self.root/'result.json'
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(r.main(['--plan',str(plan),'--out',str(out)]),0);original=out.read_bytes();self.assertEqual(r.main(['--plan',str(plan),'--out',str(out)]),4)
        self.assertEqual(out.read_bytes(),original)
    def test_explicit_root_refuses_escape(self):
        self.plan['binary']='../outside'
        with self.assertRaises(OSError):self.build()

if __name__=='__main__':unittest.main(verbosity=2)
