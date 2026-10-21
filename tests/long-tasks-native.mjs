import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {spawnSync} from 'node:child_process';
import {fileURLToPath,pathToFileURL} from 'node:url';
const base=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),source=process.env.DSH_ORCHESTRATION_TEST_ROOT??base,native=process.env.DSH_NATIVE_PACKAGE_ROOT,req=createRequire(native+'/package.json');
const fixture=fs.mkdtempSync(path.join(os.tmpdir(),'dsh-long-native-')),home=fixture+'/home',state=home+'/analysis-state',workspace=fixture+'/work';for(const p of [state,workspace,home+'/skills'])fs.mkdirSync(p,{recursive:true});fs.cpSync(base+'/runtime',home+'/runtime',{recursive:true});fs.copyFileSync(source+'/runtime/analysis-v1/session.py',home+'/runtime/analysis-v1/session.py');fs.writeFileSync(fixture+'/cordis.yml','[]');fs.writeFileSync(fixture+'/hooks.json','{"hooks":{}}');
const rawFile=Buffer.from('SYNTHETIC FILE 中😀\n'.repeat(220000)+'FILE_TAIL');fs.writeFileSync(workspace+'/big-input.txt',rawFile);assert(rawFile.length>2*1024*1024);const fileHash=createHash('sha256').update(rawFile).digest('hex');
const goal='GOAL_START\n'+'Long goal 中😀\n'.repeat(2500)+'GOAL_TAIL',question='QUESTION_START\n'+'Exact instructions 中😀\n'.repeat(2500)+'FULL_QUESTION_TAIL',followup='FOLLOWUP_START\n'+'Additional original instructions 中😀\n'.repeat(1300)+'FOLLOWUP_TAIL',answer='Complete result 中😀\n'.repeat(5000)+'FULL_RESULT_TAIL';
const handoff={inputs:[{ref:'big-input.txt',description:'Explicitly assigned synthetic file; use the granted fixture reader'}],claims:Array.from({length:12},(_,i)=>({statement:'Reported hypothesis '+i+' '+('中'.repeat(800)),verification:'untested',conditions:'Synthetic only'})),constraints:['CRITICAL_KEEP_SCOPE: only supplied local materials'],responsibility:'Read supplied originals and preserve uncertainty'};
assert.equal(spawnSync('python3',[home+'/runtime/analysis-v1/session.py','health'],{env:{...process.env,DSH_HOME:home,DSH_ANALYSIS_STATE:state}}).status,0);process.env.DSH_HOME=home;
const {boot,loadOverlayPatches}=await import(pathToFileURL(req.resolve('@deepseek-ai/dsh-app-boot'))),{LlmAdapter}=await import(pathToFileURL(req.resolve('@deepseek-ai/dsh-llm')));
const states=new Map(),modes=new Map(),references=new Map();let ctx,handle,task,localError,fileReads=0;
function* emit(block,kind){yield {type:'block-start',index:0,blockType:block.type};if(block.type==='text')yield {type:'text-delta',index:0,text:block.text};else yield {type:'tool-call-delta',index:0,id:block.id,name:block.name,argumentsDelta:block.arguments};yield {type:'block-end',index:0,block};yield {type:'finish',reason:{kind}};}
class Local extends LlmAdapter{
 async *stream(o){try{
  const blocks=o.messages.flatMap(m=>m.content),a=blocks.find(b=>b.type==='text'&&b.text.startsWith('{"task"'));
  if(!a){yield* emit({type:'text',text:'Synthetic coordinator event'},'stop');return;}
  const d=JSON.parse(a.text),tool=(name,args)=>emit({type:'tool-call',id:randomUUID(),name,arguments:JSON.stringify(args)},'tool-calls'),last=()=>blocks.filter(b=>b.type==='tool-result').at(-1),read=()=>JSON.parse(last().content.filter(b=>b.type==='text').map(b=>b.text).join(''));
  references.set(d.work,d.assignment_materials?.[0]);
  if(modes.get(d.work)==='skip'){yield* emit({type:'text',text:'Pretend completion without reading'},'stop');return;}
  let s=states.get(d.work);
  if(!s){assert(!a.text.includes('FULL_QUESTION_TAIL'));assert(a.text.includes('CRITICAL_KEEP_SCOPE'));s={stage:'guard',packets:d.assignment_materials.filter(p=>p.required_read),index:0,offset:0,text:''};states.set(d.work,s);}
  if(s.stage==='done'){
    const wrapper=blocks.filter(b=>b.type==='text'&&b.text.startsWith('[DSH full followup material] ')).at(-1);assert(wrapper,'Large followup must have its own full material reference');const p=JSON.parse(wrapper.text.slice('[DSH full followup material] '.length));s={stage:'guard',packets:[p],index:0,offset:0,text:'',followup:true};states.set(d.work,s);
  }
  if(s.stage==='guard'){s.reads=fileReads;s.stage='guard-result';yield* tool('fixture_file_digest',{path:'big-input.txt'});return;}
  if(s.stage==='guard-result'){assert(last().isError,'Execution must wait for required assignment text');assert.equal(fileReads,s.reads);s.stage='foreign-result';const other=[...references].find(([id])=>id!==d.work)?.[1];assert(other);yield* tool('dsh_solver_feedback',{action:'read_material',packet_id:other.packet_id,expected_hash:other.sha256});return;}
  if(s.stage==='foreign-result'){assert(last().isError,'Another work packet must remain unavailable');s.stage='read';}
  if(s.stage==='read-result'){
    const p=read(),part=s.packets[s.index];assert(Buffer.byteLength(JSON.stringify(p))<=8192);assert.equal(p.sha256,part.sha256);s.text+=p.result;
    if(p.next_offset!==null){s.offset=p.next_offset;s.snapshot=p.snapshot;s.stage='read';}
    else{assert(p.read_coverage.full);if(part.kind==='task_question')assert.equal(s.text,question);if(part.kind==='recorded_goal')assert.equal(s.text,goal);if(part.kind==='handoff'){const h=JSON.parse(s.text);assert(h.claims.at(-1).statement.endsWith('中'.repeat(800)));assert(h.inputs[0].ref==='big-input.txt');}if(part.kind.startsWith('followup:'))assert.equal(s.text,followup);s.index++;s.offset=0;s.snapshot=undefined;s.text='';s.stage='read';}
  }
  if(s.stage==='read'){
    if(s.index<s.packets.length){const p=s.packets[s.index];s.stage='read-result';yield* tool('dsh_solver_feedback',{action:'read_material',packet_id:p.packet_id,expected_hash:p.sha256,offset:s.offset,max_bytes:8192,...s.snapshot?{snapshot:s.snapshot}:{}});return;}
    s.stage='file-result';yield* tool('fixture_file_digest',{path:'big-input.txt'});return;
  }
  if(s.stage==='file-result'){const v=read();assert.equal(v.sha256,fileHash);assert.equal(v.bytes,rawFile.length);assert(v.has_tail);s.stage='done';yield* emit({type:'text',text:answer},'stop');return;}
  throw Error('Unexpected local material phase '+s.stage);
 }catch(e){localError=e;throw e;}}
}
let report;
try{
 const patches=[...loadOverlayPatches('long-native',native+'/node_modules/@deepseek-ai/dsh-base/cordis.patch.yml'),{id:'session-title-llm',disabled:true},{id:'session-telemetry-otel',disabled:true},{insert:[{id:'state',name:pathToFileURL(base+'/plugins/analysis-hooks-sandbox/index.mjs').href,config:{dshHome:home,pluginRoot:base+'/dsh-hooks',configPath:fixture+'/hooks.json',selfTest:false}},{id:'memory',name:pathToFileURL(source+'/plugins/analysis-memory/index.mjs').href,config:{enabled:true,stateRoot:state}},{id:'orchestration',name:pathToFileURL(source+'/plugins/analysis-orchestration/index.mjs').href,config:{enabled:true,stateRoot:state,tickMs:50}}]}];
 ctx=await boot('long-native',fixture+'/cordis.yml',patches,undefined,pathToFileURL(native+'/').href);ctx.llm.registerAdapter(['long-local'],new Local());
 ctx.tools.register({name:'fixture_file_digest',description:'Read the explicitly assigned local synthetic file only',parameters:{type:'object',properties:{path:{const:'big-input.txt'}},required:['path'],additionalProperties:false},output:{schema:{type:'string'},render(_a,v){return [{type:'text',text:v}];}},async execute(args){assert.equal(args.path,'big-input.txt');fileReads++;const bytes=fs.readFileSync(workspace+'/big-input.txt');return JSON.stringify({bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),has_tail:bytes.subarray(-9).toString()==='FILE_TAIL'});}});
 handle=await ctx.agents.create({sessionId:'long-main-'+randomUUID(),meta:{cwd:workspace},agentOptions:{provider:'long-local',model:'local'}});await handle.agent.whenIdle();
 const call=async(name,args,error=false)=>{const v=await ctx.tools.execute({name,callId:randomUUID(),agent:handle.agent,arguments:args,signal:new AbortController().signal});if(error){assert(v.isError,JSON.stringify(v));return v;}assert(!v.isError,JSON.stringify(v));return JSON.parse(v.content.filter(b=>b.type==='text').map(b=>b.text).join(''));};
 task=(await call('analysis_session',{action:'init',options:{goal,data:{constraints:{authorization:'Only supplied synthetic files'}}}})).result.id;await call('dsh_memory_write',{action:'open',task});const orch=(action,options={},error=false)=>call('dsh_orchestration',{action,task,options},error);await orch('enable');
 const add=(key,more={})=>orch('add',{key,question,success:'Read complete originals and preserve exact text',tools:['fixture_file_digest'],execution_plan:{kind:'execution',requirements:[{purpose:'Read supplied local file',any_of:['fixture_file_digest']}]},skill_plan:{required:[],none_reason:'Synthetic transmission/authorization test'},handoff,...more});
 const wait=async id=>{for(let i=0;i<1500;i++){const w=await orch('result',{work:id,view:'detail'});if(['returned','failed'].includes(w.state)){if(localError)throw localError;return w;}await new Promise(r=>setTimeout(r,20));}throw localError??Error('Synthetic material turn did not settle');};
 const skip=await add('skip');modes.set(skip.id,'skip');await orch('dispatch',{work:[skip.id]});const failed=await wait(skip.id);assert.equal(failed.state,'failed');assert(failed.diagnostic.includes('not fully read'));assert.equal(fileReads,0);
 const w=await add('full');await orch('dispatch',{work:[w.id]});let result=await wait(w.id);assert.equal(result.state,'returned');assert(result.result_preview_truncated);assert(!result.result_truncated);assert.equal(result.material_delivery.state,'read');
 let documentOffset=0,documentSnapshot,documentParts=[];do{const p=await orch('work_document',{work:w.id,offset:documentOffset,max_bytes:8192,...documentSnapshot?{snapshot:documentSnapshot}:{}});assert(Buffer.byteLength(JSON.stringify(p))<=8192);documentParts.push(p.result);documentSnapshot=p.snapshot;documentOffset=p.next_offset;}while(documentOffset!==null);assert.equal(JSON.parse(documentParts.join('')).question,question);
 const originalChild=result.child;await orch('review',{work:w.id,decision:'adopted',reason:'Exact full material and result transmission verified'});
 await orch('followup',{work:w.id,message:followup});result=await wait(w.id);assert.equal(result.state,'returned');assert.equal(result.child,originalChild);assert.equal(result.result_revision,2);
 let offset=0,parts=[];do{const p=await orch('result',{work:w.id,offset,max_bytes:8192,expected_revision:2});assert(Buffer.byteLength(JSON.stringify(p))<=8192);parts.push(p.result);offset=p.next_offset;}while(offset!==null);assert.equal(parts.join(''),answer);await orch('review',{work:w.id,decision:'adopted',reason:'Same child received full long followup and returned full long result'});
 modes.set(skip.id,'normal');await orch('followup',{work:skip.id,message:'Read all original assignment material before continuing'});const retried=await wait(skip.id);assert.equal(retried.child,failed.child);assert.equal(retried.state,'returned');await orch('review',{work:skip.id,decision:'adopted',reason:'Recovered same child after incomplete material delivery'});
 await add('oversized-constraints',{handoff:{constraints:Array.from({length:12},()=> 'X'.repeat(1900))}}).then(()=>assert.fail('Critical constraints must not be silently cropped'),()=>{});
 await call('dsh_solver_feedback',{action:'read_material',packet_id:references.get(w.id).packet_id,expected_hash:references.get(w.id).sha256},true);
 await orch('disable',{reason:'Offline long-material acceptance complete'});
 report={ok:true,source,fixture,checks:['Actual native Solvers receive full long goal/question/handoff through immutable paged text; critical constraints stay inline','Skipping required text fails instead of pretending delivery; execution and cross-work material access are refused until full reads','An explicitly granted native fixture tool reads the complete multi-MiB file by reference; no file body is stuffed into the task brief','Long followup preserves child identity and is fully read; full Unicode results reconstruct beyond the former 32768-character cut','Incomplete initial delivery can resume the same child; oversized critical constraints refuse explicitly and parent identity cannot call Solver material reads'],file_bytes:rawFile.length,fileReads,externalModelCalls:0,externalTargetRequests:0,modelAdapter:'deterministic local only'};
}finally{if(handle)await handle.dispose();if(ctx)await ctx.fiber.dispose();}
report.fullTeardownCompleted=true;fs.mkdirSync(base+'/.test-results',{recursive:true});fs.writeFileSync(base+'/.test-results/long-tasks-native.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
