#!/usr/bin/env python3
"""Preview or create an explicit PE64 E8-rel32 experiment copy. Never executes it."""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import struct

class PatchError(ValueError):pass
def sha(body):return hashlib.sha256(body).hexdigest()
def write_report(fd,value):
    payload=memoryview((json.dumps(value,indent=2)+'\n').encode('utf-8'));os.lseek(fd,0,os.SEEK_SET);os.ftruncate(fd,0)
    while payload:
        n=os.write(fd,payload)
        if n<=0:raise OSError('Incomplete report write')
        payload=payload[n:]
    os.fsync(fd)
def parser():
    file=Path(__file__).resolve().parents[2]/'pwn-exploit/scripts/pe_triage.py'
    if not file.is_file():raise PatchError('Installed sibling pwn-exploit PE parser required; no automatic fallback/install')
    spec=importlib.util.spec_from_file_location('_patch_pe',file);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);return m.PE
def exec_rva(pe,address,size):
    if not isinstance(address,int) or isinstance(address,bool) or address<0:raise PatchError('Invalid address')
    off=pe.rva(address,size)
    matches=[s for s in pe.sections if s['characteristics']&0x20000000 and s['rva']<=address and address+size<=s['rva']+min(s['raw_size'],s['virtual_size'] or s['raw_size']) and s['raw_offset']+address-s['rva']==off]
    if len(matches)!=1:raise PatchError('Need one executable, file-backed section covering complete range')
    return off
def to_rva(pe,address,domain,size):
    if isinstance(address,bool) or not isinstance(address,int) or address<0:raise PatchError('Unsigned address required')
    if domain=='rva':rva=address
    elif domain=='va':
        if address<pe.image_base:raise PatchError('VA below preferred ImageBase; do not guess RVA')
        rva=address-pe.image_base
    elif domain=='file-offset':
        matches=[s['rva']+address-s['raw_offset'] for s in pe.sections if s['raw_offset']<=address and address+size<=s['raw_offset']+s['raw_size']]
        if len(matches)!=1:raise PatchError('File offset has no unique section mapping')
        rva=matches[0]
    else:raise PatchError('Explicit rva/va/file-offset address domain required')
    return rva,exec_rva(pe,rva,size)
def boundary_record(path,digest,rva,original):
    if path is None:return {'state':'unconfirmed','copy_allowed':False}
    path=Path(path).resolve(strict=True);record=json.loads(path.read_text(encoding='utf-8'))
    if not isinstance(record,dict) or type(record.get('instruction_rva')) is not int or type(record.get('instruction_length')) is not int:raise PatchError('Typed instruction boundary record required')
    if record.get('sample_sha256')!=digest or record.get('instruction_rva')!=rva or record.get('instruction_length')!=5 or bytes.fromhex(record.get('instruction_hex',''))!=original:raise PatchError('Boundary record source/address/bytes do not match')
    if record.get('basis_kind')!='caller_reviewed_disassembly' or not isinstance(record.get('locator'),str) or not record['locator'].strip():raise PatchError('Explicit caller-reviewed disassembly locator required')
    ref=record.get('evidence_file')
    if not isinstance(ref,str):raise PatchError('Boundary evidence_file required')
    evidence=(path.parent/ref).resolve(strict=True)
    if not evidence.is_relative_to(path.parent) or not evidence.is_file():raise PatchError('Boundary evidence must stay in its record directory')
    evidence_sha=sha(evidence.read_bytes())
    if evidence_sha!=record.get('evidence_sha256'):raise PatchError('Boundary evidence file changed')
    return {'state':'caller_attested_and_byte_checked','copy_allowed':True,'record_sha256':sha(path.read_bytes()),'evidence_sha256':evidence_sha,'locator':record['locator'],'scope':'Provenance and byte consistency only; tool does not independently prove code boundaries or authorization'}
def plan_patch(data,*,at,expect,to,domain,source_sha256=None,boundary=None):
    pe=parser()(data)
    if pe.bits!=64 or pe.machine!=0x8664:raise PatchError('Only PE32+ AMD64 supported')
    digest=sha(data)
    if source_sha256 is not None and source_sha256!=digest:raise PatchError('Source SHA-256 mismatch')
    site,off=to_rva(pe,at,domain,5);old_target,_=to_rva(pe,expect,domain,1);new_target,_=to_rva(pe,to,domain,1);old=data[off:off+5]
    if old[0]!=0xe8:raise PatchError('Expected E8 rel32 bytes; indirect calls/other encodings unsupported')
    decoded_target=site+5+struct.unpack('<i',old[1:])[0]
    if decoded_target!=old_target:raise PatchError('Decoded original callee differs from --expect')
    disp=new_target-(site+5)
    if not -(1<<31)<=disp<(1<<31):raise PatchError('New displacement exceeds signed rel32; no truncation')
    updated=b'\xe8'+struct.pack('<i',disp);new=data[:off]+updated+data[off+5:];b=boundary_record(boundary,digest,site,old)
    result={'schema':'pe-call-copy-v1','state':'preview','execution':False,'source_sha256':digest,'source_hash_pinned':source_sha256 is not None,'output_sha256':sha(new),'address_domain':domain,'image_base':pe.image_base,'instruction_rva':site,'file_offset':off,'expected_callee_rva':old_target,'new_target_rva':new_target,'before_hex':old.hex(),'after_hex':updated.hex(),'signed_displacement':disp,'changed_offsets':[i for i,(a,z) in enumerate(zip(data,new)) if a!=z],'boundary':b,'copy_allowed':b['copy_allowed'] and source_sha256 is not None,'target_accepted':None,'effects':['file checksum/signature may no longer be valid','new callee ABI, state and runtime policies not verified'],'instruction_range':[off,off+5]}
    return new,result
def main(argv=None):
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('binary',nargs='?');p.add_argument('--describe',action='store_true');p.add_argument('--at',type=lambda s:int(s,0));p.add_argument('--expect',type=lambda s:int(s,0));p.add_argument('--to',type=lambda s:int(s,0));p.add_argument('--addr-is',choices=['rva','va','file-offset']);p.add_argument('--source-sha256');p.add_argument('--boundary-record');p.add_argument('--out');p.add_argument('--report');a=p.parse_args(argv)
    report_fd=None;written=False;result=None
    try:
        if a.describe:print(json.dumps({'tool':'patch-call','format':'PE32+ AMD64 E8 rel32','default':'preview only','execution':False,'copy_requirements':['pinned source hash','caller-reviewed byte-boundary record','new --out and --report paths'],'no_restore_in_place':True}));return 0
        if not a.binary or any(v is None for v in (a.at,a.expect,a.to,a.addr_is)):raise PatchError('binary, --at/--expect/--to and explicit --addr-is required')
        source=Path(a.binary).resolve(strict=True);data=source.read_bytes();new,result=plan_patch(data,at=a.at,expect=a.expect,to=a.to,domain=a.addr_is,source_sha256=a.source_sha256,boundary=a.boundary_record)
        if a.out:
            if not a.report or not result['copy_allowed']:raise PatchError('Copy needs a new --report, pinned hash and matching boundary evidence; preview remains available')
            if Path(a.out).resolve()==source or Path(a.report).resolve() in (source,Path(a.out).resolve()):raise PatchError('Source/copy/report must be distinct')
        if a.report:
            report_fd=os.open(a.report,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
            write_report(report_fd,result)
        if a.out:
            fd=os.open(a.out,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
            with os.fdopen(fd,'wb') as f:f.write(new);f.flush();os.fsync(f.fileno())
            written=True;result.update(state='copy_written',output=str(Path(a.out).resolve()),source_sha256_after=sha(source.read_bytes()),actual_output_sha256=sha(Path(a.out).read_bytes()))
            result['ok']=result['source_sha256_after']==result['source_sha256'] and result['actual_output_sha256']==result['output_sha256']
        else:result['ok']=True
        if report_fd is not None:
            write_report(report_fd,result)
            print(json.dumps({'ok':result['ok'],'state':result['state'],'report':str(Path(a.report).resolve()),'execution':False,'target_accepted':None}))
        else:print(json.dumps(result,indent=2))
        return 0 if result['ok'] else 3
    except (OSError,ValueError,KeyError,TypeError,struct.error) as e:
        failure={'ok':False,'state':'copy_written_but_incomplete' if written else 'no_copy_confirmed','error':str(e),'execution':False,'target_accepted':None}
        if report_fd is not None:
            write_report(report_fd,{'preview':result,'failure':failure})
        print(json.dumps(failure));return 4
    finally:
        if report_fd is not None:os.close(report_fd)
if __name__=='__main__':raise SystemExit(main())
