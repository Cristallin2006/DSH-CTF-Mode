#!/usr/bin/env python3
"""Owned POSIX pipes + compiled harmless environment fixture. No challenge/remote/model."""
import importlib.util,json,os,shutil,subprocess,sys,tempfile
from pathlib import Path
ROOT=Path(os.environ.get('DSH_RUNTIME_SKILL_ROOT',Path(__file__).resolve().parents[1]))
def load(name):
    spec=importlib.util.spec_from_file_location(name,ROOT/'skills/pwn-exploit/scripts'/f'{name}.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);return m
s=load('stream_io');r=load('bundled_runtime')
assert sys.platform=='linux','Run native fixtures on Linux'
rd,wr=os.pipe()
try:
    os.set_blocking(rd,False);os.set_blocking(wr,False);stream=s.Stream(s.FDTransport(rd,wr));fmt=s.FrameFormat(4,'little');os.write(wr,fmt.encode(b'own pipe'));assert stream.read_frame(fmt,deadline=s.deadline_after(1))['body']==b'own pipe'
    stream.write_all(b'x',deadline=s.deadline_after(1));assert os.read(rd,1)==b'x'
finally:os.close(rd);os.close(wr)
fixture=Path(tempfile.mkdtemp(prefix='dsh-runtime-native-',dir='/var/tmp'));lib=fixture/'lib';lib.mkdir();compiler=shutil.which('cc');assert compiler,'Native C fixture requires installed cc; never installs dependencies'
clean={k:os.environ[k] for k in ('PATH','HOME','LANG') if k in os.environ}
code=fixture/'probe.c';code.write_text('#include <stdio.h>\n#include <stdlib.h>\n#include <unistd.h>\nint main(int n,char **v){printf("ARG=%s\\n",n>1?v[1]:"");printf("TAG=%s\\n",getenv("FIXTURE_TAG"));fflush(stdout);execl("/usr/bin/env","env",(char*)0);return 2;}\n')
binary=fixture/'owned probe';subprocess.run([compiler,str(code),'-o',str(binary)],env=clean,check=True,capture_output=True)
elf=r.ELF(binary.read_bytes());assert elf.machine==62,'This native environment fixture is x86-64 glibc only'
loader=Path(elf.interp).resolve(strict=True);shutil.copy2(loader,lib/'loader')
libc_path=Path(subprocess.check_output([compiler,'-print-file-name=libc.so.6'],env=clean,text=True).strip()).resolve(strict=True);shutil.copyfile(libc_path,lib/'libc.so.6')
plan={'schema':'bundled-runtime-plan-v1','binary':binary.name,'loader':'lib/loader','loader_kind':'glibc','library_dirs':['lib'],'arguments':['literal space ; $(no shell)'],'cwd':'.','environment':{'PATH':'/usr/bin:/bin','LANG':'C','FIXTURE_TAG':'authored-local'}}
report=r.build(plan,fixture);assert report['candidate_coverage']=='complete_in_explicit_inventory'
launch=report['launch_plan'];p=subprocess.run(launch['argv'],cwd=launch['cwd'],env=launch['environment'],capture_output=True,text=True,timeout=10);assert p.returncode==0,p.stderr
lines=p.stdout.splitlines();assert lines[:2]==['ARG=literal space ; $(no shell)','TAG=authored-local'];assert 'FIXTURE_TAG=authored-local' in lines;assert set(lines[2:])=={'PATH=/usr/bin:/bin','LANG=C','FIXTURE_TAG=authored-local'}
result={'ok':True,'fixture':str(fixture),'actual_installed_source':str(ROOT),'checks':['owned nonblocking pipe exact frame','owned pipe confirmed write','compiled harmless ELF under explicit loader','literal argv without shell','explicit environment reaches own exec child only'],'target_requests':0,'model_calls':0,'limitation':'Owned Linux glibc fixture only; not a challenge, musl execution, remote equivalence or general loader ABI proof'}
(fixture/'validation.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result,indent=2))
