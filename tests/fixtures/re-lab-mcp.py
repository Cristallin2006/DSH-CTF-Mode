"""Owned synthetic stdio server; never connects to a device or a model."""
import json,os,subprocess,sys,time
from pathlib import Path
mode,audit=sys.argv[1],Path(sys.argv[2])
record={'pid':os.getpid(),'requests':[],'provider_secret_inherited':'RE_LAB_SYNTHETIC_PROVIDER_SECRET' in os.environ}
if mode=='grandchild':record['child_pid']=subprocess.Popen([sys.executable,'-c','import time; time.sleep(60)']).pid
def save():audit.write_text(json.dumps(record),encoding='utf-8')
save()
for line in sys.stdin:
    q=json.loads(line);record['requests'].append(q['method']);save()
    if 'id' not in q:continue
    if mode=='timeout':time.sleep(60)
    if mode=='malformed':print('not-json',flush=True);continue
    if mode=='oversized':print('x'*8192,flush=True);continue
    if mode=='nonfinite':print('{"jsonrpc":"2.0","id":1,"result":{"number":NaN}}',flush=True);continue
    if mode=='host-request':print(json.dumps({'jsonrpc':'2.0','id':99,'method':'sampling/createMessage','params':{}}),flush=True);continue
    if q['method']=='initialize':
        result={'protocolVersion':'unsupported' if mode=='version' else q['params']['protocolVersion'],
                'serverInfo':{'name':'synthetic-re-fixture','version':'1'},'capabilities':{'tools':{}}}
    else:
        second='cursor' in q['params']
        name='frida_attach' if not second or mode=='duplicate' else 'frida_spawn'
        result={'tools':[{'name':name,'description':'Synthetic advertised capability, no actual execution','inputSchema':{'type':'object'}}]}
        if not second or mode=='cursor':result['nextCursor']='page2'
    print(json.dumps({'jsonrpc':'2.0','id':True if mode=='bool-id' else q['id'],'result':result}),flush=True)
