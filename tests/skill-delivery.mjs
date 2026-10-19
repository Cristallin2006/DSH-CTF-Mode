import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {spawnSync} from 'node:child_process';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {skillPlan} from '../plugins/analysis-orchestration/materials.mjs';

const base=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),source=process.env.DSH_ORCHESTRATION_TEST_ROOT??base,native=process.env.DSH_NATIVE_PACKAGE_ROOT,req=createRequire(native+'/package.json');
const fixture=fs.mkdtempSync(path.join(os.tmpdir(),'dsh-skill-delivery-')),home=fixture+'/home',state=home+'/analysis-state',workspace=fixture+'/workspace';
for(const dir of [state,workspace,home+'/skills'])fs.mkdirSync(dir,{recursive:true});
fs.cpSync(base+'/runtime',home+'/runtime',{recursive:true});fs.writeFileSync(fixture+'/cordis.yml','[]\n');fs.writeFileSync(fixture+'/empty-hooks.json','{"hooks":{}}');
assert.equal(spawnSync('python3',[home+'/runtime/analysis-v1/session.py','health'],{env:{...process.env,DSH_HOME:home,DSH_ANALYSIS_STATE:state}}).status,0);process.env.DSH_HOME=home;
const write=(name,body,hidden=false)=>{const dir=home+'/skills/'+name;fs.mkdirSync(dir+'/references',{recursive:true});fs.writeFileSync(dir+'/SKILL.md',`---\nname: ${name}\ndescription: Local synthetic ${name} method.\n${hidden?'disable-model-invocation: true\n':''}---\n\n${body}\n`);};
let expectedBody='BODY_ALPHA_1637',expectedRef='REFERENCE_ALPHA_2394';
write('alpha-fixture',expectedBody);write('beta-fixture','BODY_BETA_8502');write('hidden-fixture','BODY_HIDDEN_7193',true);write('huge-fixture','X'.repeat(70000));
fs.writeFileSync(home+'/skills/alpha-fixture/references/local.md',expectedRef);
fs.writeFileSync(fixture+'/outside.md','OUTSIDE_MATERIAL_923');fs.symlinkSync(fixture+'/outside.md',home+'/skills/alpha-fixture/references/escape.md');
const {boot,loadOverlayPatches}=await import(pathToFileURL(req.resolve('@deepseek-ai/dsh-app-boot')).href),{LlmAdapter,createUserMessage}=await import(pathToFileURL(req.resolve('@deepseek-ai/dsh-llm')).href);
const calls=new Map(),phases=new Map(),repaired=new Set();let compactions=0,ctx,handle,db,result;
function* emit(block,kind){yield {type:'block-start',index:0,blockType:block.type};if(block.type==='text')yield {type:'text-delta',index:0,text:block.text};else yield {type:'tool-call-delta',index:0,id:block.id,name:block.name,argumentsDelta:block.arguments};yield {type:'block-end',index:0,block};yield {type:'finish',reason:{kind}};}
class Local extends LlmAdapter{
  async *stream(o){
    const blocks=o.messages.flatMap(m=>m.content),assignment=blocks.find(b=>b.type==='text'&&b.text.startsWith('{"task"'));
    if(!assignment){yield* emit({type:'text',text:'Local coordinator notification'},'stop');return;}
    const d=JSON.parse(assignment.text),question=d.question;calls.set(question,(calls.get(question)??0)+1);
    if(['HIDDEN','MISSING','HUGE','ESCAPE','SUPPRESS'].includes(question)){
      assert(repaired.has(question),'A material failure must prevent even a text-only model call');yield* emit({type:'text',text:'Returned after an explicit material-plan repair'},'stop');return;
    }
    const texts=blocks.filter(b=>b.type==='text').map(b=>b.text),current=texts.filter(t=>t.startsWith('Current runtime context')).at(-1)??'';
    if(d.observed_work){assert.deepEqual((o.tools??[]).map(t=>t.name),[]);assert(!texts.join('\n').includes('BODY_ALPHA_'));yield* emit({type:'text',text:'Observer reviewed metadata without loading skill bodies'},'stop');return;}
    const catalog=texts.filter(t=>t.includes('<available_skills>')).join('\n');assert(catalog.includes('alpha-fixture')&&catalog.includes('beta-fixture'));assert(!catalog.includes('hidden-fixture'));
    if(question==='NONE'){assert(!current.includes('BODY_ALPHA_'));yield* emit({type:'text',text:'Simple synthetic answer needs no specialist method'},'stop');return;}
    assert(current.includes(expectedBody));assert(current.includes(expectedRef));assert(!current.includes('BODY_BETA_8502'));
    assert.equal(current.split('[DSH required skill material ').length-1,1,'One current bundle, not one append per model step');
    assert(!current.includes('OUTSIDE_MATERIAL_923'));
    const phase=phases.get(d.work)??0,tool=(name,args)=>emit({type:'tool-call',id:randomUUID(),name,arguments:JSON.stringify(args)},'tool-calls');phases.set(d.work,phase+1);
    if(question==='CATALOG'){
      if(phase===0){yield* tool('skill',{name:'beta-fixture'});return;}
      const results=blocks.filter(b=>b.type==='tool-result');
      if(phase===1){assert(JSON.stringify(results.at(-1)).includes('BODY_BETA_8502'));yield* tool('bash',{command:'touch not-authorized-by-knowledge',description:'Synthetic permission test'});return;}
      assert(results.at(-1).isError);yield* emit({type:'text',text:'Other skills remain callable; shell permission was not granted'},'stop');return;
    }
    if(question==='COMPACT'&&phase===0){yield* tool('fixture_compact',{});return;}
    yield* emit({type:'text',text:'Required method delivered before this text-only answer; application remains unverified'},'stop');
  }
}
const required={required:[{name:'alpha-fixture',reason:'Synthetic specialist method for this assignment',references:['references/local.md']}]},none={required:[],none_reason:'Simple synthetic fixture with no specialist method'};
const checks=[];
try{
  assert.throws(()=>skillPlan(undefined),/Declare skill_plan/);assert.throws(()=>skillPlan({required:[]}),/none_reason/);
  for(const ref of ['../outside.md','references/../outside.md','references/local.json','/etc/passwd','references\\local.md'])assert.throws(()=>skillPlan({required:[{name:'alpha-fixture',reason:'test',references:[ref]}]}));
  const patches=[...loadOverlayPatches('skill-delivery',native+'/node_modules/@deepseek-ai/dsh-base/cordis.patch.yml'),{id:'session-title-llm',disabled:true},{id:'session-telemetry-otel',disabled:true},{insert:[
    {id:'state-adapter',name:pathToFileURL(source+'/plugins/analysis-hooks-sandbox/index.mjs').href,config:{dshHome:home,pluginRoot:base+'/dsh-hooks',configPath:fixture+'/empty-hooks.json',selfTest:false}},
    {id:'analysis-memory',name:pathToFileURL(source+'/plugins/analysis-memory/index.mjs').href,config:{enabled:true,stateRoot:state}},
    {id:'analysis-orchestration',name:pathToFileURL(source+'/plugins/analysis-orchestration/index.mjs').href,config:{enabled:true,stateRoot:state,tickMs:50}}
  ]}];
  ctx=await boot('skill-delivery',fixture+'/cordis.yml',patches,undefined,pathToFileURL(native+'/').href);ctx.llm.registerAdapter(['skill-delivery-local'],new Local());db=new DatabaseSync(state+'/state.sqlite3');
  ctx.on('agent/created',({agent})=>{const row=db.prepare("SELECT data FROM orch_work WHERE json_extract(data,'$.child')=?").get(agent.session.header.id);if(row&&JSON.parse(row.data).question==='SUPPRESS')agent.ctx.systemPrompt.suppressRuntimeContext();});
  ctx.tools.register({name:'fixture_compact',description:'Replace only this synthetic child runtime-context node to model compaction',parameters:{type:'object',properties:{},additionalProperties:false},output:{schema:{type:'string'},render(_a,v){return [{type:'text',text:v}];}},async execute(_a,exec){
    const session=exec.agent.session,node=[...session.surface.nodes].reverse().find(seq=>{const event=session.eventAt(seq);return event.type==='user/message'&&event.data.content.some(b=>b.type==='text'&&b.text.startsWith('Current runtime context')&&b.text.includes('[DSH required skill material '));});assert(node!==undefined);
    session.append('user/message',createUserMessage({content:[{type:'text',text:'Synthetic compressed summary without specialist instructions'}],source:{kind:'plugin',plugin:'synthetic-compaction'}}),{surfaceOp:{op:'replace',startSeq:node,endSeq:node},sourceEventSeqs:[node]});compactions++;return 'Synthetic context replacement committed';
  }});
  handle=await ctx.agents.create({sessionId:'skills-main-'+randomUUID(),meta:{cwd:workspace},agentOptions:{provider:'skill-delivery-local',model:'local'}});await handle.agent.whenIdle();
  const tool=async(name,args,error=false)=>{const v=await ctx.tools.execute({name,callId:randomUUID(),agent:handle.agent,arguments:args,signal:new AbortController().signal});if(error){assert(v.isError,JSON.stringify(v));return;}assert(!v.isError,JSON.stringify(v));return JSON.parse(v.content.filter(b=>b.type==='text').map(b=>b.text).join(''));};
  const task=(await tool('analysis_session',{action:'init',options:{goal:'Local required-skill material admission tests'}})).result.id;await tool('dsh_memory_write',{action:'open',task});
  const orch=(action,options={},error=false)=>tool('dsh_orchestration',{action,task,options},error);await orch('enable');
  const wait=async(id,state='returned',revision=1)=>{for(let i=0;i<200;i++){const w=await orch('result',{work:id,view:'detail'});if(w.state===state&&(w.result_revision??0)>=revision)return w;await new Promise(resolve=>setTimeout(resolve,20));}throw Error('Fixture did not settle: '+JSON.stringify(await orch('result',{work:id,view:'detail'})));};
  const add=async(question,plan=required,tools=[])=>orch('add',{key:question.toLowerCase(),question,success:'Preserve task and skill boundaries',execution_plan:{kind:'materials',requirements:[]},skill_plan:plan,tools});
  const run=async(question,plan=required,tools=[])=>{const w=await add(question,plan,tools);await orch('dispatch',{work:[w.id]});return wait(w.id);};
  await orch('add',{key:'omitted',question:'DIRECT',success:'Must declare selection'},true);
  const direct=await run('DIRECT');assert.equal(calls.get('DIRECT'),1);assert.equal(direct.skill_delivery.state,'delivered');assert(direct.skill_delivery.materials[0].references[0].sha256);
  checks.push('A text-only Solver sees required body and reference before its first model call, without calling skill; explicit skill selection or a no-skill reason is required');
  await new Promise(resolve=>setTimeout(resolve,30));const idleChildReleasedBeforeFollowup=!ctx.agents.get(direct.child);
  const firstHash=direct.skill_delivery.digest;expectedBody='BODY_ALPHA_UPDATED_237';expectedRef='REFERENCE_ALPHA_UPDATED_519';write('alpha-fixture',expectedBody);fs.writeFileSync(home+'/skills/alpha-fixture/references/local.md',expectedRef);
  await orch('followup',{work:direct.id,message:'Re-evaluate current local methods after content update'});const refreshed=await wait(direct.id,'returned',2);assert.equal(refreshed.child,direct.child);assert.notEqual(refreshed.skill_delivery.digest,firstHash);
  checks.push('Followup retains the child identity and reloads changed required body/reference versions rather than trusting a saved loaded flag');
  const compact=await run('COMPACT',required,['fixture_compact']);assert.equal(compactions,1);assert.equal(compact.skill_delivery.state,'delivered');assert.equal(calls.get('COMPACT'),2);
  checks.push('A real native surface replacement removes prior material; the next native step restores the complete current bundle without a summarization model');
  await run('CATALOG');assert(!fs.existsSync(workspace+'/not-authorized-by-knowledge'));
  checks.push('Unselected skill names remain in the native catalog and their bodies are callable on demand; knowledge does not grant shell permission');
  await run('NONE',none);
  const legacy=await add('LEGACY',none);let row=JSON.parse(db.prepare('SELECT data FROM orch_work WHERE id=?').get(legacy.id).data);delete row.skill_plan;db.prepare('UPDATE orch_work SET data=? WHERE id=?').run(JSON.stringify(row),legacy.id);
  assert.equal((await orch('dispatch',{work:[legacy.id]})).results[0].state,'not_started');await orch('set_skills',{work:legacy.id,skill_plan:required});await orch('dispatch',{work:[legacy.id]});assert.equal((await wait(legacy.id)).skill_delivery.state,'delivered');
  checks.push('Explicit simple-task exemption remains available; legacy pending work needs an explicit repair plan before launch');
  for(const [question,name,refs] of [['HIDDEN','hidden-fixture',[]],['MISSING','missing-fixture',[]],['HUGE','huge-fixture',[]],['ESCAPE','alpha-fixture',['references/escape.md']],['SUPPRESS','alpha-fixture',['references/local.md']]]){
    const w=await add(question,{required:[{name,reason:'Synthetic failure boundary',references:refs}]});await orch('dispatch',{work:[w.id]});const failed=await wait(w.id,'failed');assert.equal(failed.skill_delivery.state,'blocked');assert.equal(calls.get(question)??0,0);assert.equal((await orch('status',{view:'detail'})).health.ok,true);
    repaired.add(question);await orch('followup',{work:w.id,message:'Replace failed material plan with an explicit simple fixture exemption',skill_plan:none});
    const fixed=await wait(w.id,'returned',2);assert.equal(fixed.child,failed.child);assert.equal(fixed.skill_delivery.state,'not_required');assert.equal(calls.get(question),1);
  }
  checks.push('Missing, disabled, oversized, escaped and suppressed material blocks before any model call and does not fault the whole host');
  const observer=await orch('add',{key:'observer',question:'OBSERVER',success:'Review supplied metadata',role:'observer',observe_work:direct.id});await orch('dispatch',{work:[observer.id]});await wait(observer.id);
  checks.push('Observer retains zero tools and receives no automatically loaded specialist bodies');
  await orch('disable',{reason:'Synthetic skill-delivery acceptance complete'});
  result={ok:true,checks,fixture,idleChildReleasedBeforeFollowup,modelAdapter:'deterministic local only',externalModelCalls:0,externalTargetRequests:0,calls:Object.fromEntries(calls)};
}finally{if(handle)await handle.dispose();if(ctx)await ctx.fiber.dispose();if(db)db.close();}
result.fullTeardownCompleted=true;fs.mkdirSync(base+'/.test-results',{recursive:true});fs.writeFileSync(base+'/.test-results/skill-delivery.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
