import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {spawnSync} from 'node:child_process';
import {fileURLToPath,pathToFileURL} from 'node:url';
const base=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),source=process.env.DSH_ORCHESTRATION_TEST_ROOT??base,native=process.env.DSH_NATIVE_PACKAGE_ROOT,req=createRequire(native+'/package.json');
const fixture=fs.mkdtempSync(path.join(os.tmpdir(),'dsh-map-native-')),home=fixture+'/home',state=home+'/analysis-state',workspace=fixture+'/work';for(const d of [state,workspace,home+'/skills'])fs.mkdirSync(d,{recursive:true});fs.cpSync(base+'/runtime',home+'/runtime',{recursive:true});fs.writeFileSync(fixture+'/cordis.yml','[]');fs.writeFileSync(fixture+'/hooks.json','{"hooks":{}}');fs.writeFileSync(workspace+'/original.txt','SYNTHETIC local config; connectivity not tested.\n');
assert.equal(spawnSync('python3',[home+'/runtime/analysis-v1/session.py','health'],{env:{...process.env,DSH_HOME:home,DSH_ANALYSIS_STATE:state}}).status,0);process.env.DSH_HOME=home;
const {boot,loadOverlayPatches}=await import(pathToFileURL(req.resolve('@deepseek-ai/dsh-app-boot'))),{LlmAdapter}=await import(pathToFileURL(req.resolve('@deepseek-ai/dsh-llm')));
let ctx,handle,task,phase=0,localError,childCalls=0;
function* emit(block,kind){yield {type:'block-start',index:0,blockType:block.type};if(block.type==='text')yield {type:'text-delta',index:0,text:block.text};else yield {type:'tool-call-delta',index:0,id:block.id,name:block.name,argumentsDelta:block.arguments};yield {type:'block-end',index:0,block};yield {type:'finish',reason:{kind}};}
class Local extends LlmAdapter{
 async *stream(o){try{
  const blocks=o.messages.flatMap(m=>m.content),a=blocks.find(b=>b.type==='text'&&b.text.startsWith('{"task"'));
  if(!a){yield* emit({type:'text',text:'Local synthetic coordinator event'},'stop');return;}
  childCalls++;assert(!(o.tools??[]).some(t=>t.name==='dsh_target_map'));assert(!JSON.stringify(blocks.filter(b=>b.type==='text')).includes('PRIVATE_MAP_NODE'));
  if(phase++===0){yield* emit({type:'tool-call',id:randomUUID(),name:'dsh_target_map',arguments:JSON.stringify({action:'view',task})},'tool-calls');return;}
  assert(blocks.filter(b=>b.type==='tool-result').at(-1).isError,'An attempted parent-map call must be refused');yield* emit({type:'text',text:'Parent map remains unavailable to Solver'},'stop');
 }catch(e){localError=e;throw e;}}
}
let report;
try{
 const patches=[...loadOverlayPatches('target-map-native',native+'/node_modules/@deepseek-ai/dsh-base/cordis.patch.yml'),{id:'session-title-llm',disabled:true},{id:'session-telemetry-otel',disabled:true},{insert:[{id:'state',name:pathToFileURL(base+'/plugins/analysis-hooks-sandbox/index.mjs').href,config:{dshHome:home,pluginRoot:base+'/dsh-hooks',configPath:fixture+'/hooks.json',selfTest:false}},{id:'memory',name:pathToFileURL(source+'/plugins/analysis-memory/index.mjs').href,config:{enabled:true,stateRoot:state}},{id:'orchestration',name:pathToFileURL(source+'/plugins/analysis-orchestration/index.mjs').href,config:{enabled:true,stateRoot:state,tickMs:50}}]}];
 ctx=await boot('target-map-native',fixture+'/cordis.yml',patches,undefined,pathToFileURL(native+'/').href);ctx.llm.registerAdapter(['map-local'],new Local());handle=await ctx.agents.create({sessionId:'map-main-'+randomUUID(),meta:{cwd:workspace},agentOptions:{provider:'map-local',model:'local'}});await handle.agent.whenIdle();
 const call=async(name,args,error=false)=>{const v=await ctx.tools.execute({name,callId:randomUUID(),agent:handle.agent,arguments:args,signal:new AbortController().signal});if(error){assert(v.isError,JSON.stringify(v));return v;}assert(!v.isError,JSON.stringify(v));return JSON.parse(v.content.filter(b=>b.type==='text').map(b=>b.text).join(''));};
 assert.equal((await call('dsh_target_map',{action:'health'})).version,1);assert((await call('dsh_target_map',{action:'schema'})).required.put_edge.includes('from_revision'));
 task=(await call('analysis_session',{action:'init',options:{goal:'Check local synthetic authorization only'}})).result.id;const mem=(action,options={})=>call('dsh_memory_write',{action,task,options});await mem('open');const src=await mem('source',{path:'original.txt'});await call('dsh_memory_read',{action:'read_source',task,options:{source_id:src.source_id}});
 const p=await mem('propose',{candidate:{schema_version:'0.2',operation_id:randomUUID(),expected_generation:0,target_id:null,kind:'claim',title:'PRIVATE_MAP_NODE',body:'Configuration only, unknown connectivity',origin:'inferred',verification:'untested',evidence_refs:[{source_id:src.source_id,locator:'line 1'}],accept_scope:null,unresolved:['Actual connection untested'],details:{proposition:'Config mentions a component',conditions:{description:'Local file, no network identity tested',environment_ref:null,analysis_revision_ref:null}}}});await mem('review_publish',{id:p.id,expected_revision:1,decision:'publish',reason:'Read synthetic source; inference only'});
 const map=(action,options={})=>call('dsh_target_map',{action,task,options}),orch=(action,options={},error=false)=>call('dsh_orchestration',{action,task,options},error);
 await map('put_node',{key:'portal',expected_revision:0,kind:'service',record_id:p.id,record_revision:2});await orch('enable');assert.equal((await map('view')).items[0].state,'inferred');
 const plan={key:'local',question:'Verify parent map boundary',success:'Preserve scope',execution_plan:{kind:'materials',requirements:[]},skill_plan:{required:[],none_reason:'Synthetic authorization check'}};
 await orch('add',{...plan,key:'forbidden-map',tools:['dsh_target_map']},true);const w=await orch('add',plan);await orch('dispatch',{work:[w.id]});let settled;
 for(let i=0;i<300;i++){settled=await orch('result',{work:w.id,view:'detail'});if(['returned','failed'].includes(settled.state))break;await new Promise(r=>setTimeout(r,20));}
 if(localError)throw localError;assert.equal(settled.state,'returned',JSON.stringify(settled));assert.equal(childCalls,2);
 await orch('review',{work:w.id,decision:'adopted',reason:'Verified parent-only map boundary'});await orch('disable',{reason:'Synthetic map acceptance complete'});
 report={ok:true,source,fixture,checks:['Actual native host registers the map and allows an enabled strategic coordinator to use it','Explicit map tool grants to Solver are rejected; out-of-list calls fail and child context contains no private map nodes','Deterministic native child returns, is reviewed, and settles before plugin/database disposal'],externalModelCalls:0,externalTargetRequests:0,modelAdapter:'deterministic local only'};
}finally{if(handle)await handle.dispose();if(ctx)await ctx.fiber.dispose();}
report.fullTeardownCompleted=true;fs.mkdirSync(base+'/.test-results',{recursive:true});fs.writeFileSync(base+'/.test-results/target-map-native.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
