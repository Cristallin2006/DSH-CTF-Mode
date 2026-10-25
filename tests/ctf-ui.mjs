import assert from 'node:assert/strict';
import {CtfMode} from '../plugins/ctf-mode/core.mjs';
import {CtfUiController} from '../plugins/ctf-ui/controller.mjs';
import fs from 'node:fs';
import vm from 'node:vm';
let defaults={defaultPreference:'auto'},run=null,hook=true,maintenance=0;
const agents=new Map(),mode=new CtfMode({}, {defaultPreference:()=>defaults.defaultPreference,
  health:async a=>({ok:hook,hook_session:{session_id:a.id,ready:hook}}),orchestrationHealth:async()=>({ok:true,current_run:run})});
const settings={get:()=>defaults,update:async patch=>{defaults={...defaults,...patch};}};
const ui=new CtfUiController({settings,getAgent:id=>agents.get(id),presetOf:a=>a.preset});
ui.register(mode,'ctf');
function agent(id,preset='ctf'){
  const a={id,preset,status:'idle',session:{header:{id,cwd:'/fixture'}},async runMaintenance(fn){assert.equal(maintenance,0);maintenance++;try{return await fn(new AbortController().signal);}finally{maintenance--;}}};
  agents.set(id,a);return a;
}
const a=agent('a'),b=agent('b'),ordinary=agent('ordinary','standard'),child=agent('child');child.session.header.parentSession='a';
assert.deepEqual(await ui.status({session_id:'cold'}),{live:false,mode:'not_live',verified:false});
await assert.rejects(ui.status({session_id:ordinary.id}),/does not run/);
await assert.rejects(ui.status({session_id:child.id}),/main session/);
for(const request of [{session_id:'a',extra:1},{session_id:'../a'},null])await assert.rejects(ui.status(request),/Invalid/);
let s=await ui.status({session_id:'a'});assert.equal(s.preference,'auto');assert.equal(s.mode,'selection_required');assert(s.hook_ready);assert(!s.verified);
const change=(action,value,expected_revision=mode.status(a).revision)=>ui.change({session_id:'a',action,value,expected_revision});
s=await change('preference','orchestrated');assert.equal(s.preference,'orchestrated');assert.equal(s.mode,'selection_required');assert.equal(mode.status(b).preference,'auto');
await assert.rejects(change('route','solo',0),/state changed/);
a.status='running';await assert.rejects(change('route','solo'),/busy/);assert.equal(maintenance,0);a.status='idle';
s=await change('route','orchestrated');assert.equal(s.mode,'orchestrated');assert(!s.verified);
run={unsettled:true};await assert.rejects(change('route','solo'),/Disable\/drain/);assert.equal(mode.status(a).mode,'orchestrated');
run=null;hook=false;await assert.rejects(change('route','solo'),/hook receipt/);hook=true;
mode.state(a).plan={required:[{name:'ctf-misc',reason:'Keep task-specific source',references:[]}]};
s=await change('route','solo');assert.equal(s.mode,'solo');assert.equal(mode.state(a).plan.required[0].name,'ctf-misc');
await change('preference','auto');assert.equal(mode.status(a).mode,'solo');
for(const value of ['auto','orchestrated','solo'])assert.equal((await ui.saveDefaults({defaultPreference:value,expected_preference:defaults.defaultPreference})).defaultPreference,value);
assert.equal(mode.status(a).preference,'auto');assert.equal(mode.status(agent('new')).preference,'solo');
await assert.rejects(ui.saveDefaults({defaultPreference:'auto',expected_preference:'orchestrated'}),/defaults changed/);
await assert.rejects(ui.saveDefaults({defaultPreference:'auto',expected_preference:'solo',token:'x'}),/Invalid/);
await assert.rejects(change('route','auto'),/Invalid/);
assert(!JSON.stringify(await ui.status({session_id:'a'})).includes('Keep task-specific source'));
const pinned=new CtfMode({}, {mode:'solo'}),locked=new CtfUiController({settings,getAgent:id=>agents.get(id),presetOf:()=> 'locked'});locked.register(pinned,'locked');
await assert.rejects(locked.change({session_id:'a',action:'preference',value:'auto',expected_revision:0}),/pins/);
// Competing awaited model selections cannot commit on the same revision.
let release;const wait=new Promise(resolve=>{release=resolve;});
const racing=new CtfMode({}, {health:async who=>{await wait;return {ok:true,hook_session:{session_id:who.id,ready:true}};},orchestrationHealth:async()=>({ok:true})});
const input={mode:'solo',reason:'Concurrent synthetic route',skill_plan:{required:[],none_reason:'Planning'}};
const p=racing.select(a,input),q=racing.select(a,input);release();const results=await Promise.allSettled([p,q]);assert.equal(results.filter(v=>v.status==='fulfilled').length,1);
const abort=new AbortController(),aborted=new CtfMode({}, {health:async who=>({ok:true,hook_session:{session_id:who.id,ready:true}}),orchestrationHealth:async()=>{abort.abort();return {ok:true};}});
await assert.rejects(aborted.select(a,{...input,signal:abort.signal}),/abort/i);assert.equal(aborted.status(a).mode,'selection_required');
// Load the real browser entry and validate its native Remote boundary contract.
let client,contribution;const slots=[];
vm.runInNewContext(fs.readFileSync(new URL('../plugins/ctf-ui/client.js',import.meta.url),'utf8'),{window:{__ModuleLoader__:{load:entry=>{client=entry.factory(()=>({createElement(){}}));}}}});
const remote={$mount:async value=>{contribution=value;return async()=>{};}},scope={remote,slots:{inject:(_name,fn)=>fn(),register:spec=>{slots.push(spec);return ()=>{};}}};
await client.apply({remote,effect(){},inject:(keys,fn)=>{assert.deepEqual(Array.from(keys),['remote.ctfUi']);fn(scope);}});
assert.equal(slots.length,2);
for(const descriptor of contribution.descriptors){assert.equal(descriptor.parameters[0].codec.mode,'strict');assert.equal(descriptor.result.mode,'strict');}
const statusCodec=contribution.descriptors.find(v=>v.method==='status').parameters[0].codec.schema;
assert.equal(statusCodec.parse({session_id:'fixture'}).session_id,'fixture');assert.throws(()=>statusCodec.parse({session_id:'fixture',extra:true}));
const routeCodec=contribution.descriptors.find(v=>v.method==='change').parameters[0].codec.schema;
assert.throws(()=>routeCodec.parse({session_id:'fixture',action:'route',value:'auto',expected_revision:0}));
console.log(JSON.stringify({ok:true,checks:['per-session preference and actual route separation','read without activation','main/preset scoping','strict requests','native maintenance busy guard','revision conflict and concurrent selection','preserved specialist plan','hook and drain guards','default applies to new state only','pin respected','compact receipts'],externalModelCalls:0}));
