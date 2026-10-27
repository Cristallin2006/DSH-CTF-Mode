#!/usr/bin/env python3
"""Optional offline/host reverse-engineering helpers; no default device operations."""
import argparse
from email.parser import Parser
import json
import os
from pathlib import Path
import re
import shutil
import sys

from _re_evidence import read_file, read_json, map_address, store_file, verify_record


TOOLS = ('adb','emulator','frida','frida-ps','jadx','java','javac','ghidra-rpc','lldb')


def inspect_python(path):
    p = Path(path).expanduser().absolute()
    root = p.parent.parent if p.parent.name.lower() in ('bin','scripts') else None
    roots = []
    if root is not None and (root/'pyvenv.cfg').is_file():
        roots += [root/'Lib/site-packages']
        lib = root/'lib'
        if lib.is_dir():
            roots += [v/'site-packages' for v in lib.iterdir() if v.name.startswith('python') and v.is_dir()]
    if p == Path(sys.executable).absolute():
        roots += [Path(v) for v in sys.path if v and Path(v).name in ('site-packages','dist-packages')]
    packages = {}
    for name in ('frida','frida_tools','qiling','pyghidra'):
        matches = []
        for package_root in dict.fromkeys(roots):
            if not package_root.is_dir():
                continue
            for item in package_root.iterdir():
                normalized = item.name.lower().replace('-','_')
                if not normalized.startswith(name+'_') or not normalized.endswith('.dist_info'):
                    continue
                metadata = item/'METADATA'
                try:
                    data = Parser().parsestr(read_file(metadata,256*1024).decode('utf-8'))
                    if (data.get('Name') or '').lower().replace('-','_') == name:
                        matches.append({'metadata':str(metadata),'version':data.get('Version'), 'state':'metadata_present'})
                except (OSError,ValueError,UnicodeError):
                    matches.append({'metadata':str(metadata),'state':'unreadable_metadata'})
        packages[name] = {'state':'discovered' if matches else 'not_discovered', 'metadata':matches,
                          'import_tested':False, 'runtime_tested':False}
    return {'path':str(p),'file_present':p.is_file(),'search_scope':'explicit venv/current interpreter package metadata only',
            'packages':packages,'interpreter_executed':False}


def doctor(config=None, python_paths=()):
    config = {} if config is None else config
    if not isinstance(config,dict) or set(config)-{'tools','pythons'}:
        raise ValueError('Discovery config accepts tools and pythons only; no commands or profile loading')
    configured = config.get('tools',{})
    pythons = config.get('pythons',[])
    if not isinstance(configured,dict) or not isinstance(pythons,list) or not all(isinstance(v,str) and v for v in pythons):
        raise ValueError('tools must be an object; pythons an explicit path list')
    for name,path in configured.items():
        if not isinstance(name,str) or not re.fullmatch('[A-Za-z0-9_.-]+',name) or not isinstance(path,str) or not path:
            raise ValueError('Configured tool names and paths must be explicit strings')
    tools = {}
    for name in dict.fromkeys([*TOOLS,*configured]):
        locations = []
        if name in configured:
            p = Path(configured[name]).expanduser().absolute()
            locations.append({'path':str(p),'source':'explicit configuration','file_present':p.is_file()})
        found = shutil.which(name)
        if found and not any(v['path']==found for v in locations):
            locations.append({'path':found,'source':'PATH','file_present':True})
        tools[name] = {'state':'discovered' if any(v['file_present'] for v in locations) else 'not_discovered',
                       'locations':locations,'version_tested':False,'executable_tested':False}
    return {'ok':True,'schema':'dsh-re-discovery-v1','mode':'passive','tools':tools,
            'interpreters':[inspect_python(p) for p in dict.fromkeys([sys.executable,*pythons,*python_paths])],
            'operations':{name:{'state':'not_probed'} for name in ('adb_device_access','frida_attach','frida_spawn','java_observation','native_observation','ghidra_rpc','lldb_attach')},
            'commands_executed':0,'device_queries':0,'services_started':0,
            'authority':'paths and metadata, not runtime capabilities; PATH absence does not establish missing installation',
            'fallbacks':['Existing static or offline analysis remains available','Choose explicit active probes only for the current question']}


def positive(value):
    n = int(value)
    if n <= 0:
        raise argparse.ArgumentTypeError('Expected a positive resource bound')
    return n


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__)
    actions = p.add_subparsers(dest='action',required=True)
    d = actions.add_parser('doctor',help='passive path/metadata discovery; never starts services')
    d.add_argument('--config');d.add_argument('--python',action='append',default=[])
    m = actions.add_parser('map-address',help='offline ELF/Ghidra/runtime coordinate arithmetic')
    m.add_argument('--image',required=True);m.add_argument('--context',required=True)
    m.add_argument('--from',dest='coordinate',choices=['elf_va','ghidra_va','runtime_addr','file_offset'],required=True)
    m.add_argument('--value',required=True);m.add_argument('--max-image',type=positive,default=64*1024*1024)
    seal = actions.add_parser('seal',help='copy an already saved regular file into a private evidence store')
    seal.add_argument('--store',required=True);seal.add_argument('--file',required=True);seal.add_argument('--provenance',required=True)
    seal.add_argument('--max-bytes',type=positive,default=1024*1024*1024)
    verify = actions.add_parser('verify',help='verify a sealed record and complete local file hash without a backend')
    verify.add_argument('--store',required=True);verify.add_argument('--record',required=True)
    verify.add_argument('--max-bytes',type=positive,default=1024*1024*1024)
    backend = actions.add_parser('inspect-stdio',help='explicitly run a trusted MCP command for initialize/tools-list only')
    backend.add_argument('--descriptor',required=True);backend.add_argument('--timeout',type=positive,default=20)
    backend.add_argument('--max-message',type=positive,default=2*1024*1024)
    backend.add_argument('--max-total',type=positive,default=8*1024*1024)
    args = p.parse_args(argv)
    try:
        if args.action=='doctor':
            result = doctor(read_json(args.config) if args.config else {},args.python)
        elif args.action=='map-address':
            result = {'ok':True,**map_address(read_file(args.image,args.max_image),read_json(args.context),args.coordinate,args.value)}
        elif args.action=='seal':
            result = {'ok':True,**store_file(args.store,args.file,read_json(args.provenance),args.max_bytes)}
        elif args.action=='verify':
            result = verify_record(args.store,args.record,args.max_bytes)
        else:
            from re_mcp_probe import inspect_stdio
            result = inspect_stdio(read_json(args.descriptor),args.timeout,args.max_message,args.max_total)
        print(json.dumps(result,ensure_ascii=True,allow_nan=False))
        return 0
    except (OSError,ValueError,TypeError,RecursionError) as error:
        print(json.dumps({'ok':False,'action':args.action,'error':str(error),'device_operations_requested':False},ensure_ascii=True))
        return 2


if __name__=='__main__':
    raise SystemExit(main())
