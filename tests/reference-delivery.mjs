import {expandWork} from './native-client.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {spawnSync} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {fileURLToPath,pathToFileURL} from 'node:url';
const base=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),source=process.env.DSH_ORCHESTRATION_TEST_ROOT??base,native=process.env.DSH_NATIVE_PACKAGE_ROOT,req=createRequire(native+'/package.json');
const fixture=fs.mkdtempSync(path.join(os.tmpdir(),'dsh-reference-native-')),home=fixture+'/home',state=home+'/analysis-state',workspace=fixture+'/workspace';
for(const d of [state,workspace,home+'/skills'])fs.mkdirSync(d,{recursive:true});fs.cpSync(base+'/runtime',home+'/runtime',{recursive:true});fs.writeFileSync(fixture+'/cordis.yml','[]\n');fs.writeFileSync(fixture+'/hooks.json','{"hooks":{}}');
assert.equal(spawnSync('python3',[home+'/runtime/analysis-v1/session.py','health'],{env:{...process.env,DSH_HOME:home}}).status,0);process.env.DSH_HOME=home;
function skill(name,core,policy=true){const dir=home+'/skills/'+name;fs.mkdirSync(dir+'/references',{recursive:true});fs.writeFileSync(dir+'/SKILL.md',`---\nname: ${name}\ndescription: Synthetic reference delivery fixture\n---\n\nShort router; the full table is in references/core.md.\n`);fs.writeFileSync(dir+'/references/core.md',core);fs.writeFileSync(dir+'/references/extra.md','OPTIONAL_EXTRA_7391');if(policy)fs.writeFileSync(dir+'/skill-materials.json',JSON.stringify({version:1,required_references:['references/core.md']}));return dir;}
let core='FULL_HARVEST_POSITION_TABLE_9831\nFULL_FALSE_APPEARANCE_DIAGNOSIS_1163\n'.repeat(15);const dir=skill('method-fixture',core);skill('other-fixture','UNSELECTED_OTHER_BODY_3871');
const broken=skill('broken-fixture','unused');fs.writeFileSync(broken+'/skill-materials.json','{broken');const missing=skill('missing-fixture','unused');fs.unlinkSync(missing+'/references/core.md');
const escaped=skill('escaped-fixture','unused');fs.unlinkSync(escaped+'/references/core.md');fs.writeFileSync(fixture+'/outside.md','OUTSIDE_6281');fs.symlinkSync(fixture+'/outside.md',escaped+'/references/core.md');
const huge=skill('huge-fixture','x'.repeat(65500));
const chainSource=process.env.DSH_REFERENCE_SKILL_ROOT;let actualCards=[];
if(chainSource){fs.cpSync(chainSource,home+'/skills/ctf-attack-chain',{recursive:true});const policy=JSON.parse(fs.readFileSync(chainSource+'/skill-materials.json','utf8'));actualCards=policy.required_references.map(ref=>fs.readFileSync(chainSource+'/'+ref,'utf8'));assert.equal(actualCards.length,3);}
const {boot,loadOverlayPatches}=await import(pathToFileURL(req.resolve('@deepseek-ai/dsh-app-boot')).href),{LlmAdapter,createUserMessage}=await import(pathToFileURL(req.resolve('@deepseek-ai/dsh-llm')).href);
const calls=new Map();let ctx,handle,db,compactions=0,skillToolCalls=0,answer;
function* text(value){yield {type:'block-start',index:0,blockType:'text'};yield {type:'text-delta',index:0,text:value};yield {type:'block-end',index:0,block:{type:'text',text:value}};yield {type:'finish',reason:{kind:'stop'}};}
class Local extends LlmAdapter{async *stream(options){
 const blocks=options.messages.flatMap(m=>m.content),assignment=blocks.find(b=>b.type==='text'&&b.text.startsWith('{"task"'));if(!assignment){yield* text('Coordinator notification');return;}
 const data=JSON.parse(assignment.text),question=data.question;calls.set(question,(calls.get(question)??0)+1);assert(!['BROKEN','MISSING','ESCAPED','HUGE'].includes(question),'Broken mandatory references must prevent the first model call');
 const texts=blocks.filter(b=>b.type==='text').map(b=>b.text),current=texts.filter(t=>t.startsWith('Current runtime context')).at(-1)??'';
 if(question==='ACTUAL'){for(const body of actualCards)assert(current.includes(body),'Actual installed/staged core card must be included in full, not summarized');yield* text('Actual core card bodies were delivered in full before this text-only answer');return;}
 assert(data.handoff.hypotheses.includes('Coordinator brief contains only a short tactic summary; it is not the original reference'));
 assert(current.includes(core));assert(!current.includes('UNSELECTED_OTHER_BODY_3871'));assert.equal(current.split('[Required reference method-fixture/references/core.md]').length-1,1);
 const compactAlready=blocks.some(b=>b.type==='tool-result'&&b.content.some(x=>x.type==='text'&&x.text.includes('Synthetic reference compaction')));
 if(question==='COMPACT'&&!compactAlready){const block={type:'tool-call',id:randomUUID(),name:'fixture_compact',arguments:'{}'};yield {type:'block-start',index:0,blockType:'tool-call'};yield {type:'tool-call-delta',index:0,id:block.id,name:block.name,argumentsDelta:block.arguments};yield {type:'block-end',index:0,block};yield {type:'finish',reason:{kind:'tool-calls'}};return;}
 yield* text('Full method is visible despite summary-only brief and zero skill tool calls');
}}
const checks=[];
try{
 const patches=[...loadOverlayPatches('reference-delivery',native+'/node_modules/@deepseek-ai/dsh-base/cordis.patch.yml'),{id:'session-title-llm',disabled:true},{id:'session-telemetry-otel',disabled:true},{insert:[
  {id:'state-adapter',name:pathToFileURL(source+'/plugins/analysis-hooks-sandbox/index.mjs').href,config:{dshHome:home,pluginRoot:base+'/dsh-hooks',configPath:fixture+'/hooks.json',selfTest:false}},
  {id:'analysis-memory',name:pathToFileURL(source+'/plugins/analysis-memory/index.mjs').href,config:{enabled:true,stateRoot:state}},
  {id:'analysis-orchestration',name:pathToFileURL(source+'/plugins/analysis-orchestration/index.mjs').href,config:{enabled:true,stateRoot:state,tickMs:50}}
 ]}];ctx=await boot('reference-delivery',fixture+'/cordis.yml',patches,undefined,pathToFileURL(native+'/').href);ctx.llm.registerAdapter(['reference-local'],new Local());db=new DatabaseSync(state+'/state.sqlite3');
 ctx.on('tools/execute',(exec,next)=>{if(exec.name==='skill')skillToolCalls++;return next();});
 ctx.tools.register({name:'fixture_compact',description:'Replace synthetic runtime context',parameters:{type:'object',properties:{},additionalProperties:false},output:{schema:{type:'string'},render(_a,v){return [{type:'text',text:v}];}},async execute(_a,exec){const session=exec.agent.session,node=[...session.surface.nodes].reverse().find(seq=>{const event=session.eventAt(seq);return event.type==='user/message'&&event.data.content.some(b=>b.type==='text'&&b.text.startsWith('Current runtime context')&&b.text.includes('[DSH required skill material '));});assert(node!==undefined);session.append('user/message',createUserMessage({content:[{type:'text',text:'Short compressed brief without reference contents'}],source:{kind:'plugin',plugin:'synthetic-reference-compaction'}}),{surfaceOp:{op:'replace',startSeq:node,endSeq:node},sourceEventSeqs:[node]});compactions++;return 'Synthetic reference compaction';}});
 handle=await ctx.agents.create({sessionId:'ref-parent-'+randomUUID(),meta:{cwd:workspace},agentOptions:{provider:'reference-local',model:'local'}});await handle.agent.whenIdle();
 const tool=async(name,args)=>{const result=await ctx.tools.execute({name,callId:randomUUID(),agent:handle.agent,arguments:args,signal:new AbortController().signal});assert(!result.isError,JSON.stringify(result));return JSON.parse(result.content.filter(x=>x.type==='text').map(x=>x.text).join(''));};
 const task=(await tool('analysis_session',{action:'init',options:{goal:'Full reference delivery without Solver skill calls'}})).result.id;await tool('dsh_memory_write',{action:'open',task});const orch=async(action,options={})=>{const value=await tool('dsh_orchestration',{action,task,options});return action==='result'&&options.view==='detail'?expandWork(tool,task,value):value;};await orch('enable');
 const add=async(question,name='method-fixture',refs,tools=[])=>orch('add',{key:question.toLowerCase(),question,success:'Validate delivery only',tools,execution_plan:{kind:'materials',requirements:[]},skill_plan:{required:[{name,reason:'The brief summarizes this specialist method',...refs===undefined?{}:{references:refs}}]},handoff:{hypotheses:['Coordinator brief contains only a short tactic summary; it is not the original reference']}});
 const wait=async(id,state='returned',rev=1)=>{for(let i=0;i<250;i++){const w=await orch('result',{work:id,view:'detail'});if(w.state===state&&(w.result_revision??0)>=rev)return w;await new Promise(resolve=>setTimeout(resolve,20));}throw Error('Synthetic work did not settle');};
 const omitted=await add('OMITTED');await orch('dispatch',{work:[omitted.id]});let initial=await wait(omitted.id);assert.equal(initial.skill_delivery.coverage.policy_references,1);assert.equal(initial.skill_delivery.materials[0].references[0].required_by[0],'skill');
 const empty=await add('EMPTY','method-fixture',[]);await orch('dispatch',{work:[empty.id]});assert.equal((await wait(empty.id)).skill_delivery.coverage.references,1);assert.equal(skillToolCalls,0);
 checks.push('A summary-only brief with omitted or empty references still delivers the complete skill-owned mandatory card before the first text-only model call, with zero skill-tool calls');
 const firstDigest=initial.skill_delivery.digest,originalChild=initial.child;core+='UPDATED_CORE_4827';fs.writeFileSync(dir+'/references/core.md',core);fs.writeFileSync(dir+'/skill-materials.json',JSON.stringify({version:1,required_references:['references/core.md','references/extra.md']}));
 await orch('followup',{work:omitted.id,message:'Continue with the current full reference policy'});initial=await wait(omitted.id,'returned',2);assert.equal(initial.child,originalChild);assert.notEqual(initial.skill_delivery.digest,firstDigest);assert.equal(initial.skill_delivery.coverage.policy_references,2);
 const compact=await add('COMPACT','method-fixture',[],['fixture_compact']);await orch('dispatch',{work:[compact.id]});assert.equal((await wait(compact.id)).skill_delivery.state,'delivered');assert.equal(compactions,1);
 checks.push('Policy/content changes on same-child followup and native runtime-context replacement restore full current references and refresh receipts');
 for(const name of ['BROKEN','MISSING','ESCAPED','HUGE']){const work=await add(name,name.toLowerCase()+'-fixture',[]);await orch('dispatch',{work:[work.id]});assert.equal((await wait(work.id,'failed')).skill_delivery.state,'blocked');assert.equal(calls.get(name)??0,0);}
 checks.push('Invalid mandatory policy, missing/escaped reference and oversized bundle each block before model execution instead of falling back to a brief');
 if(chainSource){const actual=await add('ACTUAL','ctf-attack-chain',[]);await orch('dispatch',{work:[actual.id]});const result=await wait(actual.id);assert.equal(result.skill_delivery.coverage.references,3);assert.equal(result.skill_delivery.coverage.policy_references,3);checks.push('All three actual attack-chain core references are present in full, including credential-location and false-appearance knowledge, without being copied into the brief');}
 assert.equal(skillToolCalls,0);await orch('disable',{reason:'Synthetic reference acceptance complete'});answer={ok:true,checks,skillToolCalls,calls:Object.fromEntries(calls),actualCoreCards:actualCards.length,fixture,externalModelCalls:0,externalTargetRequests:0};
}finally{if(handle)await handle.dispose();if(ctx)await ctx.fiber.dispose();if(db)db.close();}
answer.fullTeardownCompleted=true;fs.mkdirSync(base+'/.test-results',{recursive:true});fs.writeFileSync(base+'/.test-results/reference-delivery.json',JSON.stringify(answer,null,2));console.log(JSON.stringify(answer,null,2));
