import {expandWork} from './native-client.mjs';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';
fs.mkdirSync(new URL('../.test-results/',import.meta.url),{recursive:true});
const base=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),installed=process.argv.includes('--installed'),native=process.env.DSH_NATIVE_PACKAGE_ROOT,req=createRequire(native+'/package.json');
const fixture=fs.mkdtempSync(path.join(os.tmpdir(),'dsh-supervision-native-')),home=fixture+'/home',state=home+'/analysis-state',workspace=fixture+'/workspace';
for(const d of [state,workspace])fs.mkdirSync(d,{recursive:true,mode:0o700});fs.cpSync(base+'/runtime',home+'/runtime',{recursive:true});fs.copyFileSync(base+'/runtime/analysis-v1/session.py',home+'/runtime/analysis-v1/session.py');fs.writeFileSync(fixture+'/cordis.yml','[]\n');fs.writeFileSync(workspace+'/numbers.txt','17 29\n');
assert.equal(spawnSync('python3',[home+'/runtime/analysis-v1/session.py','health'],{env:{...process.env,DSH_HOME:home}}).status,0);process.env.DSH_HOME=home;
const {boot,loadOverlayPatches}=await import(pathToFileURL(req.resolve('@deepseek-ai/dsh-app-boot')).href);
const {LlmAdapter}=await import(pathToFileURL(req.resolve('@deepseek-ai/dsh-llm')).href);
const modelState=new Map();let guidanceFromOther;
const blocked={summary:'The native probe rejected the format before calculation; algorithm is not disproved.',outcome:'blocked',hypothesis:'Input format may be wrong',evidence_refs:['numbers.txt:1'],blockers:['Need a valid format'],next_step:'Distinguish parsing failure from algorithm failure'};
class Scripted extends LlmAdapter{
  async *stream(o){
    const blocks=o.messages.flatMap(m=>m.content),input=blocks.find(x=>x.type==='text'&&x.text.startsWith('{"task"'));
    if(!input){yield* emit({type:'text',text:'coordinator event received'},'stop');return;}
    await new Promise(r=>setTimeout(r,200));
    const d=JSON.parse(input.text),s=modelState.get(d.work)??{phase:0,done:new Set(),guide:null};modelState.set(d.work,s);
    assert(o.maxTokens===32768||o.maxTokens===undefined);assert.equal(d.recorded_task.goal,'Calculate a local synthetic result without network');assert.equal(d.recorded_task.constraints.network,'forbidden');assert.equal(d.targets[0].context.endpoint,'local-fixture');
    const results=blocks.filter(x=>x.type==='tool-result');
    const tool=(name,args)=>emit({type:'tool-call',id:randomUUID(),name,arguments:JSON.stringify(args)},'tool-calls');
    if(d.question==='STUCK'){
      assert.equal(d.handoff.claims[0].verification,'untested');assert(d.handoff.hypotheses.length);
      if(s.phase===0){s.phase=1;yield* tool('fixture_probe',{mode:'wrong'});return;}
      if(s.phase===1){assert(JSON.stringify(results.at(-1)).includes('parse rejected'));s.phase=2;yield* tool('dsh_solver_feedback',{action:'progress',report:blocked});return;}
      const incoming=blocks.filter(x=>x.type==='text'&&x.text.startsWith('[DSH coordinator guidance] ')).map(x=>JSON.parse(x.text.slice(x.text.indexOf('{'))));
      if(!s.guide){const fresh=incoming.find(x=>!s.done.has(x.id));if(fresh)s.guide={...fresh,phase:0};}
      if(s.guide){const g=s.guide;
        if(g.phase===0){g.phase=1;yield* tool('dsh_solver_feedback',{action:'ack',guidance_id:g.id,status:'understood',reason:'Read the proposal; evaluate it against actual parsing feedback.'});return;}
        if(g.kind==='checkpoint'){
          if(g.phase===1){g.phase=2;yield* tool('dsh_solver_feedback',{action:'progress',report:{...blocked,summary:'Checkpoint: format rejected; preserve the unresolved parsing question.'}});return;}
          s.done.add(g.id);s.guide=null;yield* tool('dsh_solver_feedback',{action:'ack',guidance_id:g.id,status:'evaluated',reason:'Saved checkpoint only; no route change or budget extension.'});return;
        }
        if(!g.advice?.experiment.includes('mode=correct')){s.done.add(g.id);s.guide=null;yield* tool('dsh_solver_feedback',{action:'ack',guidance_id:g.id,status:'disagreed',reason:'Repeated wrong-format calls cannot evaluate the algorithm; native evidence contradicts the diagnosis.',evidence_refs:['numbers.txt:1']});return;}
        if(g.phase===1){g.phase=2;yield* tool('fixture_probe',{mode:'correct'});return;}
        if(g.phase===2){assert(JSON.stringify(results.at(-1)).includes('46'));g.phase=3;yield* tool('dsh_solver_feedback',{action:'ack',guidance_id:g.id,status:'applied',reason:'Ran the suggested format discriminator once.',evidence_refs:['numbers.txt:1']});return;}
        if(g.phase===3){g.phase=4;yield* tool('dsh_solver_feedback',{action:'progress',report:{summary:'Correctly formatted local probe returned 46.',outcome:'supported',evidence_refs:['numbers.txt:1'],next_step:'Return the bounded local result; no target acceptance claim.'}});return;}
        if(g.phase===4){g.phase=5;yield* tool('dsh_solver_feedback',{action:'ack',guidance_id:g.id,status:'evaluated',reason:'Native feedback supports parsing as the blocker; result is 46 for this local input.',evidence_refs:['numbers.txt:1']});return;}
        yield* emit({type:'text',text:'Local result 46; parsing issue resolved with new information, no external acceptance.'},'stop');return;
      }
      yield* emit({type:'text',text:'Blocked on format; return idle until coordinator supplies evidence.'},'stop');return;
    }
    if(d.question==='FOLLOW'){if(s.phase++===0){yield* emit({type:'text',text:'Remember FIRST_MARKER_893; idle now.'},'stop');return;}assert(blocks.some(b=>b.type==='text'&&b.text.includes('FIRST_MARKER_893')));yield* emit({type:'text',text:'Follow-up retained FIRST_MARKER_893 in the same native context.'},'stop');return;}
    if(d.question==='WAIT'){
      if(s.phase++===0){yield* tool('dsh_solver_feedback',{action:'progress',report:{summary:'Waiting for a local long calculation.',wait_reason:'A known local calculation is running',wait_ms:600000,next_step:'Review its real output when it returns'}});return;}
      yield* tool('fixture_wait',{});return;
    }
    if(d.question==='GUIDANCE_WAIT'){
      if(s.phase++===0){yield* tool('dsh_solver_feedback',{action:'progress',report:{summary:'Awaiting missing synthetic input',outcome:'blocked',blockers:['Missing local material'],next_step:'Wait within the assigned deadline'}});return;}
      yield* tool('dsh_solver_feedback',{action:'await_guidance',timeout_ms:60000});return;
    }
    if(d.question==='AUTH'){
      if(s.phase++===0){yield* tool('dsh_solver_feedback',{action:'ack',guidance_id:guidanceFromOther,status:'applied',reason:'Must not acknowledge another Solver guidance'});return;}
      assert(results.at(-1).isError);yield* emit({type:'text',text:'Cross-work acknowledgement was rejected.'},'stop');return;
    }
    if(d.question==='DEPENDENT'){
      assert.equal(d.dependencies[0].verification,'untested');assert.equal(d.dependencies[0].review.decision,'adopted');assert.equal(d.dependencies[0].checkpoint.verification,'untested');yield* emit({type:'text',text:'Adopted dependency still requires evidence review; no acceptance promotion.'},'stop');return;
    }
    if(d.observed_work){assert.deepEqual((o.tools??[]).map(x=>x.name),[]);assert(d.observed_work.checkpoint);yield* emit({type:'text',text:'Observer sees the saved report as a self-report, not verification.'},'stop');return;}
    throw Error('Unexpected synthetic assignment');
  }
}
function* emit(block,kind){yield {type:'block-start',index:0,blockType:block.type};if(block.type==='text')yield {type:'text-delta',index:0,text:block.text};else yield {type:'tool-call-delta',index:0,id:block.id,name:block.name,argumentsDelta:block.arguments};yield {type:'block-end',index:0,block};yield {type:'finish',reason:{kind}};}
const plugin=base+'/plugins/analysis-orchestration/index.mjs';
const patches=[...loadOverlayPatches('supervision-test',native+'/node_modules/@deepseek-ai/dsh-base/cordis.patch.yml'),{id:'session-telemetry-otel',disabled:true},{id:'session-title-llm',disabled:true},{insert:[
  {id:'analysis-state-adapter',name:pathToFileURL(base+'/plugins/analysis-hooks-sandbox/index.mjs').href,config:{dshHome:home,pluginRoot:base+'/dsh-hooks',configPath:base+'/dsh-hooks/hooks.json',selfTest:false}},
  {id:'analysis-memory',name:pathToFileURL(base+'/plugins/analysis-memory/index.mjs').href,config:{enabled:true,stateRoot:state}},
  {id:'analysis-orchestration',name:pathToFileURL(plugin).href,config:{enabled:true,stateRoot:state,tickMs:100}}
]}];
let ctx,handle;const checks=[];
try{
  ctx=await boot('supervision-test',fixture+'/cordis.yml',patches,undefined,pathToFileURL(native+'/').href);ctx.llm.registerAdapter(['supervision-script'],new Scripted());
  ctx.tools.register({name:'fixture_probe',description:'Local synthetic parser and calculation',parameters:{type:'object',properties:{mode:{type:'string'}},required:['mode'],additionalProperties:false},output:{schema:{type:'string'},render(_a,v){return [{type:'text',text:v}];}},async execute(a){return a.mode==='correct'?'probe-native-actual result='+fs.readFileSync(workspace+'/numbers.txt','utf8').trim().split(' ').map(Number).reduce((a,b)=>a+b,0):'probe-native-actual parse rejected; calculation was not reached; token=synthetic-private';}});
  ctx.tools.register({name:'fixture_wait',description:'Local cancellable waiting fixture',parameters:{type:'object',properties:{},additionalProperties:false},output:{schema:{type:'string'},render(_a,v){return [{type:'text',text:v}];}},async execute(_a,exec){return new Promise((r,j)=>{if(exec.signal.aborted)return j(Error('cancelled'));exec.signal.addEventListener('abort',()=>j(Error('cancelled')),{once:true});});}});
  handle=await ctx.agents.create({sessionId:'supervision-main-'+randomUUID(),meta:{cwd:workspace},agentOptions:{provider:'supervision-script',model:'local',maxTokens:32768}});await handle.agent.whenIdle();
  async function call(name,args,error=false){const v=await ctx.tools.execute({name,callId:randomUUID(),agent:handle.agent,arguments:args,signal:new AbortController().signal});if(error){assert(v.isError,JSON.stringify(v));return;}assert(!v.isError,JSON.stringify(v));return JSON.parse(v.content.filter(x=>x.type==='text').map(x=>x.text).join(''));}
  const task=(await call('analysis_session',{action:'init',options:{goal:'Calculate a local synthetic result without network',data:{network:'forbidden'}}})).result.id;
  await call('analysis_session',{action:'target',task,options:{id:'local',data:{endpoint:'local-fixture',password:'must-not-be-handed-off'}}});await call('dsh_memory_write',{action:'open',task,options:{}});
  const orch=async(action,options={},error=false)=>{const value=await call('dsh_orchestration',{action,task,options:action==='add'?{execution_plan:{kind:'materials',requirements:[]},skill_plan:{required:[],none_reason:'Synthetic orchestration fixture has no specialist-method requirement'},...options}:options},error);return action==='result'&&options.view==='detail'?expandWork(call,task,value):value;};
  const enabled=await orch('enable',{heartbeat_ms:1000});assert.equal(enabled.expires,null);assert.equal(enabled.max_wakeups,null);
  const noCapability=await orch('add',{key:'preflight-native',question:'PREFLIGHT_BLOCKED',success:'Do not call a model without required execution capability',execution_plan:{kind:'execution',requirements:[{purpose:'Local synthetic probe',any_of:['fixture_probe']}]}});const beforeBlocked=modelState.size;assert.equal((await orch('dispatch',{work:[noCapability.id]})).results[0].state,'not_started');assert.equal(modelState.size,beforeBlocked);await orch('cancel',{work:noCapability.id,reason:'Missing-capability fixture complete'});
  await call('dsh_solver_feedback',{action:'progress',report:{summary:'Root cannot impersonate Solver'}},true);
  const a=await orch('add',{key:'stuck',question:'STUCK',success:'Resolve the local question or report an evidenced negative/blocker',tools:['fixture_probe'],handoff:{inputs:[{ref:'numbers.txt',description:'Local synthetic input'}],claims:[{statement:'Algorithm might be wrong',verification:'untested'}],hypotheses:['Could instead be input format'],failure_boundaries:['No valid format has been tried']}});
  assert.equal(a.timeout_ms,null);assert.equal(a.max_steps,null);await orch('dispatch',{work:[a.id]});
  async function until(id,predicate){for(let i=0;i<100;i++){const w=await orch('result',{work:id,view:'detail'});if(predicate(w))return w;if(['failed','cancelled'].includes(w.state))throw Error(JSON.stringify(w));await new Promise(r=>setTimeout(r,50));}throw Error('Synthetic progress did not arrive');}
  const stuck=await until(a.id,w=>w.state==='returned'&&w.checkpoint?.outcome==='blocked');const stableChild=stuck.child;assert.equal(stuck.checkpoint.verification,'untested');
  const real=await orch('trace',{work:a.id});assert(real.available);assert(JSON.stringify(real).includes('probe-native-actual'));assert(!JSON.stringify(real).includes('synthetic-private'));
  checks.push('native tool-schema dispatch preflight blocks missing capability before Solver model invocation; same objective routes to the existing native child',
    'recorded goal/constraints/target entry and structured uncertainty handed off; password field excluded');checks.push('live progress is scoped self-report; native trace exposes actual bounded feedback with common secret masking');
  const seq=stuck.checkpoint.revision;await orch('request_checkpoint',{work:a.id,reason:'Preserve current reasoning before a possible change'});await until(a.id,w=>w.checkpoint?.revision>seq);
  const bad=await orch('steer',{work:a.id,guidance:{observation:'The parser rejected the input',hypothesis:'Perhaps the algorithm is disproved',experiment:'Repeat the wrong format',reconsider_if:'Calculation was not reached',evidence_refs:['numbers.txt:1']}});guidanceFromOther=bad.guidance_id;
  const refused=await until(a.id,w=>w.guidance?.some(g=>g.id===bad.guidance_id&&g.ack?.status==='disagreed'));assert.equal(refused.guidance.find(g=>g.id===bad.guidance_id).delivery,'seen');
  checks.push('checkpoint request persists state; native guidance seen event is distinct from explicit acknowledgement; mistaken diagnosis can be rejected');
  const auth=await orch('add',{key:'auth',question:'AUTH',success:'Cross-work feedback must fail'});await orch('dispatch',{work:[auth.id]});await until(auth.id,w=>w.state==='returned');await orch('review',{work:auth.id,decision:'adopted',reason:'Identity isolation checked'});
  const good=await orch('steer',{work:a.id,guidance:{observation:'Native trace shows parsing fails before calculation',hypothesis:'Format rather than algorithm is the current blocker',experiment:'Use mode=correct once and inspect whether calculation is reached',reconsider_if:'The corrected format still fails before computation',evidence_refs:['numbers.txt:1']}});
  const solved=await until(a.id,w=>w.state==='returned');assert.match(solved.result,/46/);assert.equal(solved.child,stableChild);assert(solved.result_revision>=2);assert.equal(solved.checkpoint.outcome,'supported');assert.equal(solved.guidance.find(g=>g.id===good.guidance_id).ack.status,'evaluated');assert.equal(solved.verification,'untested');
  await orch('review',{work:a.id,decision:'adopted',reason:'Checked local original input and native output; no external acceptance'});
  const dep=await orch('add',{key:'dep',question:'DEPENDENT',success:'Retain uncertainty',depends_on:[a.id]});await orch('dispatch',{work:[dep.id]});await until(dep.id,w=>w.state==='returned');await orch('review',{work:dep.id,decision:'adopted',reason:'No verification promotion'});
  checks.push('evidence-based new information changes the synthetic outcome; applied/evaluated tracked without acceptance promotion; dependency verification retained');
  const observer=await orch('add',{key:'observer',question:'OBSERVE',success:'Bounded review',role:'observer',observe_work:a.id});await orch('dispatch',{work:[observer.id]});await until(observer.id,w=>w.state==='returned');await orch('review',{work:observer.id,decision:'adopted',reason:'Advisory report only'});
  const waiting=await orch('add',{key:'wait',question:'WAIT',success:'Wait for known work, retain checkpoint',tools:['fixture_wait'],timeout_ms:15000});await orch('dispatch',{work:[waiting.id]});const live=await until(waiting.id,w=>w.inflight>0);assert.equal(live.activity.state,'tool_in_flight');assert(live.wait_until<=live.started+live.timeout_ms);
  await orch('cancel',{work:waiting.id,reason:'Synthetic cancellation'});const cancelled=await orch('result',{work:waiting.id,view:'detail'});assert.equal(cancelled.state,'cancelled');assert(cancelled.checkpoint?.wait_reason);assert((await orch('trace',{work:a.id})).available);
  checks.push('Observer stays zero-tool; in-flight calculation is not classified as stalled; waiting cannot extend deadline; cancellation preserves last saved checkpoint');
  const guidanceWait=await orch('add',{key:'guidance-wait',question:'GUIDANCE_WAIT',success:'Bounded guidance waiting',timeout_ms:15000});await orch('dispatch',{work:[guidanceWait.id]});const awaiting=await until(guidanceWait.id,w=>w.activity.state==='awaiting_guidance');assert(awaiting.guidance_waiting_until<=awaiting.started+awaiting.timeout_ms);
  await orch('cancel',{work:guidanceWait.id,reason:'Cancel native guidance wait'});const ended=await orch('result',{work:guidanceWait.id,view:'detail'});assert.equal(ended.state,'cancelled');assert.equal(ended.guidance_waiting_until,null);assert(ended.checkpoint);checks.push('native bounded guidance wait is cancellable and releases occupancy while preserving the checkpoint');
  const follow=await orch('add',{key:'follow',objective_ref:'native:follow',question:'FOLLOW',success:'Keep the child context'});await orch('dispatch',{work:[follow.id]});const first=await until(follow.id,w=>w.state==='returned');const routed=await orch('add',{key:'new-round-name',objective_ref:'native:follow',question:'FOLLOW',success:'Continue the same objective'});assert.equal(routed.id,follow.id);assert.equal(routed.route.child,first.child);assert(routed.deduplicated);const countBefore=modelState.size;await new Promise(r=>setTimeout(r,1100));assert.equal(modelState.size,countBefore);assert.equal((await orch('status',{view:'detail'})).state,'enabled');await orch('followup',{work:follow.id,message:'Recall your first marker and explain that context persists.'});const second=await until(follow.id,w=>w.state==='returned'&&w.result_revision===2);assert.equal(second.child,first.child);assert.match(second.result,/FIRST_MARKER_893/);await orch('review',{work:follow.id,decision:'adopted',reason:'Same child context confirmed'});
  await orch('followup',{work:a.id,message:'Do not invalidate adopted dependencies'},true);checks.push('native idle child can resume with the same ID and prior context; no default deadlines, step/wake caps or 4096 output override; adopted dependency revisions are guarded');
  await orch('finish',{reason:'Supervision synthetic acceptance complete'});
  const phaseBefore=modelState.get(follow.id).phase;await ctx.subagents.sendMessage(handle.agent,first.child,[{type:'text',text:'Direct native message must not bypass finished orchestration'}],{signal:new AbortController().signal});await new Promise(r=>setTimeout(r,400));assert.equal(modelState.get(follow.id).phase,phaseBefore);assert.equal((await orch('result',{work:follow.id})).state,'adopted');checks.push('direct native cold resume of finished managed work cannot bypass the orchestration step guard');
  const result={ok:true,installed,fixture,checks,scriptedBreakthrough:true,externalModelCalls:0,externalTargetRequests:0,limitation:'scripted scenario validates the mechanism, not real-model success-rate improvement'};fs.mkdirSync(base+'/.test-results',{recursive:true});fs.writeFileSync(base+'/.test-results/'+(installed?'installed-native':'native')+'.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
}finally{if(handle)await handle.dispose();if(ctx)await ctx.fiber.dispose();}
