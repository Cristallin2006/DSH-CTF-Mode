/** Boot the actual installer-generated overlay in a fresh native host, no model inference. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const native=process.env.DSH_NATIVE_PACKAGE_ROOT;
assert(native,'Set DSH_NATIVE_PACKAGE_ROOT to your installed DSH package');
const req=createRequire(native+'/package.json');
const fixture=fs.mkdtempSync(path.join(os.tmpdir(),'dsh-setup-native-')),home=fixture+'/home';
const env={...process.env,DSH_HOME:home,DSH_ANALYSIS_STATE:home+'/analysis-state'};
execFileSync('python3',[root+'/tools/setup.py','--mode','full','--home',home,'--apply'],{env});
assert(!fs.existsSync(home+'/analysis-state/state.sqlite3'));
execFileSync('python3',[home+'/runtime/analysis-v1/session.py','health'],{env});
process.env.DSH_HOME=home;
process.env.DSH_ANALYSIS_STATE=home+'/analysis-state';
fs.writeFileSync(fixture+'/cordis.yml','[]');
const {boot,loadOverlayPatches}=await import(pathToFileURL(req.resolve('@deepseek-ai/dsh-app-boot')));
const {LlmAdapter}=await import(pathToFileURL(req.resolve('@deepseek-ai/dsh-llm')));
let calls=0,ctx,handle;
class NoInference extends LlmAdapter{async *stream(){calls++;throw Error('Model inference is forbidden in setup acceptance');}}
try{
  const patches=[...loadOverlayPatches('setup-native',native+'/node_modules/@deepseek-ai/dsh-base/cordis.patch.yml'),
    {id:'session-title-llm',disabled:true},{id:'session-telemetry-otel',disabled:true},
    ...loadOverlayPatches('setup-native',home+'/launch/ctf-orchestration.patch.json')];
  ctx=await boot('setup-native',fixture+'/cordis.yml',patches,undefined,pathToFileURL(native+'/').href);
  ctx.llm.registerAdapter(['setup-local'],new NoInference());
  assert(ctx.get('analysisMemoryBroker'),'Installed memory must be active, not degraded');
  handle=await ctx.agents.create({sessionId:'setup-'+randomUUID(),meta:{cwd:fixture},agentOptions:{provider:'setup-local',model:'local'}});
  await handle.agent.whenIdle();
  for(const [name,args] of [['analysis_session',{action:'health'}],['dsh_memory_read',{action:'health'}],['dsh_orchestration',{action:'schema'}]]){
    const output=await ctx.tools.execute({name,callId:randomUUID(),agent:handle.agent,arguments:args,signal:new AbortController().signal});
    assert(!output.isError,JSON.stringify(output));
    const value=JSON.parse(output.content.filter(b=>b.type==='text').map(b=>b.text).join(''));
    assert.notEqual(value.ok,false,JSON.stringify(value));
  }
  assert.equal(calls,0);
}finally{if(handle)await handle.dispose();if(ctx)await ctx.fiber.dispose();}
assert.equal(calls,0);
console.log(JSON.stringify({ok:true,fixture,checks:['generated overlay boots in real native host','state, memory broker and orchestration tools respond','full teardown'],externalModelCalls:0,modelInferenceCalls:calls}));
