/** Real native tool/role boundaries; deterministic local adapter, no provider calls. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {spawnSync} from 'node:child_process';
import {fileURLToPath,pathToFileURL} from 'node:url';
const base=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),source=process.env.DSH_ORCHESTRATION_TEST_ROOT??base,native=process.env.DSH_NATIVE_PACKAGE_ROOT,req=createRequire(native+'/package.json');
const fixture=fs.mkdtempSync(path.join(os.tmpdir(),'dsh-knowledge-api-')),home=fixture+'/home',state=home+'/analysis-state',workspace=fixture+'/work';
for(const p of [state,workspace,home+'/skills'])fs.mkdirSync(p,{recursive:true});
for(const name of ['ctf-web','analysis-memory'])fs.cpSync(base+'/skills/'+name,home+'/skills/'+name,{recursive:true});
fs.cpSync(base+'/runtime',home+'/runtime',{recursive:true});fs.writeFileSync(fixture+'/cordis.yml','[]');fs.writeFileSync(fixture+'/hooks.json','{"hooks":{}}');fs.writeFileSync(workspace+'/original.txt','SYNTHETIC reviewed method source.');
const env={PATH:process.env.PATH,HOME:os.homedir(),LANG:'C.UTF-8',DSH_HOME:home,DSH_ANALYSIS_STATE:state};
assert.equal(spawnSync('python3',[home+'/runtime/analysis-v1/session.py','health'],{env}).status,0);
for(const key of Object.keys(process.env))if(!['PATH','HOME','LANG','SYSTEMROOT','TMPDIR','TMP','TEMP','DSH_NATIVE_PACKAGE_ROOT'].includes(key))delete process.env[key];process.env.DSH_HOME=home;process.env.DSH_ANALYSIS_STATE=state;
const {boot,loadOverlayPatches}=await import(pathToFileURL(req.resolve('@deepseek-ai/dsh-app-boot'))),{LlmAdapter}=await import(pathToFileURL(req.resolve('@deepseek-ai/dsh-llm')));
let ctx,handle,task,phase=0,childCalls=0,localError;
function* emit(block,kind='stop'){yield {type:'block-start',index:0,blockType:block.type};if(block.type==='text')yield {type:'text-delta',index:0,text:block.text};else yield {type:'tool-call-delta',index:0,id:block.id,name:block.name,argumentsDelta:block.arguments};yield {type:'block-end',index:0,block};yield {type:'finish',reason:{kind}};}
class Local extends LlmAdapter{
 async *stream(o){try{
  const blocks=o.messages.flatMap(m=>m.content),a=blocks.find(b=>b.type==='text'&&b.text.startsWith('{"task"'));
  if(!a){yield* emit({type:'text',text:'Local synthetic coordinator'});return;}
  childCalls++;assert(!(o.tools??[]).some(t=>t.name==='dsh_knowledge'));assert(!JSON.stringify(blocks).includes('PRIVATE_METHOD_TITLE'));
  if(phase++===0){yield* emit({type:'tool-call',id:randomUUID(),name:'dsh_knowledge',arguments:JSON.stringify({action:'search',task,options:{kind:'method'}})},'tool-calls');return;}
  assert(blocks.filter(b=>b.type==='tool-result').at(-1).isError);yield* emit({type:'text',text:'Completed without mandatory knowledge lookup or new permissions'});
 }catch(e){localError=e;throw e;}}
}
let report;
try{
 const patches=[...loadOverlayPatches('knowledge-api',native+'/node_modules/@deepseek-ai/dsh-base/cordis.patch.yml'),{id:'session-title-llm',disabled:true},{id:'session-telemetry-otel',disabled:true},{insert:[{id:'state',name:pathToFileURL(base+'/plugins/analysis-hooks-sandbox/index.mjs').href,config:{dshHome:home,pluginRoot:base+'/dsh-hooks',configPath:fixture+'/hooks.json',selfTest:false}},{id:'memory',name:pathToFileURL(source+'/plugins/analysis-memory/index.mjs').href,config:{enabled:true,stateRoot:state}},{id:'orchestration',name:pathToFileURL(source+'/plugins/analysis-orchestration/index.mjs').href,config:{enabled:true,stateRoot:state,tickMs:50}}]}];
 ctx=await boot('knowledge-api',fixture+'/cordis.yml',patches,undefined,pathToFileURL(native+'/').href);ctx.llm.registerAdapter(['knowledge-api-local'],new Local());handle=await ctx.agents.create({sessionId:'knowledge-main-'+randomUUID(),meta:{cwd:workspace},agentOptions:{provider:'knowledge-api-local',model:'local'}});await handle.agent.whenIdle();
 const call=async(name,args,error=false)=>{const v=await ctx.tools.execute({name,callId:randomUUID(),agent:handle.agent,arguments:args,signal:new AbortController().signal});if(error){assert(v.isError,JSON.stringify(v));return v;}assert(!v.isError,JSON.stringify(v));return JSON.parse(v.content.filter(b=>b.type==='text').map(b=>b.text).join(''));};
 assert((await call('dsh_knowledge',{action:'schema'})).optional);
 task=(await call('analysis_session',{action:'init',options:{goal:'Synthetic knowledge role boundaries'}})).result.id;
 const mem=(action,options={})=>call('dsh_memory_write',{action,task,options}),know=(action,options={})=>call('dsh_knowledge',{action,task,options}),orch=(action,options={},error=false)=>call('dsh_orchestration',{action,task,options},error);
 await mem('open');const src=await mem('source',{path:'original.txt'});await call('dsh_memory_read',{action:'read_source',task,options:{source_id:src.source_id}});
 const p=await mem('propose',{candidate:{schema_version:'0.2',operation_id:randomUUID(),expected_generation:0,target_id:null,kind:'method_candidate',title:'Private source',body:'Synthetic method candidate only',origin:'inferred',verification:'untested',evidence_refs:[{source_id:src.source_id,locator:'local'}],accept_scope:null,unresolved:['Current target untested'],details:{preconditions:['Exact source available'],failure_boundaries:['No original means unknown'],case_refs:['synthetic'],redaction_status:'reviewed'}}});await mem('review_publish',{id:p.id,expected_revision:1,decision:'publish',reason:'Read synthetic source'});
 const d=await know('draft_method',{record_id:p.id,record_revision:2,redaction_note:'Removed synthetic source identity and paths',card:{title:'PRIVATE_METHOD_TITLE',signals:['Byte mismatch'],aliases:['bytes'],preconditions:['Original bytes available'],procedure:['Compare exact bytes'],verification:['Replay and compare'],failure_boundaries:['No source is inconclusive'],counterexamples:[],uncertainties:['No current target validation'],tags:['synthetic']}});await know('review_method',{id:d.id,expected_revision:1,decision:'publish',reason:'Checked sanitized conditional method'});
 await orch('enable');const refs=await know('search',{query:'登录',kind:'reference'});assert(refs.items.some(v=>v.id==='web-login'));assert(refs.items.every(v=>['ctf-web','analysis-memory'].includes(v.skill)));
 let body='',offset=0,snapshot;do{const v=await know('read_reference',{id:'web-login',offset,max_bytes:2048,...snapshot?{snapshot}:{}});body+=v.text;offset=v.next_offset;snapshot=v.snapshot;}while(offset!==null);assert.equal(body,fs.readFileSync(home+'/skills/ctf-web/references/login-evidence.md','utf8'));
 assert.equal((await know('search',{kind:'method'})).items[0].id,d.id);
 const plan={key:'no-lookup',question:'Verify optional knowledge and private library boundary',success:'Finish without library access',execution_plan:{kind:'materials',requirements:[]},skill_plan:{required:[],none_reason:'Synthetic role check only'}};
 await orch('add',{...plan,key:'no-grant',tools:['dsh_knowledge']},true);const w=await orch('add',plan);await orch('dispatch',{work:[w.id]});let result;
 for(let i=0;i<300;i++){result=await orch('result',{work:w.id,view:'detail'});if(['returned','failed'].includes(result.state))break;await new Promise(r=>setTimeout(r,20));}
 if(localError)throw localError;assert.equal(result.state,'returned',JSON.stringify(result));assert.equal(childCalls,2);assert.equal(result.skill_delivery.state,'not_required');await orch('review',{work:w.id,decision:'adopted',reason:'Boundary and optional lookup verified'});await orch('disable',{reason:'Synthetic acceptance complete'});
 report={ok:true,source,fixture,checks:['Actual native registry limits reference discovery and exact paged reads to available skills','Dedicated coordinator may publish/retrieve optional method cards without execution privileges','Solver receives neither project library contents nor new knowledge permissions; work returns without lookup'],externalModelCalls:0,externalTargetRequests:0,modelAdapter:'deterministic local only'};
}finally{if(handle)await handle.dispose();if(ctx)await ctx.fiber.dispose();}
report.fullTeardownCompleted=true;fs.mkdirSync(base+'/.test-results',{recursive:true});fs.writeFileSync(base+'/.test-results/knowledge-library-native.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
