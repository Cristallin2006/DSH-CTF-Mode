#!/usr/bin/env python3
"""Observe an explicitly launched Windows child using the native debug API.

No attach, elevation, injection, policy changes, symbol downloads or page-heap changes.
Raw stack bytes are evidence, not an unwound call stack. Python 64-bit on Windows x64.
"""
import argparse
import ctypes as C
import hashlib
import json
import math
import os
from pathlib import Path
import shutil
import struct
import subprocess
import time

D=C.c_uint32;W=C.c_uint16;P=C.c_void_p;Z=C.c_size_t;Q=C.c_uint64;B=C.c_int32

class ExceptionRecord(C.Structure):
    _fields_=[('code',D),('flags',D),('record',P),('address',P),('count',D),('information',Z*15)]
class ExceptionInfo(C.Structure):_fields_=[('record',ExceptionRecord),('first_chance',D)]
class CreateInfo(C.Structure):
    _fields_=[('file',P),('process',P),('thread',P),('base',P),('debug_offset',D),('debug_size',D),('tls',P),('start',P),('image_name',P),('unicode',W)]
class LoadInfo(C.Structure):_fields_=[('file',P),('base',P),('debug_offset',D),('debug_size',D),('name',P),('unicode',W)]
class EventData(C.Union):_fields_=[('exception',ExceptionInfo),('create',CreateInfo),('load',LoadInfo),('exit_code',D),('raw',C.c_ubyte*160)]
class Event(C.Structure):_fields_=[('code',D),('pid',D),('tid',D),('data',EventData)]
class Startup(C.Structure):
    _fields_=[('cb',D),('reserved',P),('desktop',P),('title',P),('x',D),('y',D),('width',D),('height',D),('xchars',D),('ychars',D),('fill',D),('flags',D),('show',W),('reserved2size',W),('reserved2',P),('stdin',P),('stdout',P),('stderr',P)]
class StartupEx(C.Structure):_fields_=[('info',Startup),('attributes',P)]
class ProcessInfo(C.Structure):_fields_=[('process',P),('thread',P),('pid',D),('tid',D)]
class Security(C.Structure):_fields_=[('length',D),('descriptor',P),('inherit',B)]

def digest(path):
    h=hashlib.sha256()
    with Path(path).open('rb') as f:
        for b in iter(lambda:f.read(1024*1024),b''):h.update(b)
    return h.hexdigest()

def native_host():
    if not (os.name=='nt' and C.sizeof(P)==8):return False
    try:
        kernel=C.WinDLL('kernel32');kernel.GetNativeSystemInfo.argtypes=[P];kernel.GetNativeSystemInfo.restype=None
        info=C.create_string_buffer(48);kernel.GetNativeSystemInfo(info)
        return struct.unpack_from('<H',info)[0]==9 and not hasattr(C.WinDLL('ntdll'),'wine_get_version')
    except OSError:return False

def machine(path):
    with Path(path).open('rb') as f:
        header=f.read(64)
        if len(header)!=64 or header[:2]!=b'MZ':raise ValueError('Native debug requires a PE image')
        f.seek(struct.unpack_from('<I',header,60)[0]);signature=f.read(24)
    if len(signature)!=24 or signature[:4]!=b'PE\0\0':raise ValueError('Invalid PE signature/header')
    value=struct.unpack_from('<H',signature,4)[0]
    if value not in (0x14c,0x8664):raise ValueError('Only x86/WOW64 and x64 children supported')
    characteristics=struct.unpack_from('<H',signature,22)[0]
    if not characteristics&2 or characteristics&0x2000:raise ValueError('Need an executable image; DLL analysis requires an explicit executable harness')
    return value

class API:
    def __init__(self):
        if not native_host():raise ValueError('Use 64-bit Windows Python on an x64 Windows host; no implicit WSL interop')
        assert C.sizeof(Event)==176 and Event.data.offset==16 and C.sizeof(StartupEx)==112
        self.k=C.WinDLL('kernel32',use_last_error=True)
        specs={'CloseHandle':([P],B),'CreateFileW':([C.c_wchar_p,D,D,P,D,D,P],P),'InitializeProcThreadAttributeList':([P,D,D,C.POINTER(Z)],B),'UpdateProcThreadAttribute':([P,D,Z,P,Z,P,P],B),'DeleteProcThreadAttributeList':([P],None),'CreateProcessW':([C.c_wchar_p,P,P,P,B,D,P,C.c_wchar_p,P,C.POINTER(ProcessInfo)],B),'WaitForDebugEvent':([C.POINTER(Event),D],B),'ContinueDebugEvent':([D,D,D],B),'GetExitCodeProcess':([P,C.POINTER(D)],B),'TerminateProcess':([P,D],B),'WaitForSingleObject':([P,D],D),'GetFinalPathNameByHandleW':([P,P,D,D],D),'OpenThread':([D,B,D],P),'GetThreadContext':([P,P],B),'ReadProcessMemory':([P,P,P,Z,C.POINTER(Z)],B),'GetProcessMitigationPolicy':([P,D,P,Z],B),'OpenProcess':([D,B,D],P)}
        for name,(args,result) in specs.items():
            fn=getattr(self.k,name);fn.argtypes=args;fn.restype=result
        if hasattr(self.k,'Wow64GetThreadContext'):
            self.k.Wow64GetThreadContext.argtypes=[P,P];self.k.Wow64GetThreadContext.restype=B
        self.k.IsWow64Process.argtypes=[P,C.POINTER(B)];self.k.IsWow64Process.restype=B
        if hasattr(self.k,'IsWow64Process2'):
            self.k.IsWow64Process2.argtypes=[P,C.POINTER(W),C.POINTER(W)];self.k.IsWow64Process2.restype=B
            self.k.GetCurrentProcess.argtypes=[];self.k.GetCurrentProcess.restype=P
            self.process_arch(self.k.GetCurrentProcess())
    def check(self,result,operation):
        if not result:raise OSError(C.get_last_error(),operation+' failed')
        return result
    def close(self,h):
        if h and h!=C.c_void_p(-1).value:self.k.CloseHandle(h)
    def file_name(self,h):
        if not h:return None
        value=C.create_unicode_buffer(32768);n=self.k.GetFinalPathNameByHandleW(h,value,len(value),0)
        return value.value if 0<n<len(value) else None
    def process_arch(self,h):
        if hasattr(self.k,'IsWow64Process2'):
            process,native=W(),W();self.check(self.k.IsWow64Process2(h,C.byref(process),C.byref(native)),'Query actual process architecture')
            if native.value!=0x8664:raise ValueError('Native host architecture is not x64; ARM/emulated-host debugging is not supported')
            actual=process.value or native.value
        else:
            wow=B();self.check(self.k.IsWow64Process(h,C.byref(wow)),'Query WOW64 state');actual=0x14c if wow.value else 0x8664
        if actual not in (0x14c,0x8664):raise ValueError('Unsupported actual process architecture')
        return actual
    def policies(self,process):
        definitions={
            'dep':(0,8,['enable','disable_atl_thunk_emulation']),
            'aslr':(1,4,['bottom_up','force_relocate','high_entropy','disallow_stripped']),
            'dynamic_code':(2,4,['prohibit_dynamic_code','allow_thread_opt_out','allow_remote_downgrade','audit']),
            'cfg':(7,4,['enable','export_suppression','strict_mode','xfg','xfg_audit']),
            'signature':(8,4,['microsoft_signed_only','store_signed_only','opt_in','audit_microsoft','audit_store']),
            'image_load':(10,4,['no_remote_images','no_low_integrity_images','prefer_system32']),
            'user_shadow_stack':(15,4,['enable','audit','set_context_ip_validation','audit_set_context','strict_mode','block_non_cet','block_non_cet_non_ehcont','audit_block_non_cet','dynamic_apis_out_of_proc','relaxed_ip_validation']),
            'sehop':(18,4,['enable','audit'])}
        out={}
        for name,(kind,size,names) in definitions.items():
            buf=C.create_string_buffer(size)
            if self.k.GetProcessMitigationPolicy(process,kind,buf,size):
                value=struct.unpack_from('<I',buf)[0];out[name]={'state':'observed','raw_flags':value,'flags':{n:bool(value&(1<<i)) for i,n in enumerate(names)}}
            else:out[name]={'state':'unknown','winerror':C.get_last_error(),'reason':'Query unsupported or unavailable; never infer disabled'}
        return {'state':'queried','source':'GetProcessMitigationPolicy','policies':out,'scope':'Reported policy at this process snapshot; not exploitability or proof of hardware behavior'}
    def context(self,process,tid,arch,stack_bytes):
        thread=self.k.OpenThread(0x48,False,tid)
        if not thread:return {'state':'unavailable','winerror':C.get_last_error()}
        try:
            if arch==0x8664:
                raw=C.create_string_buffer(1248);address=(C.addressof(raw)+15)&~15;C.c_uint32.from_address(address+48).value=0x100003
                fn=self.k.GetThreadContext;offsets={name:off for name,off in zip(['rax','rcx','rdx','rbx','rsp','rbp','rsi','rdi','r8','r9','r10','r11','r12','r13','r14','r15','rip'],range(120,256,8))};fmt='<Q';sp='rsp'
            else:
                raw=C.create_string_buffer(736);address=(C.addressof(raw)+15)&~15;C.c_uint32.from_address(address).value=0x10007
                fn=getattr(self.k,'Wow64GetThreadContext',None);offsets={'edi':156,'esi':160,'ebx':164,'edx':168,'ecx':172,'eax':176,'ebp':180,'eip':184,'esp':196};fmt='<I';sp='esp'
            if fn is None or not fn(thread,address):return {'state':'unavailable','winerror':C.get_last_error()}
            body=C.string_at(address,1232 if arch==0x8664 else 716);registers={n:struct.unpack_from(fmt,body,off)[0] for n,off in offsets.items()}
            buf=C.create_string_buffer(stack_bytes);read=Z();ok=self.k.ReadProcessMemory(process,registers[sp],buf,stack_bytes,C.byref(read))
            return {'state':'observed','architecture':'x64' if arch==0x8664 else 'x86-wow64','registers':registers,'stack_snapshot':{'address':registers[sp],'requested_bytes':stack_bytes,'read_bytes':read.value,'hex':buf.raw[:read.value].hex(),'state':'observed' if ok else 'partial' if read.value else 'unavailable','winerror':None if ok else C.get_last_error()},'unwound_call_stack':'not-collected; raw stack is not a validated call chain'}
        finally:self.close(thread)

def observe(sample,arguments,out,timeout=15,max_events=1024,stack_bytes=256,stdin_path=None):
    api=API();sample=Path(sample).resolve(strict=True);arch=machine(sample);before=digest(sample)
    out=Path(out).absolute();out.mkdir(parents=True,exist_ok=False)
    handles=[];attributes=None;pi=ProcessInfo();pending=None;exited=False;started=time.monotonic()
    result={'schema':'windows-debug-observation-v1','backend':'native-debug-api','sample':str(sample),'sample_sha256':before,'argv':arguments,'interventions':['debugger attached from process creation','initial debugger breakpoint continued; other exceptions passed to application'],'timeout_seconds':timeout,'max_events':max_events,'events':[],'modules':[],'target_accepted':None,'cleanup':{'state':'pending'},'execution_status':'not_started'}
    try:
        stdin_name='NUL'
        if stdin_path is not None:
            original=Path(stdin_path).resolve(strict=True)
            if not original.is_file():raise ValueError('stdin-file must be a regular file')
            original_hash=digest(original);snapshot=out/'stdin.bin';shutil.copyfile(original,snapshot)
            if digest(snapshot)!=original_hash or digest(original)!=original_hash:raise ValueError('Input changed while making stdin snapshot')
            stdin_name=str(snapshot);result['stdin']={'source':str(original),'sha256':original_hash,'bytes':snapshot.stat().st_size,'delivery':'Read-only snapshot assigned to child stdin; consumption is not inferred'};result['interventions'].append('stdin redirected to explicit file snapshot')
        else:result['stdin']={'delivery':'NUL; no input file supplied'}
        security=Security(C.sizeof(Security),None,True)
        for name,access in [('stdin',0x80000000),('stdout.bin',0x40000000),('stderr.bin',0x40000000)]:
            handle=api.k.CreateFileW(stdin_name if name=='stdin' else str(out/name),access,1,C.byref(security),3 if name=='stdin' else 1,0x80,None)
            if handle==C.c_void_p(-1).value:raise OSError(C.get_last_error(),'Cannot open child I/O')
            handles.append(handle)
        size=Z();api.k.InitializeProcThreadAttributeList(None,1,0,C.byref(size));attributes=C.create_string_buffer(size.value);api.check(api.k.InitializeProcThreadAttributeList(attributes,1,0,C.byref(size)),'Initialize attributes')
        inherited=(P*len(handles))(*handles);api.check(api.k.UpdateProcThreadAttribute(attributes,0,0x20002,inherited,C.sizeof(inherited),None,None),'Set explicit handle list')
        startup=StartupEx();startup.info.cb=C.sizeof(startup);startup.info.flags=0x100;startup.info.stdin,startup.info.stdout,startup.info.stderr=handles;startup.attributes=C.cast(attributes,P)
        command=C.create_unicode_buffer(subprocess.list2cmdline([str(sample),*arguments]))
        api.check(api.k.CreateProcessW(str(sample),command,None,None,True,0x2|0x80000|0x8000000,None,str(sample.parent),C.byref(startup),C.byref(pi)),'Create debug child')
        result.update(pid=pi.pid,execution_status='running',file_machine=arch);arch=api.process_arch(pi.process);result['actual_process_machine']=arch;first_break=True
        api.k.DeleteProcThreadAttributeList(attributes);attributes=None
        for h in handles:api.close(h)
        handles=[]
        while True:
            if timeout and time.monotonic()-started>=timeout:result['execution_status']='interrupted';result['stop_reason']='experiment_timeout';break
            if len(result['events'])>=max_events:result['execution_status']='interrupted';result['stop_reason']='event_capture_limit';break
            event=Event()
            if not api.k.WaitForDebugEvent(C.byref(event),100):
                if C.get_last_error()==121:continue
                raise OSError(C.get_last_error(),'WaitForDebugEvent failed')
            pending=(event.pid,event.tid);item={'event':event.code,'pid':event.pid,'tid':event.tid};continuation=0x10002
            if event.code==3:
                item['image_base']=event.data.create.base;item['path']=api.file_name(event.data.create.file);api.close(event.data.create.file)
                result['modules'].append({'base':item['image_base'],'path':item['path'],'kind':'main-image'});result['initial_process_policy']=api.policies(pi.process)
            elif event.code==6:
                item.update(base=event.data.load.base,path=api.file_name(event.data.load.file));api.close(event.data.load.file);result['modules'].append({'base':item['base'],'path':item['path'],'kind':'dll'})
            elif event.code==1:
                info=event.data.exception;item.update(exception_code=info.record.code,exception_address=info.record.address,first_chance=bool(info.first_chance),exception_flags=info.record.flags)
                item['context']=api.context(pi.process,event.tid,arch,stack_bytes)
                item['process_policy']=api.policies(pi.process)
                if first_break and info.first_chance and info.record.code in (0x80000003,0x4000001f):
                    first_break=False;item['continuation']='initial-debugger-breakpoint-assumption'
                else:continuation=0x80010001;item['continuation']='exception-not-handled-by-debugger'
            elif event.code==5:
                item['exit_code']=event.data.exit_code;result.update(execution_status='exited',exit_code=event.data.exit_code)
            result['events'].append(item);api.check(api.k.ContinueDebugEvent(event.pid,event.tid,continuation),'Continue event');pending=None
            if event.code==5:exited=True
            if exited:break
    except KeyboardInterrupt:
        result['execution_status']='interrupted';result['stop_reason']='caller_interrupt'
    except (OSError,ValueError) as error:
        result['execution_status']='failed';result['error']=str(error)
    finally:
        if attributes is not None:api.k.DeleteProcThreadAttributeList(attributes)
        for h in handles:api.close(h)
        if pi.process:
            cleanup_errors=[]
            if not exited:
                if not api.k.TerminateProcess(pi.process,0xdead):cleanup_errors.append({'operation':'terminate-own-child','winerror':C.get_last_error()})
                if pending:
                    if not api.k.ContinueDebugEvent(*pending,0x80010001):cleanup_errors.append({'operation':'continue-pending-event','winerror':C.get_last_error()})
                # Drain exit events so the debuggee can actually finish. Never enumerate/kill descendants.
                until=time.monotonic()+5
                while time.monotonic()<until:
                    event=Event()
                    if api.k.WaitForDebugEvent(C.byref(event),50):
                        if event.code==6:api.close(event.data.load.file)
                        if event.code==3:api.close(event.data.create.file)
                        api.k.ContinueDebugEvent(event.pid,event.tid,0x10002)
                        if event.code==5:break
                    if api.k.WaitForSingleObject(pi.process,0)==0:break
            stopped=api.k.WaitForSingleObject(pi.process,1000)==0
            result['cleanup']={'state':'confirmed' if stopped and not cleanup_errors else 'unconfirmed','child_pid':pi.pid,'errors':cleanup_errors,'scope':'Only this launched process; descendants are neither debugged nor terminated'}
            api.close(pi.thread);api.close(pi.process)
        else:result['cleanup']={'state':'not_started'}
    try:result['sample_sha256_after']=digest(sample)
    except OSError as error:result['sample_sha256_after']=None;result['sample_recheck_error']=str(error)
    result['sample_file_unchanged']=before==result['sample_sha256_after'];result['elapsed_seconds']=time.monotonic()-started
    result['artifacts']=[{'path':str(out/name),'sha256':digest(out/name),'bytes':(out/name).stat().st_size} for name in ('stdin.bin','stdout.bin','stderr.bin') if (out/name).is_file()]
    result['ok']=result['execution_status']=='exited' and result['cleanup']['state']=='confirmed' and result['sample_file_unchanged']
    # ok means the observation completed; an exception exit may be the observed result.
    (out/'receipt.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n',encoding='utf-8');return result

def main(argv=None):
    ap=argparse.ArgumentParser(description=__doc__);ap.add_argument('--describe',action='store_true');ap.add_argument('--check',action='store_true');ap.add_argument('--pid',type=int);ap.add_argument('--out');ap.add_argument('--stdin-file');ap.add_argument('--timeout',type=float,default=15);ap.add_argument('--max-events',type=int,default=1024);ap.add_argument('--stack-bytes',type=int,default=256);ap.add_argument('sample',nargs='?');ap.add_argument('arguments',nargs=argparse.REMAINDER);a=ap.parse_args(argv)
    try:
        if a.describe:
            print(json.dumps({'tool':'windows-debug','backend':'native Windows debug API','host':'Windows x64, 64-bit Python','targets':['x64','x86-WOW64'],'execute_default':False,'modes':['--describe','--check SAMPLE','--pid PID (policy query only)','--out NEW_DIRECTORY SAMPLE [args...]'],'no_attach':True,'no_policy_changes':True,'stack':'raw bytes, not unwound call stack','target_accepted':None}));return 0
        if not math.isfinite(a.timeout) or a.timeout<0 or not 1<=a.max_events or not 1<=a.stack_bytes<=65536:raise ValueError('Invalid capture budget; timeout=0 permits no experiment deadline')
        if a.pid is not None:
            if a.pid<=0 or a.sample or a.out or a.arguments or a.check or a.stdin_file:raise ValueError('Use --pid alone for a read-only policy query')
            api=API();h=api.check(api.k.OpenProcess(0x400,False,a.pid),'OpenProcess for policy query')
            try:result={'ok':True,'pid':a.pid,'process_policy':api.policies(h),'execution':False,'target_accepted':None}
            finally:api.close(h)
        elif a.check:
            if not a.sample or a.out:raise ValueError('--check requires SAMPLE and does not create output')
            ready=native_host()
            if ready:API()
            result={'ok':ready,'state':'ready' if ready else 'unsupported_host','machine':machine(a.sample),'sample_sha256':digest(a.sample),'execution':False,'target_accepted':None}
            if a.stdin_file:
                p=Path(a.stdin_file).resolve(strict=True)
                if not p.is_file():raise ValueError('stdin-file must be a regular file')
                result['stdin_file']={'sha256':digest(p),'bytes':p.stat().st_size,'state':'readable'}
        else:
            if not a.sample or not a.out:raise ValueError('Execution requires explicit --out NEW_DIRECTORY and SAMPLE; adapter options precede sample')
            result=observe(a.sample,a.arguments,a.out,a.timeout,a.max_events,a.stack_bytes,a.stdin_file)
        if 'events' in result:
            summary={k:result.get(k) for k in ('ok','execution_status','stop_reason','pid','exit_code','cleanup','sample_sha256','sample_file_unchanged','target_accepted')};summary.update(receipt=str(Path(a.out).absolute()/'receipt.json'),event_count=len(result['events']),full_evidence_in_receipt=True)
            print(json.dumps(summary,ensure_ascii=False))
        else:print(json.dumps(result,ensure_ascii=False))
        return 0 if result['ok'] else 3
    except (OSError,ValueError) as error:
        print(json.dumps({'ok':False,'state':'unavailable','error':str(error),'target_accepted':None},ensure_ascii=False));return 4

if __name__=='__main__':raise SystemExit(main())
