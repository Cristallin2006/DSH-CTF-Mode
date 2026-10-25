/** Real DSH startup/admission with a deterministic local adapter; no external model/target. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),native=process.env.DSH_NATIVE_PACKAGE_ROOT;
assert(native,'Set DSH_NATIVE_PACKAGE_ROOT to the installed DSH package');
const req=createRequire(native+'/package.json'),fixture=fs.mkdtempSync(path.join(os.tmpdir(),'dsh-ctf-mode-')),home=fixture+'/home';
const env={...process.env,DSH_HOME:home,DSH_ANALYSIS_STATE:home+'/analysis-state'};
execFileSync('python3',[root+'/tools/setup.py','--mode','full','--preset','ctf','--home',home,'--apply'],{env});
execFileSync('python3',[home+'/runtime/analysis-v1/session.py','health'],{env});
process.env.DSH_HOME=home;process.env.DSH_ANALYSIS_STATE=home+'/analysis-state';
fs.writeFileSync(fixture+'/cordis.yml','[]');
fs.mkdirSync(home+'/skills/ctf-fixture/references',{recursive:true});
fs.writeFileSync(home+'/skills/ctf-fixture/SKILL.md','---\nname: ctf-fixture\ndescription: Local synthetic method\n---\n\nCTF_SPECIALIST_BODY_671');
fs.writeFileSync(home+'/skills/ctf-fixture/skill-materials.json',JSON.stringify({version:1,required_references:['references/core.md']}));
fs.writeFileSync(home+'/skills/ctf-fixture/references/core.md','CTF_REQUIRED_REFERENCE_274');
const {boot,loadOverlayPatches}=await import(pathToFileURL(req.resolve('@deepseek-ai/dsh-app-boot')).href);
const {LlmAdapter,createUserMessage}=await import(pathToFileURL(req.resolve('@deepseek-ai/dsh-llm')).href);
let calls=0,executions=0,ctx,handle,phase=0;
function* emit(block,kind){yield {type:'block-start',index:0,blockType:block.type};if(block.type==='text')yield {type:'text-delta',index:0,text:block.text};else yield {type:'tool-call-delta',index:0,id:block.id,name:block.name,argumentsDelta:block.arguments};yield {type:'block-end',index:0,block};yield {type:'finish',reason:{kind}};}
class Local extends LlmAdapter{
  async *stream(o){
    calls++;const text=o.messages.flatMap(m=>m.content??[]).filter(b=>b.type==='text').map(b=>b.text).join('\n');
    assert(text.includes('[DSH CTF preset '));assert(text.includes('# CTF 模式'));assert(text.includes('# Analysis Session'));
    const tool=(name,args)=>emit({type:'tool-call',id:randomUUID(),name,arguments:JSON.stringify(args)},'tool-calls');
    if(phase++===0){yield* tool('dsh_ctf',{action:'select',mode:'solo',reason:'One local fixture',skill_plan:{required:[{name:'ctf-fixture',reason:'Synthetic method'}]}});return;}
    assert(text.includes('CTF_SPECIALIST_BODY_671'));assert(text.includes('CTF_REQUIRED_REFERENCE_274'));
    if(phase===2){yield* tool('ctf_fixture_execute',{});return;}
    yield* emit({type:'text',text:'Synthetic single-task method and reference were host-loaded before execution.'},'stop');
  }
}
try{
  const patches=[...loadOverlayPatches('ctf-mode-native',native+'/node_modules/@deepseek-ai/dsh-base/cordis.patch.yml'),
    {id:'session-title-llm',disabled:true},{id:'session-telemetry-otel',disabled:true},
    ...loadOverlayPatches('ctf-mode-native',home+'/launch/ctf-mode.patch.json')];
  ctx=await boot('ctf-mode-native',fixture+'/cordis.yml',patches,undefined,pathToFileURL(native+'/').href);
  ctx.llm.registerAdapter(['ctf-mode-local'],new Local());
  ctx.tools.register({name:'ctf_fixture_execute',description:'Synthetic admission counter, no external execution',parameters:{type:'object',properties:{},additionalProperties:false},output:{schema:{type:'string'},render(_a,v){return [{type:'text',text:v}];}},async execute(){executions++;return 'local fixture observed';}});
  handle=await ctx.agents.create({sessionId:'ctf-'+randomUUID(),meta:{cwd:fixture},agentOptions:{provider:'ctf-mode-local',model:'local'}});
  handle.agent.followup(createUserMessage({content:[{type:'text',text:'Analyze the single synthetic CTF fixture; network forbidden.'}],source:{kind:'plugin',plugin:'ctf-native-fixture'}}));
  await handle.agent.whenIdle();assert.equal(calls,3);assert.equal(executions,1);
  const output=await ctx.tools.execute({name:'analysis_session',callId:randomUUID(),agent:handle.agent,arguments:{action:'health'},signal:new AbortController().signal});
  assert(!output.isError);const health=JSON.parse(output.content.filter(b=>b.type==='text').map(b=>b.text).join(''));
  assert.equal(health.hook_session.ready,true);assert.equal(health.hook_session.session_id,handle.agent.session.header.id);
}finally{if(handle)await handle.dispose();if(ctx)await ctx.fiber.dispose();}
console.log(JSON.stringify({ok:true,fixture,calls,executions,externalModelCalls:0,externalTargetRequests:0,checks:['actual generated CTF overlay','actual session startup hook receipt','bootstrap before first local model step','required reference before execution without skill tool call','normal teardown']}));
