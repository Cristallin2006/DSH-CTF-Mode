#!/usr/bin/env python3
"""Authored typed observations and PE bytes only; never runs a target or patched file."""
import contextlib,copy,hashlib,importlib.util,io,json,os,struct,tempfile,unittest
from pathlib import Path
ROOT=Path(os.environ.get('DSH_VM_SKILL_ROOT',Path(__file__).resolve().parents[1]))
def load(name):
    spec=importlib.util.spec_from_file_location(name,ROOT/'skills/re-dynamic/scripts'/f'{name}.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);return m
d=load('state_fingerprint_diff');p=load('patch_call')
SHA='a'*64
FIELDS=[{'name':'pc','type':'uint','bits':32,'unit':'byte_offset'},{'name':'halt','type':'uint','bits':8,'unit':'opcode'}]
def record():return {'target_sha256':SHA,'input_sha256':'b'*64,'implementation_sha256':'c'*64,'implementation_ref':'authored fixture v1','backend':'saved fixture','input_contract':'same explicit bytes','initial_state_ref':'zero-state-contract','execution_status':'completed','stop_reason':'observed_halt','observations':{'pc':{'state':'observed','value':24,'unit':'byte_offset'},'halt':{'state':'observed','value':240,'unit':'opcode'}}}
class Fingerprints(unittest.TestCase):
    def compare(self,a=None,b=None,fields=None):return d.compare_case(a or record(),b or record(),d.field_contracts(fields or FIELDS))
    def test_matching_selected_fields_is_not_equivalence(self):
        a,b=record(),record();a['observations']['unselected_mem']={'state':'observed','value':'00','unit':'hex'};b['observations']['unselected_mem']={'state':'observed','value':'ff','unit':'hex'};r=self.compare(a,b);self.assertEqual(r['comparison'],'all_selected_values_equal');self.assertEqual(r['comparability'],'comparable_under_declared_contract');self.assertIsNone(r['target_accepted'])
    def test_first_field_is_not_first_execution_step(self):
        b=record();b['observations']['pc']['value']=32;b['observations']['halt']['value']=241;r=self.compare(b=b);self.assertEqual(r['first_unequal_selected_field'],'pc');self.assertIsNone(r['first_divergent_execution_step']);self.assertIsNone(r['root_cause'])
    def test_both_missing_does_not_compare_as_zero_or_equal(self):
        a,b=record(),record();a['observations'].pop('halt');b['observations'].pop('halt');r=self.compare(a,b);self.assertEqual(r['comparison'],'incomplete');self.assertEqual(r['comparability'],'partial');self.assertIsNone(r['fields'][1]['values_equal'])
    def test_derived_halt_is_not_independent_observation(self):
        b=record();b['observations']['halt']['state']='derived';r=self.compare(b=b);self.assertEqual(r['comparability'],'partial');self.assertEqual(r['fields'][1]['comparison'],'derived_equal')
    def test_input_target_and_initial_state_changes_are_not_comparable(self):
        for key,val in [('input_sha256','d'*64),('target_sha256','e'*64),('initial_state_ref','other-state'),('input_contract','line-normalized input')]:
            b=record();b[key]=val;self.assertEqual(self.compare(b=b)['comparability'],'not_comparable')
    def test_width_and_unit_errors_are_not_masked(self):
        b=record();b['observations']['halt']['value']=496;r=self.compare(b=b);self.assertEqual(r['fields'][1]['right']['state'],'invalid');self.assertIsNone(r['fields'][1]['values_equal'])
        b=record();b['observations']['pc']['unit']='instruction_index';self.assertEqual(self.compare(b=b)['comparability'],'partial')
    def test_explicit_hex_and_signed_parse(self):
        fields=[{'name':'n','type':'sint','bits':8,'unit':'signed-value','parse':'decimal'}];a,b=record(),record();a['observations']['n']=b['observations']['n']={'state':'observed','value':'-1','unit':'signed-value'};self.assertEqual(self.compare(a,b,fields)['fields'][0]['left']['value'],-1)
        fields[0].update(type='uint',parse='hex');a['observations']['n']=b['observations']['n']={'state':'observed','value':'0xff','unit':'signed-value'};self.assertEqual(self.compare(a,b,fields)['fields'][0]['left']['value'],255)
    def test_bool_is_not_silently_integer_and_bytes_keep_crlf(self):
        b=record();b['observations']['halt']['value']=True;self.assertEqual(self.compare(b=b)['fields'][1]['right']['state'],'invalid')
        fields=[{'name':'raw','type':'bytes','unit':'raw-output','parse':'hex'}];a,b=record(),record();a['observations']['raw']={'state':'observed','value':'410d0a','unit':'raw-output'};b['observations']['raw']={'state':'observed','value':'410a','unit':'raw-output'};self.assertFalse(self.compare(a,b,fields)['fields'][0]['values_equal'])
    def test_host_failure_and_business_reject_are_separate(self):
        a,b=record(),record();a['stop_reason']=b['stop_reason']='rejected_opcode';a['observations']['halt']['value']=b['observations']['halt']['value']=241;self.assertEqual(self.compare(a,b)['comparability'],'comparable_under_declared_contract')
        b['execution_status']='interrupted';self.assertEqual(self.compare(a,b)['comparability'],'partial')
    def test_unknown_backend_and_missing_identity_not_called_model_error(self):
        b=record();b.pop('implementation_sha256');r=self.compare(b=b);self.assertEqual(r['comparability'],'not_comparable');self.assertIsNone(r['root_cause'])
    def test_empty_duplicate_fields_rejected(self):
        for fields in ([],[FIELDS[0],FIELDS[0]], [{'name':'x','type':'uint','bits':8}]):
            with self.assertRaises(ValueError):d.field_contracts(fields)
    def test_cli_saved_sources_and_no_overwrite(self):
        with tempfile.TemporaryDirectory() as td:
            root=Path(td);(root/'a.json').write_text(json.dumps(record()));(root/'b.json').write_text(json.dumps(record()));plan={'fields':FIELDS,'cases':[{'id':'one','left':'a.json','right':'b.json'}]};(root/'plan').write_text(json.dumps(plan));out=root/'out'
            with contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(d.main(['--plan',str(root/'plan'),'--out',str(out)]),0);before=out.read_bytes();self.assertEqual(d.main(['--plan',str(root/'plan'),'--out',str(out)]),4)
            self.assertEqual(out.read_bytes(),before);r=json.loads(before);self.assertFalse(r['model_equivalence_proven']);self.assertEqual(r['cases'][0]['sources']['left']['sha256'],hashlib.sha256((root/'a.json').read_bytes()).hexdigest())

def pe_fixture(site=0x1010,target=0x3000):
    data=bytearray(0x2200);data[:2]=b'MZ';struct.pack_into('<I',data,60,0x80);data[0x80:0x84]=b'PE\0\0';struct.pack_into('<HH',data,0x84,0x8664,2);struct.pack_into('<HH',data,0x94,240,0x22);opt=0x98;struct.pack_into('<H',data,opt,0x20b);struct.pack_into('<Q',data,opt+24,0x140000000);struct.pack_into('<II',data,opt+32,0x1000,0x200);struct.pack_into('<I',data,opt+60,0x200);struct.pack_into('<I',data,opt+108,16)
    base=site//4096*4096;second=target//4096*4096
    for i,(va,off) in enumerate([(base,0x200),(second,0x1200)]):
        section=0x188+i*40;data[section:section+8]=b'.text\0\0\0';struct.pack_into('<IIII',data,section+8,0x1000,va,0x1000,off);struct.pack_into('<I',data,section+36,0x60000020)
    offset=0x200+site-base;old=base+0x80;data[offset:offset+5]=b'\xe8'+struct.pack('<i',old-(site+5));return bytes(data),site,old,target,offset
class CallCopy(unittest.TestCase):
    def setUp(self):self.tmp=tempfile.TemporaryDirectory();self.root=Path(self.tmp.name)
    def tearDown(self):self.tmp.cleanup()
    def boundary(self,data,site,offset):
        (self.root/'disasm').write_text('Authored fixture disassembly: explicit reviewed instruction boundary');record={'sample_sha256':p.sha(data),'instruction_rva':site,'instruction_length':5,'instruction_hex':data[offset:offset+5].hex(),'basis_kind':'caller_reviewed_disassembly','evidence_file':'disasm','evidence_sha256':p.sha((self.root/'disasm').read_bytes()),'locator':'fixture instruction'};(self.root/'boundary').write_text(json.dumps(record));return self.root/'boundary'
    def planned(self,fixture=None,**kw):
        data,site,old,target,offset=fixture or pe_fixture();args={'at':site,'expect':old,'to':target,'domain':'rva','source_sha256':p.sha(data),'boundary':self.boundary(data,site,offset)};args.update(kw);return data,p.plan_patch(data,**args)
    def test_only_declared_bytes_change(self):
        original,(new,r)=self.planned();self.assertEqual(len(original),len(new));self.assertTrue(r['copy_allowed']);self.assertTrue(set(r['changed_offsets']).issubset(set(range(r['file_offset'],r['file_offset']+5))));self.assertEqual(struct.unpack_from('<i',new,r['file_offset']+1)[0]+r['instruction_rva']+5,r['new_target_rva']);self.assertFalse(r['execution'])
    def test_va_and_file_offset_are_explicit_not_guessed(self):
        data,site,old,target,off=pe_fixture();boundary=self.boundary(data,site,off)
        for domain,at,expect,to in [('va',0x140000000+site,0x140000000+old,0x140000000+target),('file-offset',off,0x200+old-0x1000,0x1200)]:self.assertEqual(p.plan_patch(data,at=at,expect=expect,to=to,domain=domain,boundary=boundary)[1]['instruction_rva'],site)
        with self.assertRaises(ValueError):p.plan_patch(data,at=site,expect=old,to=target,domain='va')
    def test_signed_rel32_endpoints(self):
        for site,target,expected in [(0x1010,0x80001014,0x7fffffff),(0x80000ffb,0x1000,-0x80000000)]:
            _,(_,r)=self.planned(pe_fixture(site,target));self.assertEqual(r['signed_displacement'],expected)
    def test_out_of_range_is_not_wrapped(self):
        for site,target in [(0x1010,0x80001015),(0x80000ffb,0xfff)]:
            with self.assertRaises(ValueError):self.planned(pe_fixture(site,target))
    def test_old_callee_and_source_hash_must_match(self):
        for kw in [{'expect':0x1090},{'source_sha256':'0'*64}]:
            with self.assertRaises(ValueError):self.planned(**kw)
    def test_raw_e8_is_not_boundary_proof(self):
        _,(_,r)=self.planned(boundary=None);self.assertFalse(r['copy_allowed']);self.assertEqual(r['boundary']['state'],'unconfirmed')
    def test_nonexec_virtual_tail_and_cross_range_refused(self):
        data,site,old,target,off=pe_fixture();bad=bytearray(data);struct.pack_into('<I',bad,0x188+36,0x40000040)
        with self.assertRaises(ValueError):p.plan_patch(bytes(bad),at=site,expect=old,to=target,domain='rva')
        with self.assertRaises(ValueError):p.plan_patch(data,at=0x1ffd,expect=old,to=target,domain='rva')
        with self.assertRaises(ValueError):p.plan_patch(data,at=site,expect=old,to=0x4001,domain='rva')
    def test_overlapping_sections_refused(self):
        data,site,old,target,off=pe_fixture();bad=bytearray(data);struct.pack_into('<I',bad,0x188+40+12,0x1000)
        with self.assertRaises(ValueError):p.plan_patch(bytes(bad),at=site,expect=old,to=target,domain='rva')
    def test_wrong_arch_or_opcode_refused(self):
        data,site,old,target,off=pe_fixture()
        for change,value,size in [(0x84,0xaa64,2),(off,0x90,1)]:
            bad=bytearray(data);bad[change:change+size]=value.to_bytes(size,'little')
            with self.assertRaises(ValueError):p.plan_patch(bytes(bad),at=site,expect=old,to=target,domain='rva')
    def test_boundary_source_or_artifact_drift_refused(self):
        data,site,old,target,off=pe_fixture();boundary=self.boundary(data,site,off);(self.root/'disasm').write_text('changed')
        with self.assertRaises(ValueError):p.plan_patch(data,at=site,expect=old,to=target,domain='rva',boundary=boundary)
    def test_cli_defaults_preview_without_copy(self):
        data,site,old,target,off=pe_fixture();source=self.root/'sample.exe';source.write_bytes(data)
        with contextlib.redirect_stdout(io.StringIO()) as output:self.assertEqual(p.main([str(source),'--at',hex(site),'--expect',hex(old),'--to',hex(target),'--addr-is','rva']),0)
        self.assertEqual(source.read_bytes(),data);self.assertEqual(len(list(self.root.iterdir())),1);self.assertEqual(json.loads(output.getvalue())['state'],'preview')
    def test_cli_copy_manifest_and_original_preserved(self):
        data,site,old,target,off=pe_fixture();source=self.root/'sample.exe';source.write_bytes(data);boundary=self.boundary(data,site,off);out=self.root/'copy.exe';report=self.root/'report.json';args=[str(source),'--at',hex(site),'--expect',hex(old),'--to',hex(target),'--addr-is','rva','--source-sha256',p.sha(data),'--boundary-record',str(boundary),'--out',str(out),'--report',str(report)]
        with contextlib.redirect_stdout(io.StringIO()):self.assertEqual(p.main(args),0);self.assertEqual(p.main(args),4)
        r=json.loads(report.read_text());self.assertEqual(r['state'],'copy_written');self.assertTrue(r['ok']);self.assertEqual(source.read_bytes(),data);self.assertEqual(r['actual_output_sha256'],p.sha(out.read_bytes()))
    def test_missing_boundary_or_existing_output_does_not_overwrite(self):
        data,site,old,target,off=pe_fixture();source=self.root/'sample.exe';source.write_bytes(data);out=self.root/'existing';out.write_bytes(b'keep');report=self.root/'report';args=[str(source),'--at',hex(site),'--expect',hex(old),'--to',hex(target),'--addr-is','rva','--source-sha256',p.sha(data),'--out',str(out),'--report',str(report)]
        with contextlib.redirect_stdout(io.StringIO()):self.assertEqual(p.main(args),4)
        self.assertEqual(out.read_bytes(),b'keep');self.assertFalse(report.exists())

class InversionBoundaries(unittest.TestCase):
    def test_self_alias_update_is_not_bijective(self):self.assertEqual([(x+x)&255 for x in (0,128)],[0,0])
    def test_inverse_order_for_local_bijective_updates(self):
        def forward(a):
            a=list(a)
            for i in range(len(a)):a[i]=(a[i]+a[(i+1)%len(a)])&255
            return a
        def inverse(a):
            a=list(a)
            for i in reversed(range(len(a))):a[i]=(a[i]-a[(i+1)%len(a)])&255
            return a
        for value in (list(range(5)),[255,0,128,3,9],[0]*5):self.assertEqual(inverse(forward(value)),value)
    def test_low_byte_rotation_preserves_high_bits(self):
        value=0x12345680;rot_low=(value&0xffffff00)|(((value&255)<<1 | (value&255)>>7)&255);rot_full=((value<<1)|(value>>31))&0xffffffff;self.assertEqual(rot_low,0x12345601);self.assertNotEqual(rot_low,rot_full)
if __name__=='__main__':unittest.main()
