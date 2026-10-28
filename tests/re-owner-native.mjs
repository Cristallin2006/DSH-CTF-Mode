/** Native DSH wiring, authored local model adapter and benign processes only. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {execFileSync,spawn} from 'node:child_process';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {expandWork} from './native-client.mjs';
import {ReOwner} from '../plugins/re-workbench/client.mjs';
import {preflight} from '../plugins/analysis-orchestration/planning.mjs';
const base=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),source=process.env.DSH_RE_OWNER_ROOT??base,native=process.env.DSH_NATIVE_PACKAGE_ROOT,req=createRequire(native+'/package.json');
const fixture=fs.mkdtempSync(path.join(os.tmpdir(),'dsh-re-owner-native-')),home=fixture+'/home',state=home+'/analysis-state',workspace=fixture+'/work',ownerRoot=fixture+'/owner';
for(const p of [workspace,home+'/skills',ownerRoot])fs.mkdirSync(p,{recursive:true,mode:0o700});
for(const name of ['re-dynamic','ctf-misc'])fs.cpSync(source+'/skills/'+name,home+'/skills/'+name,{recursive:true});fs.cpSync(source+'/runtime',home+'/runtime',{recursive:true});fs.writeFileSync(fixture+'/cordis.yml','[]');fs.writeFileSync(fixture+'/hooks.json','{"hooks":{}}');
const env={PATH:process.env.PATH,HOME:os.homedir(),LANG:'C.UTF-8',DSH_HOME:home,DSH_ANALYSIS_STATE:state};execFileSync('python3',[home+'/runtime/analysis-v1/session.py','health'],{env});
const python=execFileSync('python3',['-c','import sys; print(sys.executable)'],{encoding:'utf8'}).trim();
fs.writeFileSync(fixture+'/owner-config.json',JSON.stringify({realms:{preview:state},backends:{fixture:{argv:[python,base+'/tests/fixtures/re-owner-local.py'],allow_arguments:true,resources:[{kind:'directory',path:workspace}]}}}));
const log=fs.openSync(fixture+'/owner.log','a'),server=spawn(python,[source+'/skills/re-dynamic/scripts/re_owner.py','serve','--root',ownerRoot,'--config',fixture+'/owner-config.json'],{stdio:['ignore',log,log]});fs.closeSync(log);
const until=async(fn)=>{for(let i=0;i<300;i++){const r=await fn();if(r)return r;await new Promise(d=>setTimeout(d,20));}throw Error('Native fixture did not settle');};
await until(()=>fs.existsSync(ownerRoot+'/owner.sock'));
for(const key of Object.keys(process.env))if(!['PATH','HOME','LANG','SYSTEMROOT','TMPDIR','TMP','TEMP','DSH_NATIVE_PACKAGE_ROOT'].includes(key))delete process.env[key];Object.assign(process.env,env);
const {boot,loadOverlayPatches}=await import(pathToFileURL(req.resolve('@deepseek-ai/dsh-app-boot'))),{LlmAdapter}=await import(pathToFileURL(req.resolve('@deepseek-ai/dsh-llm')));
let ctx,handle,localError,childCalls=0;const phases=new Map(),submitted=new Map(),checks=[];
function* emit(block,kind='stop'){yield {type:'block-start',index:0,blockType:block.type};if(block.type==='text')yield {type:'text-delta',index:0,text:block.text};else yield {type:'tool-call-delta',index:0,id:block.id,name:block.name,argumentsDelta:block.arguments};yield {type:'block-end',index:0,block};yield {type:'finish',reason:{kind}};}
class Local extends LlmAdapter{
 async *stream(o){try{
  const blocks=o.messages.flatMap(m=>m.content),a=blocks.find(b=>b.type==='text'&&b.text.startsWith('{"task"'));
  if(!a){yield* emit({type:'text',text:'Local coordinator receipt'});return;}
  childCalls++;const d=JSON.parse(a.text),phase=phases.get(d.work)??0;phases.set(d.work,phase+1);
  assert((o.tools??[]).some(t=>t.name==='dsh_re_experiment'));assert(!(o.tools??[]).some(t=>['bash','dsh_memory_write'].includes(t.name)));
  const last=blocks.filter(b=>b.type==='tool-result').at(-1),tool=(action,options)=>emit({type:'tool-call',id:randomUUID(),name:'dsh_re_experiment',arguments:JSON.stringify({action,options})},'tool-calls');
  if(phase===0){yield* tool('submit',{operation_id:'one-native-experiment',backend:'fixture',arguments:['wait']});return;}
  if(phase===1){assert(last&&!last.isError,JSON.stringify(last));const j=JSON.parse(last.content.filter(b=>b.type==='text').map(b=>b.text).join(''));submitted.set(d.work,j);yield* emit({type:'text',text:'Managed experiment launched; returning idle does not mean stopped.'});return;}
  if(phase===2){yield* tool('status',{job:submitted.get(d.work).id});return;}
  assert(!last.isError,JSON.stringify(last));const j=JSON.parse(last.content.filter(b=>b.type==='text').map(b=>b.text).join(''));assert(['launching','running'].includes(j.state));yield* emit({type:'text',text:'Same child queried its existing experiment without another launch.'});
 }catch(e){localError=e;throw e;}}
}
try{
 const module=(name,config)=>({id:name,name:pathToFileURL(source+'/plugins/'+name+'/index.mjs').href,config});
 const patches=[...loadOverlayPatches('re-owner-native',native+'/node_modules/@deepseek-ai/dsh-base/cordis.patch.yml'),{id:'session-title-llm',disabled:true},{id:'session-telemetry-otel',disabled:true},{insert:[module('analysis-hooks-sandbox',{dshHome:home,pluginRoot:base+'/dsh-hooks',configPath:fixture+'/hooks.json',selfTest:false}),module('analysis-memory',{enabled:true,stateRoot:state}),module('re-workbench',{enabled:true,stateRoot:state,ownerRoot,realm:'preview'}),module('analysis-orchestration',{enabled:true,stateRoot:state,tickMs:30})]}];
 ctx=await boot('re-owner-native',fixture+'/cordis.yml',patches,undefined,pathToFileURL(native+'/').href);ctx.llm.registerAdapter(['re-owner-local'],new Local());handle=await ctx.agents.create({sessionId:'re-owner-'+randomUUID(),meta:{cwd:workspace},agentOptions:{provider:'re-owner-local',model:'local'}});await handle.agent.whenIdle();
 const raw=(name,args)=>ctx.tools.execute({name,callId:randomUUID(),agent:handle.agent,arguments:args,signal:new AbortController().signal});
 const call=async(name,args)=>{const result=await raw(name,args);assert(!result.isError,JSON.stringify(result));return expandWork(call,args.task,JSON.parse(result.content.filter(b=>b.type==='text').map(b=>b.text).join('')));};
 const task=(await call('analysis_session',{action:'init',options:{goal:'Synthetic managed local experiment lifecycle'}})).result.id;await call('dsh_memory_write',{action:'open',task});const orch=(action,options={})=>call('dsh_orchestration',{action,task,options}),re=(action,options)=>call('dsh_re_experiment',{action,options});await orch('enable');
 const denied=await raw('dsh_re_experiment',{action:'submit',options:{operation_id:'parent','backend':'fixture',arguments:[]}});assert(denied.isError||denied.kind==='deny');checks.push('dedicated coordinator cannot submit experiments');
 const w=await orch('add',{key:'managed-local',question:'Local owner fixture',success:'Inspect persistence and cleanup only',tools:['dsh_re_experiment'],execution_plan:{kind:'resource',requirements:[{purpose:'Managed configured experiment',any_of:['dsh_re_experiment']}]},skill_plan:{required:[{name:'re-dynamic',reason:'Managed experiment scope',references:['references/re-owner.md']}]}});assert(w.preflight.ok,JSON.stringify(w.preflight));
 await orch('dispatch',{work:[w.id]});let result=await until(async()=>{const r=await orch('result',{work:w.id,view:'detail'});return ['returned','failed'].includes(r.state)&&r;});if(localError)throw localError;assert.equal(result.state,'returned',JSON.stringify(result));const job=submitted.get(w.id);assert(job);
 assert(['launching','running'].includes((await re('status',{job:job.id})).state));checks.push('real native child submits under derived scope; idle retains managed experiment');
 const child=result.child;await orch('followup',{work:w.id,message:'Query the same managed experiment; do not submit a replacement'});result=await until(async()=>{const r=await orch('result',{work:w.id,view:'detail'});return ['returned','failed'].includes(r.state)&&r;});if(localError)throw localError;assert.equal(result.state,'returned');assert.equal(result.child,child);assert.equal((await re('list',{})).items.length,1);checks.push('same native Solver follows up and queries the original operation');
 const adapter=new ReOwner({ownerRoot,stateRoot:state,realm:'preview'});assert.throws(()=>adapter.principal({session:{header:{id:'forged',parentSession:'other',origin:'subagent'}}}),/unavailable/);adapter.close();
 const fake={effectiveTools:()=>['skill','dsh_solver_feedback','dsh_re_experiment','bash'],ctx:{get:()=>({}),tools:{get:()=>({})}}};assert.equal(preflight(fake,{role:'solver',execution_plan:w.execution_plan},handle.agent).ok,false);checks.push('resource plans reject generic shell escape; unknown child cannot forge scope');
 await orch('pause',{reason:'Synthetic maintenance'});const cancelled=await re('status',{job:job.id});assert.equal(cancelled.state,'cancelled');checks.push('orchestration pause confirms owner cleanup before returning');
 execFileSync(python,['-c',"import json,hashlib,sys; r=json.load(sys.stdin); h=r.pop('receipt_sha256'); assert hashlib.sha256(json.dumps(r,sort_keys=True,ensure_ascii=True,separators=(',',':'),allow_nan=False).encode()).hexdigest()==h"],{input:JSON.stringify(cancelled.receipt)});checks.push('sealed receipt hash survives Python-to-DSH-to-JSON transport without integer precision loss');
 await orch('resume');
 const second=await orch('add',{key:'managed-cancel',question:'Second local owner fixture',success:'Explicit cancellation only',tools:['dsh_re_experiment'],execution_plan:w.execution_plan,skill_plan:{required:[],none_reason:'Authored lifecycle fixture uses no specialist analysis'}});
 await orch('dispatch',{work:[second.id]});const returned=await until(async()=>{const r=await orch('result',{work:second.id,view:'detail'});return ['returned','failed'].includes(r.state)&&r;});if(localError)throw localError;assert.equal(returned.state,'returned');
 await orch('cancel',{work:second.id,reason:'Explicit idle-work cancellation'});assert.equal((await re('status',{job:submitted.get(second.id).id})).state,'cancelled');checks.push('explicit idle work cancellation drains its own managed experiment');
 await orch('disable',{reason:'Switch to single-agent lifecycle fixture'});
 const solo=await re('submit',{operation_id:'solo-lifecycle',backend:'fixture',arguments:['wait']});await call('analysis_session',{action:'transition',task,options:{status:'paused',data:{summary:'Authored lifecycle fixture'}}});assert.equal((await re('status',{job:solo.id})).state,'cancelled');checks.push('single-agent analysis_session transition uses the existing native lifecycle drain');
 server.kill('SIGTERM');await new Promise(r=>server.once('exit',r));const unavailable=await raw('dsh_re_experiment',{action:'list',options:{}});assert(unavailable.isError);checks.push('owner connection failure is reported without any replay');
}finally{
 if(handle)await handle.dispose();if(ctx)await ctx.fiber.dispose();if(server.exitCode===null&&server.signalCode===null){server.kill('SIGTERM');await new Promise(r=>server.once('exit',r));}
}
const report={ok:true,checks,source,fixture,childCalls,externalModelCalls:0,deviceOperations:0,coverage:'native local owner wiring and authored process groups only'};fs.mkdirSync(base+'/.test-results',{recursive:true});fs.writeFileSync(base+'/.test-results/re-owner-native.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
