#!/usr/bin/env python3
"""Compile and run only the authored host JVM/JNI fixture; no Frida/Android calls."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

ROOT=Path(__file__).resolve().parents[1]
parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('--required-host',action='store_true',help='missing Linux compiler/JDK is a failure, not a skip')
parser.add_argument('--output',help='write a new receipt; never overwrite')
args=parser.parse_args()
javac,compiler=shutil.which('javac'),shutil.which('cc')
home=Path(javac).resolve().parent.parent if javac else None
supported=sys.platform.startswith('linux') and home is not None and compiler is not None and (home/'include/jni.h').is_file() and (home/'bin/java').is_file()
if not supported:
    print(json.dumps({'ok':False if args.required_host else None,'state':'failed' if args.required_host else 'skipped',
                      'reason':'This fixture lane needs a Linux JDK with JNI headers and a C compiler','device_tested':False}))
    raise SystemExit(2 if args.required_host else 0)
fixture=ROOT/'tests/fixtures/re-lab-jni'
try:
    with tempfile.TemporaryDirectory(prefix='dsh-re-jni-') as temporary:
        work=Path(temporary);classes=work/'classes';classes.mkdir()
        commands=[[javac,'-d',str(classes),str(fixture/'Probe.java')],
                  [compiler,'-shared','-fPIC','-std=c11','-I'+str(home/'include'),'-I'+str(home/'include/linux'),str(fixture/'probe.c'),'-o',str(work/'libdsh_re_probe.so')],
                  [str(home/'bin/java'),'-Djava.library.path='+str(work),'-cp',str(classes),'org.dsh.relab.Probe']]
        outputs=[]
        for argv in commands:
            result=subprocess.run(argv,cwd=work,capture_output=True,text=True,timeout=30,env={k:v for k,v in os.environ.items() if k not in ('JAVA_TOOL_OPTIONS','JDK_JAVA_OPTIONS','_JAVA_OPTIONS','CLASSPATH')})
            if result.returncode:raise ValueError('Owned fixture command failed: '+Path(argv[0]).name+'; '+result.stderr[-1000:])
            outputs.append(result.stdout)
        observed=json.loads(outputs[-1])
        signed=lambda value:((value+2**31)%2**32)-2**31
        expected=[{'input':x,'exported':signed(x^0x5a5a),'registered':signed(x*3+7)} for x in (0,1,-1,2**31-1)]
        if observed.get('backend')!='host-jvm-jni' or observed.get('results')!=expected:raise ValueError('JNI results differ from known-answer contract')
        receipt={'ok':True,'state':'passed','backend':'host-jvm-jni','cases':len(expected),'static_export_and_register_natives':True,
                 'fixture_sha256':{name:hashlib.sha256((fixture/name).read_bytes()).hexdigest() for name in ('Probe.java','probe.c')},
                 'jdk':subprocess.check_output([str(home/'bin/javac'),'-version'],text=True,stderr=subprocess.STDOUT).strip(),
                 'device_tested':False,'frida_tested':False,'model_calls':0,'limitation':'Authored host JVM/JNI call semantics only; no ART, device instrumentation or blind-evaluation claim'}
        if args.output:
            with open(args.output,'x',encoding='utf-8') as stream:json.dump(receipt,stream,indent=2)
        print(json.dumps(receipt))
except (OSError,ValueError,subprocess.SubprocessError) as error:
    print(json.dumps({'ok':False,'state':'failed','error':str(error),'device_tested':False}));raise SystemExit(2)
