#!/usr/bin/env python3
"""Check a declared finite bit-vector model. No binary loading or code evaluation.

Input is JSON on stdin. Output is JSON on stdout. Requires the selected Python's
z3-solver package; never installs packages or executes another program.
"""
import argparse
import json
import re
import sys
import time

VERSION='0.1.0'
MAX_INPUT=65536

def run(document,timeout_ms,z3):
    if not isinstance(document,dict) or set(document)-{'width','variables','assumptions','query'}:
        raise ValueError('expected width, variables, assumptions and query only')
    width=document.get('width')
    if type(width) is not int or not 1<=width<=64:raise ValueError('width must be 1..64')
    names=document.get('variables')
    if not isinstance(names,list) or not 1<=len(names)<=16 or any(not isinstance(n,str) or not re.fullmatch(r'[A-Za-z][A-Za-z0-9_]{0,31}',n) for n in names) or len(set(names))!=len(names):
        raise ValueError('variables must be 1..16 distinct short identifiers')
    variables={n:z3.BitVec(n,width) for n in names}
    nodes=0
    def parse(value,depth=0):
        nonlocal nodes
        nodes+=1
        if nodes>512 or depth>48:raise ValueError('expression too large')
        if type(value) is int:
            if not -(1<<width)<=value<(1<<width):raise ValueError('constant outside declared width')
            return z3.BitVecVal(value,width)
        if type(value) is bool:return z3.BoolVal(value)
        if isinstance(value,str):
            if value not in variables:raise ValueError('undeclared variable')
            return variables[value]
        if not isinstance(value,dict) or set(value)!={'op','args'} or not isinstance(value['args'],list):
            raise ValueError('expression must be a constant, variable, or {op,args}')
        op=value['op'];raw=value['args']
        unary={'not','neg','lnot'}
        binary={'add','sub','mul','and','or','xor','shl','lshr','ashr','eq','ne','ult','ule','slt','sle','land','lor'}
        if not isinstance(op,str) or op not in unary|binary:raise ValueError('unsupported operation')
        arity=1 if op in unary else 2
        if len(raw)!=arity:raise ValueError('wrong operation arity')
        args=[parse(a,depth+1) for a in raw]
        logical=op in {'lnot','land','lor'}
        if not all((z3.is_bool(a) if logical else z3.is_bv(a)) for a in args):raise ValueError('operation type mismatch')
        a=args[0];b=args[1] if len(args)>1 else None
        if op=='not':return ~a
        if op=='neg':return -a
        if op=='lnot':return z3.Not(a)
        if op=='add':return a+b
        if op=='sub':return a-b
        if op=='mul':return a*b
        if op=='and':return a&b
        if op=='or':return a|b
        if op=='xor':return a^b
        if op=='shl':return a<<b
        if op=='lshr':return z3.LShR(a,b)
        if op=='ashr':return a>>b
        if op=='eq':return a==b
        if op=='ne':return a!=b
        if op=='ult':return z3.ULT(a,b)
        if op=='ule':return z3.ULE(a,b)
        if op=='slt':return a<b
        if op=='sle':return a<=b
        if op=='land':return z3.And(a,b)
        if op=='lor':return z3.Or(a,b)
        raise AssertionError('unreachable operation')
    assumptions=document.get('assumptions',[])
    if not isinstance(assumptions,list):raise ValueError('assumptions must be an array')
    constraints=[parse(a) for a in assumptions]
    if not all(z3.is_bool(a) for a in constraints):raise ValueError('assumptions must be boolean')
    query=document.get('query')
    if not isinstance(query,dict):raise ValueError('query must be an object')
    kind=query.get('kind')
    if kind=='equivalence' and set(query)=={'kind','left','right'}:
        left,right=parse(query['left']),parse(query['right'])
        if not z3.is_bv(left) or not z3.is_bv(right):raise ValueError('equivalence requires bit-vectors')
        tests=[('difference',left!=right)]
    elif kind=='branch' and set(query)=={'kind','predicate'}:
        predicate=parse(query['predicate'])
        if not z3.is_bool(predicate):raise ValueError('predicate must be boolean')
        tests=[('true',predicate),('false',z3.Not(predicate))]
    else:raise ValueError('unsupported query shape')
    # The budget covers all solver checks, not one fresh budget per branch.
    deadline=time.monotonic()+timeout_ms/1000
    checks=[]
    def solve(label,extra=None):
        remaining=int((deadline-time.monotonic())*1000)
        if remaining<1:
            item={'check':label,'status':'unknown','reason':'total time budget exhausted'}
            checks.append(item);return item
        solver=z3.Solver();solver.set(timeout=remaining);solver.add(*constraints)
        if extra is not None:solver.add(extra)
        result=solver.check();item={'check':label,'status':str(result)}
        if result==z3.sat:
            model=solver.model()
            item['witness']={n:{'unsigned':model.eval(v,model_completion=True).as_long(),
                                'hex':hex(model.eval(v,model_completion=True).as_long())} for n,v in variables.items()}
        elif result==z3.unknown:item['reason']=solver.reason_unknown()
        checks.append(item);return item
    base=solve('assumptions')
    if base['status']=='unsat':status='inconsistent_assumptions'
    elif base['status']=='unknown':status='unknown'
    else:
        answers=[solve(label,expr) for label,expr in tests]
        statuses=[a['status'] for a in answers]
        if 'unknown' in statuses:status='unknown'
        elif kind=='equivalence':status='equivalent_under_assumptions' if statuses==['unsat'] else 'counterexample'
        elif statuses==['sat','sat']:status='both_branches_possible'
        elif statuses==['sat','unsat']:status='always_true_under_assumptions'
        elif statuses==['unsat','sat']:status='always_false_under_assumptions'
        else:raise RuntimeError('solver results inconsistent with satisfiable assumptions')
    return {'ok':True,'status':status,'width':width,'timeout_ms':timeout_ms,'checks':checks,
            'engine':'z3','engine_version':z3.get_version_string(),'helper_version':VERSION,
            'scope':'declared bit-vector model and assumptions only; no machine-code or target verification'}

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--timeout-ms',type=int,default=5000)
    parser.add_argument('--describe',action='store_true')
    args=parser.parse_args()
    if args.describe:
        print(json.dumps({'tool':'local-bv-check','contract_version':1,'input':'JSON on stdin',
                          'width':'1..64','variables':'1..16','dependency':'z3-solver',
                          'interventions':[],'target_accepted':None,
                          'scope':'declared finite bit-vector model only; no binary loading, memory, flags, floats or target execution',
                          'result':'ok means result reported; status may be unknown or inconsistent_assumptions'}))
        return 0
    if not 1<=args.timeout_ms<=60000:parser.error('timeout must be 1..60000 milliseconds')
    try:
        import z3
    except ImportError:
        print(json.dumps({'ok':False,'status':'capability_unavailable','dependency':'z3-solver','interpreter':sys.executable}));return 3
    try:
        data=sys.stdin.buffer.read(MAX_INPUT+1)
        if len(data)>MAX_INPUT:raise ValueError('input exceeds 64 KiB')
        def pairs(items):
            result={}
            for k,v in items:
                if k in result:raise ValueError('duplicate JSON key')
                result[k]=v
            return result
        document=json.loads(data,object_pairs_hook=pairs)
        result=run(document,args.timeout_ms,z3)
    except (ValueError,TypeError,RecursionError) as exc:
        print(json.dumps({'ok':False,'status':'invalid_input','error':str(exc)}));return 2
    except Exception as exc:
        print(json.dumps({'ok':False,'status':'execution_error','error':str(exc)}));return 1
    print(json.dumps(result,ensure_ascii=False));return 0

if __name__=='__main__':sys.exit(main())
