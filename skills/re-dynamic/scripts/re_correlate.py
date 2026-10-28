#!/usr/bin/env python3
"""Read-only saved-observation/static-byte association, not live identity proof."""
import argparse
import base64
import json
from pathlib import Path
import re
import sqlite3
import sys
from _re_evidence import canonical,sha,read_file,read_json,map_address,publish


def evidence(path,maximum):
    body=read_file(path,maximum)
    return {'ref':str(Path(path).absolute()),'sha256':sha(body),'bytes':len(body),'authority':'saved local evidence; observation interpretation remains caller-declared'}


def native_request(image,context,coordinate,value,source,max_bytes=64*1024*1024,span=16,basis=None):
    if type(span) is not int or span<1:raise ValueError('Positive query span required')
    blob=read_file(image,max_bytes);mapped=map_address(blob,context,coordinate,value);queries=[]
    for candidate in mapped['candidates']:
        if candidate['file_offset'] is None:continue
        off=int(candidate['file_offset'],16);body=blob[off:off+span]
        if not body:continue
        q={'file_offset_bytes':hex(off),'bytes':len(body),'sha256':sha(body),'expected_ghidra_address':candidate['ghidra_va'],'segment_index':candidate['segment_index']}
        q['key']=sha(canonical(q));queries.append(q)
    return {'schema':'dsh-re-static-request-v1','kind':'native','image_sha256':sha(blob),'evidence':evidence(source,max_bytes),
            'observation':mapped,'task_basis':basis,'queries':queries,'runtime_identity_verified':False,
            'authority':'coordinate arithmetic and saved evidence; process/load/context are declared, not live-verified'}


def dex_request(index,method_id,source,runtime=None,max_bytes=64*1024*1024,basis=None):
    sys.path.insert(0,str(Path(__file__).resolve().parents[2]/'android-re/scripts'))
    from _dex_index import opened
    with opened(index) as (con,snapshot,meta):
        row=con.execute('SELECT source,data FROM methods WHERE id=?',(method_id,)).fetchone()
        if not row:raise ValueError('Exact indexed method ID required; short names are not identity')
        m=json.loads(row['data']);s=json.loads(con.execute('SELECT data FROM sources WHERE id=?',(row['source'],)).fetchone()[0])
        queries=[]
        if m['file_coordinates_verified'] and m['code_bytes']:
            queries=[{'key':method_id,'file_offset_bytes':m['instructions_file_offset_bytes'],'bytes':m['code_bytes'],'sha256':m['code_sha256'],'dex_method_index':m['dex_method_index'],'signature':m['signature']}]
        runtime={} if runtime is None else runtime
        if not isinstance(runtime,dict):raise ValueError('Runtime context must be an object')
        required=('process_identity','load_instance_id','class_loader_id','dex_sha256','signature')
        complete=all(isinstance(runtime.get(k),str) and runtime[k] for k in required)
        conflict=runtime.get('dex_sha256',s['dex_sha256'])!=s['dex_sha256'] or runtime.get('signature',m['signature'])!=m['signature']
        return {'schema':'dsh-re-static-request-v1','kind':'dex','image_sha256':s['dex_sha256'],'evidence':evidence(source,max_bytes),
                'index_snapshot':snapshot,'source_id':s['id'],'dex_origin':{k:s[k] for k in ('container_sha256','entry','zip_ordinal','dex_sha256')},
                'method':m,'queries':queries,'runtime_context':runtime,'runtime_context_complete':complete,'runtime_context_conflict':conflict,
                'runtime_identity_verified':False,'task_basis':basis,
                'authority':'exact static method in selected DEX; loader/process identity remains declared; not JNI implementation proof'}


def address_number(value,space):
    if not isinstance(value,str):raise ValueError('Invalid snapshot address')
    if ':' in value:
        prefix,value=value.rsplit(':',1)
        if prefix!=space:raise ValueError('Snapshot address space mismatch')
    if not re.fullmatch(r'(?:0x)?[0-9a-fA-F]+',value):raise ValueError('Invalid snapshot address')
    return int(value,16)


def correlate(request_bytes,snapshot_bytes=None):
    request=json.loads(request_bytes)
    if request.get('schema')!='dsh-re-static-request-v1' or request.get('kind') not in ('native','dex'):raise ValueError('Unsupported association request')
    queries=request['queries'];keys=[q['key'] for q in queries]
    if len(set(keys))!=len(keys):raise ValueError('Duplicate query identity')
    result={'schema':'dsh-re-static-link-v1','request_sha256':sha(request_bytes),'evidence':request['evidence'],'task_basis':request.get('task_basis'),
            'image_sha256':request['image_sha256'],'kind':request['kind'],'candidates':[],
            'runtime_identity_verified':False,'target_accepted':None,'semantic_correctness':'unverified',
            'authority':'saved static snapshot association; exporter provenance and declared runtime context are not an authenticated live binding'}
    if not queries:result['state']='no_verified_file_span';return result
    if snapshot_bytes is None:result['state']='awaiting_static_snapshot';return result
    s=json.loads(snapshot_bytes);result['snapshot_sha256']=sha(snapshot_bytes)
    if s.get('schema')!='dsh-re-static-snapshot-v1' or s.get('request_sha256')!=sha(request_bytes):raise ValueError('Snapshot belongs to another request/load context')
    if s.get('program_sha256','').lower()!=request['image_sha256']:raise ValueError('Snapshot program hash mismatch')
    before=s.get('program_modification_before');after=s.get('program_modification_after')
    if not isinstance(before,str) or not before.isdigit() or before!=after or s.get('program_unchanged') is not True:raise ValueError('Static program changed during snapshot')
    if not isinstance(s.get('space'),str) or not s['space'] or not isinstance(s.get('producer_epoch'),str) or not s['producer_epoch']:raise ValueError('Missing static program space/producer identity')
    result['program']={k:s.get(k) for k in ('program_name','language','compiler','space','image_base','producer_epoch','program_modification_after')}
    requested={q['key']:q for q in queries};seen=set();conflicts=False;coordinates=False;missing=False
    for row in s['queries']:
        key=row['key']
        if key not in requested or key in seen:raise ValueError('Unknown/duplicate snapshot query')
        seen.add(key);q=requested[key]
        if row.get('file_offset_bytes')!=q['file_offset_bytes']:raise ValueError('Snapshot file offset mismatch')
        if row.get('state') in ('not_read_budget','unmapped','mapping_unavailable'):missing=True
        for match in row['matches']:
            if match.get('state')!='read':missing=True;continue
            if match.get('bytes')!=q['bytes'] or match.get('bytes_sha256')!=q['sha256'] or match.get('bytes_match') is not True:conflicts=True;continue
            if not isinstance(match.get('space'),str) or not match['space']:raise ValueError('Missing candidate address space')
            candidate={'key':key,'file_offset_bytes':q['file_offset_bytes'],'address':match['address'],'space':match['space'],'mapping_basis':row.get('mapping_basis','unspecified'),
                       'bytes_sha256':match['bytes_sha256'],'bytes':match['bytes'],'bytes_match':True,
                       'function':match.get('function'),'function_semantics_verified':False}
            if request['kind']=='native':
                consistent=match['space']==s['space'] and address_number(match['address'],match['space'])==int(q['expected_ghidra_address'],16)
                candidate['declared_ghidra_coordinate_consistent']=consistent
                if not consistent:coordinates=True
            result['candidates'].append(candidate)
    if set(requested)!=seen:missing=True
    result['snapshot_queries_complete']=not missing
    # A second valid segment/address remains an explicit alternative, not a first-match choice.
    if request.get('runtime_context_conflict'):state='runtime_context_conflict'
    elif conflicts:state='static_bytes_conflict'
    elif coordinates:state='declared_coordinate_conflict'
    elif len(result['candidates'])>1 or request['kind']=='native' and request['observation']['state']=='ambiguous':state='ambiguous_static_locations'
    elif missing:state='partial_static_snapshot'
    elif result['candidates']:state='matched_static_snapshot'
    else:state='unmapped'
    result['state']=state
    if request['kind']=='dex':
        result['method_id']=request['method']['id'];result['signature']=request['method']['signature']
        result['runtime_context_complete']=request.get('runtime_context_complete',False)
        result['runtime_context']=request.get('runtime_context',{})
    return result


def write_new(path,value):
    path=Path(path).absolute();path.parent.mkdir(parents=True,exist_ok=True,mode=0o700);body=canonical(value)
    publish(path,body)
    return {'path':str(path),'sha256':sha(body),'bytes':len(body)}


def main(argv=None):
    p=argparse.ArgumentParser(description=__doc__);sub=p.add_subparsers(dest='action',required=True)
    n=sub.add_parser('native-request');n.add_argument('--image',required=True);n.add_argument('--context',required=True);n.add_argument('--from',dest='coordinate',choices=['elf_va','runtime_addr','ghidra_va','file_offset'],required=True);n.add_argument('--value',required=True);n.add_argument('--span',type=int,default=16)
    d=sub.add_parser('dex-request');d.add_argument('--index',required=True);d.add_argument('--method',required=True);d.add_argument('--runtime')
    for item in (n,d):item.add_argument('--evidence',required=True);item.add_argument('--output',required=True);item.add_argument('--basis');item.add_argument('--max-bytes',type=int,default=64*1024*1024)
    link=sub.add_parser('link');link.add_argument('--request',required=True);link.add_argument('--snapshot');link.add_argument('--output',required=True);link.add_argument('--evidence');link.add_argument('--max-bytes',type=int,default=64*1024*1024)
    read=sub.add_parser('read');read.add_argument('--file',required=True);read.add_argument('--snapshot',required=True);read.add_argument('--offset',type=int,default=0);read.add_argument('--max-bytes',type=int,default=8192);read.add_argument('--max-document-bytes',type=int,default=64*1024*1024)
    args=p.parse_args(argv)
    try:
        if args.action=='native-request':result=native_request(args.image,read_json(args.context,args.max_bytes),args.coordinate,args.value,args.evidence,args.max_bytes,args.span,read_json(args.basis,args.max_bytes) if args.basis else None)
        elif args.action=='dex-request':result=dex_request(args.index,args.method,args.evidence,read_json(args.runtime,args.max_bytes) if args.runtime else None,args.max_bytes,read_json(args.basis,args.max_bytes) if args.basis else None)
        elif args.action=='link':
            result=correlate(read_file(args.request,args.max_bytes),read_file(args.snapshot,args.max_bytes) if args.snapshot else None)
            result['evidence_rechecked']=False
            if args.evidence:
                if sha(read_file(args.evidence,args.max_bytes))!=result['evidence']['sha256']:raise ValueError('Saved observation evidence changed')
                result['evidence_rechecked']=True
        else:
            body=read_file(args.file,args.max_document_bytes)
            if args.snapshot!=sha(body):raise ValueError('Document snapshot changed')
            if not 0<=args.offset<=len(body) or not 1<=args.max_bytes<=65536:raise ValueError('Invalid document page')
            part=body[args.offset:args.offset+args.max_bytes];end=args.offset+len(part)
            print(canonical({'ok':True,'snapshot':sha(body),'encoding':'base64','bytes':len(body),'offset':args.offset,'next':end if end<len(body) else None,'data':base64.b64encode(part).decode()}).decode());return 0
        artifact=write_new(args.output,result)
        print(canonical({'ok':True,**artifact,'state':result.get('state','request_created'),'queries':len(result.get('queries',[])),'candidate_count':len(result.get('candidates',[])),'runtime_identity_verified':False,'target_accepted':None}).decode());return 0
    except (ValueError,TypeError,KeyError,OSError,sqlite3.Error) as e:
        print(canonical({'ok':False,'error':str(e),'device_operations':0}).decode());return 2


if __name__=='__main__':raise SystemExit(main())
