#!/usr/bin/env python3
"""Launch a DSH profile with the explicit CTF overlay; no installation or model configuration."""
import argparse
import json
import os
from pathlib import Path
import shutil
import sys


def command(home, profile, from_default=None, extra=()):
    overlay=home/'launch/ctf-mode.patch.json'
    if not overlay.is_file():raise ValueError('Install with setup.py --mode full --preset ctf --apply first')
    rows=json.loads(overlay.read_text(encoding='utf-8'))
    if not isinstance(rows,list) or any(not isinstance(row,dict) or not isinstance(row.get('insert',[]),list) for row in rows):raise ValueError('Invalid CTF overlay')
    entries=[entry for row in rows for entry in row.get('insert',[])]
    if any(not isinstance(entry,dict) or not isinstance(entry.get('id'),str) for entry in entries):raise ValueError('Invalid CTF plugin entry')
    ids=[entry.get('id') for entry in entries]
    if len(ids)!=len(set(ids)) or not {'dsh-ctf-state-adapter','analysis-memory','analysis-orchestration','ctf-mode'}<=set(ids):
        raise ValueError('CTF overlay is missing or duplicating required plugins')
    preset=next(entry for entry in entries if entry['id']=='ctf-mode')
    if preset.get('config',{}).get('enabled') is not True:raise ValueError('CTF preset is disabled')
    if any(value=='--patch' or value.startswith('--patch=') for value in extra):raise ValueError('Do not stack a second --patch over the generated CTF profile')
    result=['dsh','--profile',profile]
    if from_default:result+=['--from-default-profile',from_default]
    return result+['--patch',str(overlay),*extra]


def main(argv=None):
    parser=argparse.ArgumentParser(description=__doc__)
    installed=Path(__file__).resolve().parent
    default_home=installed.parent if installed.name=='launch' else Path.home()/'.dsh'
    parser.add_argument('--home',default=os.environ.get('DSH_HOME',str(default_home)))
    parser.add_argument('--profile',default='ctf')
    parser.add_argument('--from-default-profile')
    parser.add_argument('--check',action='store_true',help='validate launch configuration only; no DSH/model is started')
    args,extra=parser.parse_known_args(argv)
    if extra[:1]==['--']:extra=extra[1:]
    try:
        home=Path(args.home).expanduser().resolve()
        cmd=command(home,args.profile,args.from_default_profile,extra)
        if args.check:
            print(json.dumps({'ok':True,'command':cmd,'scope':'configuration only; actual skill/hook admission is checked by the running host'}));return 0
        executable=shutil.which('dsh')
        if not executable:raise ValueError('DSH executable not found on PATH')
        env={**os.environ,'DSH_HOME':str(home)}
        if sys.platform=='win32':
            raise ValueError('CTF runtime preset requires Linux/WSL native storage; invoke this launcher inside WSL')
        os.execvpe(executable,[executable,*cmd[1:]],env)
    except (ValueError,OSError) as error:
        print(json.dumps({'ok':False,'error':str(error)}));return 2


if __name__=='__main__':raise SystemExit(main())
