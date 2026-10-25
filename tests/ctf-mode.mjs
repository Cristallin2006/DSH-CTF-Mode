import assert from 'node:assert/strict';
import {CtfMode} from '../plugins/ctf-mode/core.mjs';
import {HookReadiness} from '../plugins/analysis-hooks-sandbox/hook-readiness.mjs';

const agent=id=>({session:{header:{id,cwd:'/fixture'},surface:{nodes:[]}}});
const a=agent('a'),b=agent('b'),child={session:{header:{id:'child',cwd:'/fixture',origin:'subagent',parentSession:'a'}}};
const hook=new HookReadiness();
hook.record({session_id:'a',hook_event_name:'PreToolUse'},true);assert.equal(hook.get('a').ready,false);
hook.record({session_id:'a',hook_event_name:'SessionStart'},true);assert.equal(hook.get('a').ready,true);
assert.equal(hook.get('b').ready,false);
const bodies=new Map(['ctf-mode','analysis-session','analysis-orchestration','ctf-misc'].map(name=>[name,'Complete body '+name]));
let invisible=null,run=null,calls=[],warnings=[];
const ctx={logger:{warn:t=>warnings.push(t)},tools:{get:name=>['skill','dsh_ctf'].includes(name)?{}:null},skills:{
  list:async()=>[...bodies.keys()].map(name=>({name,invocation:{modelInvocable:name!==invisible}})),
  get:async(name,lookup)=>{assert.equal(lookup.scope,a);calls.push(name);return {name,content:bodies.get(name),invocation:{modelInvocable:name!==invisible},resourceBase:{kind:'directory',path:'/fixture/'+name}};}
}};
const dependencies={renderSkillContent:skill=>skill.content,health:async who=>({ok:true,hook_session:hook.get(who.session.header.id)}),
  orchestrationHealth:async()=>({ok:true,current_run:run}),
  policy:async(skill,selected)=>({references:[...new Set([...skill.name==='ctf-misc'?['references/core.md']:[],...selected])]}),
  read:async(root,relative)=>({content:'Complete required reference '+relative,sha256:'fixture-hash',bytes:80})};
const mode=new CtfMode(ctx,dependencies),empty={sections:[],contexts:[],tools:[],variables:{}};
const decision=bundle=>({kind:'continue',messages:[{source:{kind:'plugin',plugin:'@deepseek-ai/dsh-system-prompt'},content:[{type:'text',text:'Current runtime context\n'+bundle.contexts.map(c=>c.text).join('\n')}]}]});
const prepare=async()=>{const assembly=await mode.assemble(empty,{agent:a});assert.notEqual(mode.verify(a,decision(assembly)).kind,'reject');return assembly;};
const tool=(name,args={})=>mode.preTool({agent:a,name,arguments:args});

const first=await prepare();assert(first.contexts[0].text.includes(bodies.get('ctf-mode')));assert(first.contexts[0].text.includes(bodies.get('analysis-session')));
assert.equal(calls.length,2);assert.equal(mode.status(a).mode,'selection_required');assert.equal((await tool('bash')).kind,'deny');
assert.equal(await tool('dsh_ctf'),null);assert.equal(await tool('analysis_session',{action:'health'}),null);
assert.equal((await mode.assemble(empty,{agent:b})).contexts.length,0);assert.equal(mode.verify(b,{kind:'continue',messages:[]}).kind,'reject');
assert.deepEqual(await mode.assemble(empty,{agent:child}),empty);assert.equal(await mode.preTool({agent:child,name:'bash'}),null);
await assert.rejects(mode.select(child,{mode:'solo'}),/main session/);

const select=(selected='solo')=>mode.select(a,{mode:selected,reason:'Fixture task structure requires this role',skill_plan:{required:[{name:'ctf-misc',reason:'Fixture attachment',references:['references/extra.md']}]}});
await select();assert.equal((await tool('bash')).kind,'deny');
let material=await prepare();assert(material.contexts[0].text.includes('Complete required reference references/core.md'));assert(material.contexts[0].text.includes('Complete required reference references/extra.md'));
assert.equal(await tool('bash'),null);assert.equal((await tool('dsh_orchestration',{action:'enable'})).kind,'deny');assert.equal((await tool('subagent')).kind,'deny');
const old=material;bodies.set('ctf-misc','Changed current specialist body');material=await mode.assemble(empty,{agent:a});
assert.equal(mode.verify(a,decision(old)).kind,'reject');assert.equal(mode.verify(a,decision(material)).kind,'continue');
assert.equal(mode.verify(a,{kind:'continue',messages:[]}).kind,'reject');
await prepare();hook.record({session_id:'a',hook_event_name:'PostToolUse'},false,'write failed');assert.equal((await tool('bash')).kind,'deny');
assert.equal((await mode.assemble(empty,{agent:a})).contexts.length,0);assert.equal(mode.verify(a,decision(old)).kind,'reject');
hook.record({session_id:'a',hook_event_name:'PostToolUse'},true);await prepare();

invisible='ctf-misc';assert.equal((await mode.assemble(empty,{agent:a})).contexts.length,0);assert.equal(mode.verify(a,decision(old)).kind,'reject');
invisible=null;bodies.set('ctf-misc','x'.repeat(70000));assert.equal((await mode.assemble(empty,{agent:a})).contexts.length,0);
bodies.set('ctf-misc','Restored specialist');await select('orchestrated');await prepare();assert(mode.status(a).skills.some(v=>v.name==='analysis-orchestration'));
assert.equal((await tool('bash')).kind,'deny');assert.equal(await tool('dsh_orchestration',{action:'enable'}),null);
run={task:'fixture-task',state:'paused',unsettled:true};await assert.rejects(select('solo'),/Disable\/drain/);assert.equal(mode.status(a).mode,'orchestrated');
run=null;await select('solo');await prepare();assert.equal(await tool('bash'),null);
await assert.rejects(mode.select(a,{mode:'solo',reason:'No plan'}),/skill_plan/);
const pinned=new CtfMode(ctx,{...dependencies,mode:'solo'});await assert.rejects(pinned.select(a,{mode:'orchestrated',reason:'Fixture',skill_plan:{required:[],none_reason:'Fixture planning'}}),/pins/);
mode.forget(a);assert.equal(mode.status(a).mode,'selection_required');hook.forget('a');assert.equal(hook.get('a').ready,false);
assert(warnings.length>0);
console.log(JSON.stringify({ok:true,checks:['full bootstrap without model skill calls','per-session actual hook receipts','selection and next-step delivery admission','required specialist references','changed/missing/oversized/compacted context rejection','solo/orchestrated tool boundaries','safe mode switch without implicit cancellation','child isolation','profile pinning and reload reset'],externalModelCalls:0,externalTargetRequests:0}));
