"""Authored benign fixture; never talks to a network, device or model."""
import os
from pathlib import Path
import subprocess
import sys
import time

mode=sys.argv[1] if len(sys.argv)>1 else 'wait'
if mode=='output':os.write(1,b'ABCD'*10000);os.write(2,b'err\x00end');sys.exit(0)
if mode=='descendant':
    child=subprocess.Popen([sys.executable,'-c','import time; time.sleep(120)'])
    print(child.pid,flush=True);time.sleep(.1);sys.exit(0)
if mode=='fail':print('expected fixture failure');sys.exit(7)
if mode=='count':
    with open(sys.argv[2],'a') as f:f.write('one launch\n')
print('fixture running',flush=True)
time.sleep(120)
