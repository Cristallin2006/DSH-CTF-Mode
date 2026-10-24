#!/usr/bin/env python3
"""Read-only Linux PID/explicit-root snapshots; never attach, signal or choose a worker."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import struct
import sys

class SnapshotError(ValueError):pass
def identity(pid):
    try:return Path('/proc/sys/kernel/random/boot_id').read_text().strip()+':'+Path(f'/proc/{pid}/stat').read_text().rsplit(')',1)[1].split()[19]
    except (OSError,IndexError):return None
def load_segments(data):
    if len(data)<64 or data[:7]!=b'\x7fELF\x02\x01\x01':raise SnapshotError('Module load-bias reader supports ELF64 LE only')
    typ=struct.unpack_from('<H',data,16)[0];off=struct.unpack_from('<Q',data,32)[0];size,count=struct.unpack_from('<HH',data,54)
    if typ not in (2,3) or size!=56 or not count or count==65535 or off+size*count>len(data):raise SnapshotError('Unsupported or malformed ELF program headers')
    result=[]
    for i in range(count):
        t,flags,p_off,va,_,filesz,memsz,align=struct.unpack_from('<IIQQQQQQ',data,off+i*size)
        if t==1:
            if filesz>memsz or p_off+filesz>len(data):raise SnapshotError('Invalid PT_LOAD bounds')
            result.append({'offset':p_off,'va':va,'filesz':filesz,'memsz':memsz,'flags':flags})
    return typ,result
def module_bias(data,maps,device,inode,page_size):
    typ,segments=load_segments(data)
    if not segments or not page_size or page_size&(page_size-1):raise SnapshotError('Segments and actual power-of-two page size required')
    selected=[];sets=[]
    for line in maps.splitlines():
        v=line.split(maxsplit=5)
        if len(v)<5:raise SnapshotError('Malformed maps line')
        try:
            dev=tuple(int(x,16) for x in v[3].split(':'));ino=int(v[4]);start,end=(int(x,16) for x in v[0].split('-'));off=int(v[2],16)
        except ValueError as e:raise SnapshotError('Malformed map numbers') from e
        if dev!=device or ino!=inode:continue
        candidates=set()
        for s in segments:
            lo=s['offset']//page_size*page_size;hi=(s['offset']+s['filesz']+page_size-1)//page_size*page_size
            if s['filesz'] and lo<=off<hi:
                bias=start-s['va']-(off-s['offset'])
                if bias>=0 and bias%page_size==0:candidates.add(bias)
        if not candidates:raise SnapshotError('File mapping does not match any supported PT_LOAD view')
        selected.append({'start':start,'end':end,'offset':off,'permissions':v[1]});sets.append(candidates)
    common=set.intersection(*sets) if sets else set()
    if len(common)!=1:return {'state':'ambiguous' if common else 'unknown','load_bias':None,'candidate_biases':sorted(common),'mappings':selected}
    bias=next(iter(common))
    if typ==2 and bias!=0:return {'state':'unknown','load_bias':None,'reason':'ET_EXEC maps do not match expected fixed ELF VA','mappings':selected}
    return {'state':'observed','load_bias':bias,'elf_type':typ,'mappings':selected,'address_rule':'runtime = load_bias + ELF_VA; analysis-image VA requires its explicit rebase conversion'}
def descendants(root):
    anchor=identity(root)
    if anchor is None:raise SnapshotError('Explicit root unavailable')
    seen={root};queue=[(root,anchor)];candidates=[]
    while queue:
        pid,expected=queue.pop(0)
        if identity(pid)!=expected:continue
        try:children=[int(v) for v in Path(f'/proc/{pid}/task/{pid}/children').read_text().split()]
        except OSError:continue
        if identity(pid)!=expected:continue
        for child in children:
            if child in seen:continue
            seen.add(child)
            try:
                parent=int(next(l for l in Path(f'/proc/{child}/status').read_text().splitlines() if l.startswith('PPid:')).split()[1])
                child_identity=identity(child)
                if parent==pid and child_identity:candidates.append((child,child_identity));queue.append((child,child_identity))
            except (OSError,StopIteration,ValueError):continue
    if identity(root)!=anchor:raise SnapshotError('Root identity changed during non-atomic tree observation')
    return anchor,candidates
def inspect_pid(pid,*,expected_identity=None,exe=None,tokens=(),socket_inode=None):
    result={'pid':pid,'state':'unknown','matched':False,'authorization':'caller scope only; discovery grants no attach/cleanup permission'}
    handle=None
    try:
        if not isinstance(pid,int) or isinstance(pid,bool) or pid<=0:raise SnapshotError('Positive PID required')
        before=identity(pid)
        if before is None:raise SnapshotError('Process unavailable')
        if expected_identity and expected_identity!=before:raise SnapshotError('Recorded process identity does not match')
        handle=os.pidfd_open(pid);root=Path('/proc')/str(pid)
        with (root/'exe').open('rb') as f:
            info=os.fstat(f.fileno());data=f.read()
        image=(info.st_dev,info.st_ino);argv=(root/'cmdline').read_bytes().split(b'\0');matched_tokens=all(os.fsencode(t) in argv for t in tokens)
        expected_exe=Path(exe).stat() if exe is not None else None
        matches_exe=expected_exe is None or image==(expected_exe.st_dev,expected_exe.st_ino)
        status=(root/'status').read_text();ppid=int(next(v for v in status.splitlines() if v.startswith('PPid:')).split()[1]);maps=(root/'maps').read_text()
        sockets=[]
        for fd in (root/'fd').iterdir():
            try:
                target=os.readlink(fd)
                if target.startswith('socket:['):sockets.append(int(target[8:-1]))
            except OSError:pass
        try:module=module_bias(data,maps,(os.major(info.st_dev),os.minor(info.st_dev)),info.st_ino,os.sysconf('SC_PAGE_SIZE'))
        except SnapshotError as e:module={'state':'unsupported','load_bias':None,'reason':str(e)}
        after=os.stat(root/'exe')
        if identity(pid)!=before or image!=(after.st_dev,after.st_ino) or (root/'maps').read_text()!=maps:raise SnapshotError('Process identity/image/mappings changed during observation')
        result.update(state='observed',identity=before,parent_pid=ppid,executable={'device':info.st_dev,'inode':info.st_ino,'sha256':hashlib.sha256(data).hexdigest()},argv_tokens_match=matched_tokens,executable_filter_match=matches_exe,socket_inodes=sorted(set(sockets)),socket_filter_match=socket_inode is None or socket_inode in sockets,module=module)
        result['matched']=matched_tokens and matches_exe and result['socket_filter_match']
        result['connection_binding']='inode present, may be inherited/shared; not proof of application session' if socket_inode is not None else 'not requested'
    except (OSError,ValueError,StopIteration,IndexError) as e:result['reason']=str(e)
    finally:
        if handle is not None:os.close(handle)
    return result
def main(argv=None):
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--describe',action='store_true');g=p.add_mutually_exclusive_group();g.add_argument('--pid',type=int,nargs='+');g.add_argument('--root-pid',type=int);p.add_argument('--expected-identity');p.add_argument('--exe');p.add_argument('--argv-token',action='append',default=[]);p.add_argument('--socket-inode',type=int);p.add_argument('--out');a=p.parse_args(argv)
    try:
        if a.describe:print(json.dumps({'tool':'worker-snapshot','host':'Linux with pidfd','read_only':True,'scope':'explicit PID list or descendants of explicit root','automatic_selection':False,'attach':False,'signals':False,'argv_disclosure':False,'module_format':'ELF64 LE'}));return 0
        if sys.platform!='linux' or not hasattr(os,'pidfd_open'):raise SnapshotError('Linux pidfd support required')
        if not a.out or not a.pid and a.root_pid is None:raise SnapshotError('Explicit PID/root and new output path required')
        if a.expected_identity and (not a.pid or len(a.pid)!=1):raise SnapshotError('expected-identity requires one explicit PID')
        if a.socket_inode is not None and a.socket_inode<=0:raise SnapshotError('socket inode must be positive')
        if a.root_pid is not None:
            if a.root_pid<=0:raise SnapshotError('Positive root PID required')
            anchor,candidates=descendants(a.root_pid);scope={'kind':'root_descendants','pid':a.root_pid,'identity':anchor,'atomic':False}
        else:candidates=[(pid,a.expected_identity) for pid in a.pid];scope={'kind':'explicit_pids','atomic':False}
        items=[inspect_pid(pid,expected_identity=expected,exe=a.exe,tokens=a.argv_token,socket_inode=a.socket_inode) for pid,expected in candidates]
        result={'schema':'worker-snapshot-v1','scope':scope,'items':items,'matching_candidates':sum(i['matched'] for i in items),'selected_pid':None,'read_only':True,'target_accepted':None}
        fd=os.open(a.out,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
        with os.fdopen(fd,'w',encoding='utf-8') as f:json.dump(result,f,indent=2);f.write('\n')
        print(json.dumps({'ok':True,'receipt':str(Path(a.out).resolve()),'matching_candidates':result['matching_candidates'],'selected_pid':None,'read_only':True}));return 0
    except (OSError,ValueError) as e:print(json.dumps({'ok':False,'error':str(e),'read_only':True}));return 4
if __name__=='__main__':raise SystemExit(main())
