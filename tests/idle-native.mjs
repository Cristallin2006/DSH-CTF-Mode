import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {spawnSync} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {fileURLToPath,pathToFileURL} from 'node:url';
fs.mkdirSync(new URL('../.test-results/',import.meta.url),{recursive:true});
const base=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),installed=process.argv.includes('--installed'),source=base,native=process.env.DSH_NATIVE_PACKAGE_ROOT,req=createRequire(native+'/package.json');
const fixture=fs.mkdtempSync(path.join(os.tmpdir(),'dsh-idle-native-')),home=fixture+'/home',state=home+'/analysis-state',workspace=fixture+'/workspace';fs.mkdirSync(state,{recursive:true});fs.mkdirSync(workspace);fs.cpSync(base+'/runtime',home+'/runtime',{recursive:true});fs.copyFileSync(source+'/runtime/analysis-v1/session.py',home+'/runtime/analysis-v1/session.py');fs.writeFileSync(fixture+'/cordis.yml','[]\n');
assert.equal(spawnSync('python3',[home+'/runtime/analysis-v1/session.py','health'],{env:{...process.env,DSH_HOME:home}}).status,0);process.env.DSH_HOME=home;
const {boot,loadOverlayPatches}=await import(pathToFileURL(req.resolve('@deepseek-ai/dsh-app-boot')).href),{LlmAdapter}=await import(pathToFileURL(req.resolve('@deepseek-ai/dsh-llm')).href);
let task,work,phase=0,parentCalls=0,childCalls=0,signature;
function* emit(block,kind){yield {type:'block-start',index:0,blockType:block.type};if(block.type==='text')yield {type:'text-delta',index:0,text:block.text};else yield {type:'tool-call-delta',index:0,id:block.id,name:block.name,argumentsDelta:block.arguments};yield {type:'block-end',index:0,block};yield {type:'finish',reason:{kind}};}
class Local extends LlmAdapter{
 async *stream(o){
  const blocks=o.messages.flatMap(m=>m.content);
  if(blocks.some(b=>b.type==='text'&&b.text.startsWith('{"task"'))){childCalls++;yield* emit({type:'text',text:'The provided input shows a constant output, but does not establish that all paths are equivalent. Further material is needed.'},'stop');return;}
  parentCalls++;assert(parentCalls<=12,'No unlimited coordinator loop');
  const tool=(action,options={})=>emit({type:'tool-call',id:randomUUID(),name:'dsh_orchestration',arguments:JSON.stringify({action,task,options})},'tool-calls');
  if(phase===0){phase++;yield* tool('status');return;}
  if(phase===1){phase++;yield* tool('review',{work,decision:'needs_more_evidence',reason:'The same observed output cannot rule out untested control flow'});return;}
  if(phase===2){phase++;yield* tool('status');return;}
  if(phase===3){
   const texts=blocks.filter(b=>b.type==='tool-result').flatMap(b=>b.content??[]).filter(b=>b.type==='text').map(b=>{try{return JSON.parse(b.text);}catch{return null;}});
   const status=texts.filter(v=>v?.decision_review?.signature).at(-1);assert.equal(status.works[0].state,'needs_more_evidence');signature=status.decision_review.signature;phase++;
   yield* tool('resolve',{expected_signature:signature,resolution:{decision:'deferred',goal_status:'uncertain',summary:'Retain the negative finding as local and defer broader execution',unresolved:[{work,issue:'Untested input paths',disposition:'deferred',reason:'No further provided input or justified experiment yet',next_step:'Resume only with new discriminating material'}]}});return;
  }
  yield* emit({type:'text',text:'Stage report delivered; the broader goal remains unresolved and explicitly deferred.'},'stop');
 }
}
let ctx,handle,db,result;
try{
 const patches=[...loadOverlayPatches('idle-native',native+'/node_modules/@deepseek-ai/dsh-base/cordis.patch.yml'),{id:'session-title-llm',disabled:true},{id:'session-telemetry-otel',disabled:true},{insert:[
  {id:'analysis-state-adapter',name:pathToFileURL(source+'/plugins/analysis-hooks-sandbox/index.mjs').href,config:{dshHome:home,pluginRoot:base+'/dsh-hooks',configPath:base+'/dsh-hooks/hooks.json',selfTest:false}},
  {id:'analysis-memory',name:pathToFileURL(base+'/plugins/analysis-memory/index.mjs').href,config:{enabled:true,stateRoot:state}},
  {id:'analysis-orchestration',name:pathToFileURL(source+'/plugins/analysis-orchestration/index.mjs').href,config:{enabled:true,stateRoot:state,tickMs:40}}
 ]}];
 ctx=await boot('idle-native',fixture+'/cordis.yml',patches,undefined,pathToFileURL(native+'/').href);ctx.llm.registerAdapter(['idle-local'],new Local());
 handle=await ctx.agents.create({sessionId:'idle-main-'+randomUUID(),meta:{cwd:workspace},agentOptions:{provider:'idle-local',model:'local'}});await handle.agent.whenIdle();
 const tool=async(name,args,error=false)=>{const v=await ctx.tools.execute({name,callId:randomUUID(),agent:handle.agent,arguments:args,signal:new AbortController().signal});if(error){assert(v.isError);return;}assert(!v.isError,JSON.stringify(v));return JSON.parse(v.content.filter(b=>b.type==='text').map(b=>b.text).join(''));};
 task=(await tool('analysis_session',{action:'init',options:{goal:'Evaluate whether a constant observed output proves all paths equivalent'}})).result.id;
 await tool('dsh_memory_write',{action:'open',task});await tool('dsh_orchestration',{action:'enable',task,options:{heartbeat_ms:1000}});
 work=(await tool('dsh_orchestration',{action:'add',task,options:{execution_plan:{kind:'materials',requirements:[]},skill_plan:{required:[],none_reason:'Synthetic orchestration fixture has no specialist-method requirement'},key:'coverage',question:'Assess only the provided local output and its coverage limits',success:'Give a scoped conclusion'}})).id;
 await tool('dsh_orchestration',{action:'dispatch',task,options:{work:[work]}});db=new DatabaseSync(state+'/state.sqlite3');
 for(let i=0;i<200;i++){const row=JSON.parse(db.prepare('SELECT data FROM orch_runs WHERE task=?').get(task).data);if(row.resolution_review?.state==='resolved')break;await new Promise(resolve=>setTimeout(resolve,30));}
 let saved=JSON.parse(db.prepare('SELECT data FROM orch_runs WHERE task=?').get(task).data);
 if(saved.resolution_review?.state!=='resolved'){
  const diagnostic={phase,parentCalls,childCalls,state:handle.agent.status,decision:saved.resolution_review,events:handle.agent.session.snapshotEvents(0)};
  fs.writeFileSync(fixture+'/diagnostic.json',JSON.stringify(diagnostic,null,2));throw Error('Native decision incomplete; synthetic diagnostic: '+fixture+'/diagnostic.json');
 }
 assert.equal(saved.resolution_review.resolution.decision,'deferred');assert.equal(saved.resolution_review.resolution.goal_status,'uncertain');await handle.agent.whenIdle();
 const before=parentCalls,childrenBefore=childCalls;await new Promise(resolve=>setTimeout(resolve,1250));assert.equal(parentCalls,before);assert.equal(childCalls,childrenBefore);assert(childCalls>=1);assert.equal(saved.expires,null);assert.equal(saved.max_wakeups,null);
 await tool('dsh_orchestration',{action:'finish',task,options:{reason:'Stop this stage without claiming goal completion'}});
 await tool('analysis_session',{action:'transition',task,options:{status:'complete',data:{summary:'Empty-list bypass',unresolved:[]}}},true);
 await tool('analysis_session',{action:'transition',task,options:{status:'blocked',data:{summary:'Need additional input before broader conclusion',unresolved:['Coverage of unprovided input']}}});
 result={ok:true,installed,checks:['native Solver return wakes the real parent through its inbox','parent uses status/review/status/resolve tools to retain uncertain goal and explicit unresolved work','resolved deferral produces no further model calls or child execution','finish does not permit blank-list completion through the native session adapter; blocked remains available','no default task deadline or wake-up cap'],parentCalls,childCalls,fixture,externalModelCalls:0,externalTargetRequests:0};
}finally{if(db)db.close();if(handle)await handle.dispose();if(ctx)await ctx.fiber.dispose();}
result.fullTeardownCompleted=true;fs.writeFileSync(base+'/.test-results/'+(installed?'installed-idle-native':'idle-native')+'.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
