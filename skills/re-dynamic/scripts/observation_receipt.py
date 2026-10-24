#!/usr/bin/env python3
"""Organize explicitly saved run evidence. Never executes commands or infers acceptance."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re

class ReceiptError(ValueError):pass
def read_evidence(root,path):
    if not isinstance(path,str) or not path:raise ReceiptError('Evidence path must be explicit')
    p=(root/path).resolve(strict=True)
    if not p.is_relative_to(root) or not p.is_file():raise ReceiptError('Evidence must be a regular file within the explicit evidence root')
    body=p.read_bytes();return body,{'path':str(p),'bytes':len(body),'sha256':hashlib.sha256(body).hexdigest()}
def build(plan,root,include_values=False):
    if not isinstance(plan,dict) or not isinstance(plan.get('runs'),list) or not plan['runs']:raise ReceiptError('Nonempty runs array required')
    root=Path(root).resolve(strict=True);pattern=plan.get('pattern')
    if not isinstance(pattern,str) or not pattern:raise ReceiptError('Explicit bytes-regex pattern required; no default flag format')
    try:regex=re.compile(pattern.encode('utf-8'))
    except (ValueError,re.error) as e:raise ReceiptError('Invalid explicit pattern') from e
    runs=[];ids=set();candidate_sets=[];observations=[]
    for run in plan['runs']:
        if not isinstance(run,dict) or any(k in run for k in ('cmd','command','argv','env','cwd')):raise ReceiptError('Runs describe evidence, never commands or execution settings')
        ident=run.get('id');instance=run.get('instance_id');connection=run.get('connection_id')
        if not isinstance(ident,str) or not ident or ident in ids or not isinstance(instance,str) or not instance:raise ReceiptError('Unique run id and explicit instance_id required')
        if connection is not None and (not isinstance(connection,str) or not connection):raise ReceiptError('connection_id must be a nonempty label or null')
        if run.get('execution_status') not in ('completed','failed','interrupted','unknown'):raise ReceiptError('Explicit execution_status required')
        rc=run.get('exit_code')
        if rc is not None and (isinstance(rc,bool) or not isinstance(rc,int)):raise ReceiptError('exit_code must be int/null')
        ids.add(ident);input_bytes=None;input_ref=None;expected=None;expected_ref=None
        if 'input' in run:input_bytes,input_ref=read_evidence(root,run['input'])
        if 'expected' in run:expected,expected_ref=read_evidence(root,run['expected'])
        sources=[];matches=[];fingerprints=set()
        for stream in ('stdout','stderr'):
            if stream not in run:continue
            body,reference=read_evidence(root,run[stream]);sources.append({'stream':stream,**reference})
            for match in regex.finditer(body):
                value=match.group()
                if not value:raise ReceiptError('Pattern matched empty bytes; no meaningful candidate')
                digest=hashlib.sha256(value).hexdigest();fingerprints.add(digest);observations.append((reference['sha256'],match.start(),match.end()))
                item={'stream':stream,'source_sha256':reference['sha256'],'offset':match.start(),'length':len(value),'candidate_sha256':digest,'occurs_in_input':None if input_bytes is None else value in input_bytes,'matches_explicit_expectation':None if expected is None else value==expected}
                if include_values:item['value_hex']=value.hex()
                matches.append(item)
        if not sources:raise ReceiptError('Each run needs stdout or stderr evidence')
        evidence_paths=run.get('acceptance_evidence',[])
        if not isinstance(evidence_paths,list):raise ReceiptError('acceptance_evidence must be explicit file paths in an array')
        acceptance=[read_evidence(root,p)[1] for p in evidence_paths]
        runs.append({'id':ident,'instance_id':instance,'connection_id':connection,'execution_status':run['execution_status'],'exit_code':rc,'sources':sources,'input':input_ref,'expected':expected_ref,'candidates':matches,'candidate_state':'none' if not matches else 'observed_candidate' if len(matches)==1 else 'multiple_candidates','explicit_expectation_state':'not_provided' if expected is None else 'candidate_matches' if any(m['matches_explicit_expectation'] for m in matches) else 'no_match','program_accept':'unknown','platform_accept':'unknown','acceptance_evidence_unverified':acceptance})
        candidate_sets.append(sorted(fingerprints))
    enough=len(runs)>1 and all(candidate_sets)
    comparison='same_candidate_sets' if enough and all(s==candidate_sets[0] for s in candidate_sets) else 'varying_candidate_sets' if enough else 'insufficient_candidates'
    return {'schema':'saved-observation-receipt-v1','execution':False,'runs':runs,'comparison':comparison,'repeated_content_locations':len(observations)!=len(set(observations)),'independence':'not established by labels, hashes or repetition','pattern':pattern,'values_included':include_values,'target_accepted':None,'scope':'output observations and optional caller-supplied byte expectations only; no automatic success or secret publication'}
def main(argv=None):
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--describe',action='store_true');p.add_argument('--plan');p.add_argument('--root');p.add_argument('--include-values',action='store_true');p.add_argument('--out');a=p.parse_args(argv)
    try:
        if a.describe:print(json.dumps({'tool':'observation-receipt','execution':False,'input':'saved files and explicit instance/connection labels','values_default':'hash/locator only','program_accept':'unknown','platform_accept':'unknown','overwrite':False}));return 0
        if not a.plan or not a.out:raise ReceiptError('--plan FILE --out NEW_JSON required')
        path=Path(a.plan).resolve(strict=True);plan=json.loads(path.read_text(encoding='utf-8'));result=build(plan,Path(a.root).resolve(strict=True) if a.root else path.parent,a.include_values)
        fd=os.open(a.out,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
        with os.fdopen(fd,'w',encoding='utf-8') as f:json.dump(result,f,ensure_ascii=False,indent=2);f.write('\n')
        print(json.dumps({'ok':True,'receipt':str(Path(a.out).resolve()),'runs':len(result['runs']),'comparison':result['comparison'],'execution':False,'target_accepted':None}));return 0
    except (OSError,ValueError,TypeError) as e:print(json.dumps({'ok':False,'error':str(e),'execution':False}));return 4
if __name__=='__main__':raise SystemExit(main())
