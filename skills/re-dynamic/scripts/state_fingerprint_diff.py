#!/usr/bin/env python3
"""Compare explicitly typed, saved state observations. No process execution or acceptance inference."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re

class DiffError(ValueError):pass
def digest(b):return hashlib.sha256(b).hexdigest()
def load_file(root,name):
    if not isinstance(name,str) or not name:raise DiffError('Explicit record file required')
    p=(root/name).resolve(strict=True)
    if not p.is_relative_to(root) or not p.is_file():raise DiffError('Record must stay within explicit evidence root')
    body=p.read_bytes();return json.loads(body),{'path':str(p),'sha256':digest(body),'bytes':len(body)}
def field_contracts(items):
    if not isinstance(items,list) or not items:raise DiffError('At least one explicit compared field required')
    result=[];seen=set()
    for f in items:
        if not isinstance(f,dict) or not isinstance(f.get('name'),str) or not f['name'] or f['name'] in seen or f.get('type') not in ('uint','sint','bool','string','bytes'):raise DiffError('Unique field name and supported explicit type required')
        if not isinstance(f.get('unit'),str) or not f['unit']:raise DiffError('Explicit field unit/address/count convention required')
        if f['type'] in ('uint','sint'):
            bits=f.get('bits')
            if isinstance(bits,bool) or not isinstance(bits,int) or not 1<=bits<=4096 or f.get('parse','native') not in ('native','hex','decimal'):raise DiffError('Supported integer contract: 1..4096 bits with native/hex/decimal parse')
        elif f['type']=='bytes' and f.get('parse','hex')!='hex':raise DiffError('Byte field encoding is explicitly hex')
        seen.add(f['name']);result.append(f.copy())
    return result
def value_for(observation,field):
    if not isinstance(observation,dict):return {'state':'missing','reason':'No observation object'}
    state=observation.get('state')
    if state not in ('observed','derived','missing','unsupported'):return {'state':'invalid','reason':'Explicit observed/derived/missing/unsupported state required'}
    if state in ('missing','unsupported'):return {'state':state,'reason':observation.get('reason')}
    if observation.get('unit')!=field['unit']:return {'state':'invalid','reason':'Unit/address/count convention differs from comparison contract'}
    try:
        val=observation['value'];kind=field['type'];parse=field.get('parse','native')
        if kind in ('uint','sint'):
            if parse!='native':
                pattern=r'(?:0x)?[0-9a-fA-F]+' if parse=='hex' else r'-?[0-9]+'
                if not isinstance(val,str) or not re.fullmatch(pattern,val):raise DiffError('Invalid explicit integer text; no whitespace/implicit masking')
                val=int(val,16 if parse=='hex' else 10)
            if isinstance(val,bool) or not isinstance(val,int):raise DiffError('Integer required, bool is not integer evidence')
            bits=field['bits'];lo=0 if kind=='uint' else -(1<<(bits-1));hi=(1<<bits)-1 if kind=='uint' else (1<<(bits-1))-1
            if not lo<=val<=hi:raise DiffError('Value outside declared width; no truncation')
        elif kind=='bool':
            if not isinstance(val,bool):raise DiffError('Boolean required')
        elif kind=='string':
            if not isinstance(val,str):raise DiffError('String required')
        else:
            if not isinstance(val,str) or len(val)%2 or not re.fullmatch(r'[0-9a-fA-F]*',val):raise DiffError('Exact hex bytes required; no whitespace normalization')
            val=val.lower()
        return {'state':state,'value':val,'unit':field['unit']}
    except (ValueError,KeyError) as e:return {'state':'invalid','reason':str(e)}
def compare_case(left,right,fields):
    reasons=[];hard=False
    for side,record in [('left',left),('right',right)]:
        if not isinstance(record,dict):raise DiffError('Observation record must be an object')
        for key in ('target_sha256','input_sha256','implementation_sha256'):
            if not isinstance(record.get(key),str) or not re.fullmatch(r'[a-fA-F0-9]{64}',record[key]):reasons.append(side+': invalid/missing '+key);hard=True
        for key in ('input_contract','backend','stop_reason','implementation_ref'):
            if not isinstance(record.get(key),str) or not record[key]:reasons.append(side+': missing '+key);hard=True
        if record.get('execution_status')!='completed':reasons.append(side+': execution not completed; status='+str(record.get('execution_status')))
        if not isinstance(record.get('observations'),dict):reasons.append(side+': observations unavailable');hard=True
        if not isinstance(record.get('initial_state_ref'),str) or not record['initial_state_ref']:reasons.append(side+': initial state not declared')
    for key in ('target_sha256','input_sha256','input_contract','initial_state_ref'):
        a,b=left.get(key),right.get(key)
        if key.endswith('sha256') and isinstance(a,str) and isinstance(b,str):a,b=a.lower(),b.lower()
        if a is not None and b is not None and a!=b:reasons.append('Different '+key);hard=True
    results=[]
    for f in fields:
        a=value_for(left.get('observations',{}).get(f['name']) if isinstance(left.get('observations'),dict) else None,f);b=value_for(right.get('observations',{}).get(f['name']) if isinstance(right.get('observations'),dict) else None,f)
        usable=all(v['state'] in ('observed','derived') for v in (a,b));equal=a.get('value')==b.get('value') if usable else None
        state='not_compared' if not usable else ('equal' if equal else 'different') if a['state']==b['state']=='observed' else 'derived_equal' if equal else 'derived_different'
        if a['state']!='observed' or b['state']!='observed':reasons.append('Incomplete/direct-observation gap: '+f['name'])
        results.append({'name':f['name'],'left':a,'right':b,'comparison':state,'values_equal':equal})
    unequal=[v['name'] for v in results if v['values_equal'] is False]
    comparison='different_selected_values' if unequal else 'all_selected_values_equal' if all(v['values_equal'] is True for v in results) else 'incomplete'
    return {'comparability':'not_comparable' if hard else 'partial' if reasons else 'comparable_under_declared_contract','reasons':reasons,'fields':results,'comparison':comparison,'first_unequal_selected_field':unequal[0] if unequal else None,'first_divergent_execution_step':None,'stop_reasons':{'left':left.get('stop_reason'),'right':right.get('stop_reason'),'equal':left.get('stop_reason')==right.get('stop_reason')},'backends':{'left':left.get('backend'),'right':right.get('backend')},'implementations':{side:{'ref':record.get('implementation_ref'),'declared_sha256':record.get('implementation_sha256')} for side,record in [('left',left),('right',right)]},'interventions':{'left':left.get('interventions',[]),'right':right.get('interventions',[])},'root_cause':None,'target_accepted':None,'scope':'selected fields and these saved cases only; not full equivalence, inversion proof, unique input or acceptance'}
def build(plan,root):
    if not isinstance(plan,dict) or not isinstance(plan.get('cases'),list) or not plan['cases']:raise DiffError('Nonempty saved cases array required')
    if any(k in plan for k in ('command','argv','target_command','model_command','generator')):raise DiffError('Offline comparison accepts saved records, not execution settings')
    fields=field_contracts(plan.get('fields'));root=Path(root).resolve(strict=True);cases=[];seen=set()
    for case in plan['cases']:
        if not isinstance(case,dict) or not isinstance(case.get('id'),str) or not case['id'] or case['id'] in seen:raise DiffError('Unique explicit case id required')
        seen.add(case['id']);left,ls=load_file(root,case.get('left'));right,rs=load_file(root,case.get('right'));cases.append({'id':case['id'],'sources':{'left':ls,'right':rs},**compare_case(left,right,fields)})
    return {'schema':'saved-state-diff-v1','execution':False,'field_contracts':fields,'cases':cases,'target_accepted':None,'model_equivalence_proven':False,'case_count':len(cases)}
def main(argv=None):
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--describe',action='store_true');p.add_argument('--plan');p.add_argument('--root');p.add_argument('--out');a=p.parse_args(argv)
    try:
        if a.describe:print(json.dumps({'tool':'state-fingerprint-diff','execution':False,'input':'saved typed JSON records','states':['observed','derived','missing','unsupported'],'diagnosis':'selected differences only; root cause and acceptance not inferred'}));return 0
        if not a.plan or not a.out:raise DiffError('Explicit --plan FILE --out NEW_JSON required')
        path=Path(a.plan).resolve(strict=True);result=build(json.loads(path.read_text(encoding='utf-8')),Path(a.root).resolve(strict=True) if a.root else path.parent)
        fd=os.open(a.out,os.O_CREAT|os.O_EXCL|os.O_WRONLY,0o600)
        with os.fdopen(fd,'w',encoding='utf-8') as f:json.dump(result,f,ensure_ascii=False,indent=2);f.write('\n')
        print(json.dumps({'ok':True,'receipt':str(Path(a.out).resolve()),'cases':len(result['cases']),'comparability_counts':{state:sum(c['comparability']==state for c in result['cases']) for state in ('comparable_under_declared_contract','partial','not_comparable')},'execution':False,'target_accepted':None}));return 0
    except (OSError,ValueError,TypeError,KeyError) as e:print(json.dumps({'ok':False,'error':str(e),'execution':False}));return 4
if __name__=='__main__':raise SystemExit(main())
