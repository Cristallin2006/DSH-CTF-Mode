import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {Engine} from '../plugins/analysis-orchestration/engine.mjs';
import {skillPlan} from '../plugins/analysis-orchestration/materials.mjs';

const root=fs.mkdtempSync(path.join(os.tmpdir(),'dsh-skill-delivery-unit-'));const db=new DatabaseSync(root+'/state.sqlite3');
db.exec('CREATE TABLE tasks(id TEXT,data TEXT);CREATE TABLE sessions(id TEXT,task TEXT);CREATE TABLE targets(task TEXT,id TEXT,generation INTEGER,data TEXT);CREATE TABLE mem_owners(task TEXT,actor TEXT);');
db.prepare('INSERT INTO tasks VALUES(?,?)').run('task',JSON.stringify({status:'running',goal:'Local material races',constraints:{}}));db.prepare('INSERT INTO sessions VALUES(?,?)').run('main','task');db.prepare('INSERT INTO mem_owners VALUES(?,?)').run('task','main');db.close();
const parent={session:{header:{id:'main'}},options:{},ctx:{systemPrompt:{context:()=>()=>{}}},inbox:{remove(){}},steer(){}},children=new Map();let gate=null,lookups=0;
const definition={name:'fixture',provider:'local',source:'synthetic',content:'LOCAL_BODY_731',invocation:{modelInvocable:true,userInvocable:true}};
const ctx={agents:{get:id=>children.get(id)??parent},tools:{get:()=>({})},skills:{async list(options){assert(children.has(options.scope.session.header.id));return [definition];},async get(_name,options){lookups++;assert(children.has(options.scope.session.header.id));if(gate)await gate;return definition;}},subagents:{async drainContinuableChildren(){}}};
const e=new Engine(ctx,root,text=>({id:randomUUID(),content:[{type:'text',text}]}),{renderSkillContent:skill=>skill.content});
const call=(action,options={})=>e.command({action,task:'task',options},{agent:parent,signal:new AbortController().signal});
const plan={required:[{name:'fixture',reason:'Local asynchronous fixture'}]},checks=[];
async function child(key){let w=await call('add',{key,question:'Local question',success:'No scope widening',execution_plan:{kind:'materials',requirements:[]},skill_plan:plan});const r=e.store.run('task');w=e.store.claim(r,w.id,e.host,3);w.child=randomUUID();w.mode='continuable';w.state='running';e.store.saveWork(w);const agent={session:{header:{id:w.child,parentSession:'main',origin:'subagent'},surface:{nodes:[]},eventAt:()=>null},cancel(){}};children.set(w.child,agent);e.lifecycle.item(r,w,parent);return {w,agent};}
const decision=assembly=>({kind:'enter',messages:[{source:{kind:'plugin',plugin:'@deepseek-ai/dsh-system-prompt'},content:[{type:'text',text:'Current runtime context\n'+assembly.contexts.map(c=>c.text).join('\n')}]}]});
try{
  await call('enable');const first=await child('visible');
  const assemble=()=>e.materials.assemble({contexts:[]},{agent:first.agent,signal:new AbortController().signal});
  let a=await assemble();assert.equal(e.materials.verify(first.agent,decision(a)).kind,'enter');assert.equal(e.store.work('task',first.w.id).skill_delivery.state,'delivered');
  const events=()=>e.store.q("SELECT COUNT(*) AS n FROM orch_events WHERE kind='skill_delivery'").n;const before=events();a=await assemble();e.materials.verify(first.agent,decision(a));assert.equal(events(),before,'Same material/visibility does not manufacture repeated delivery events');
  const changed=e.store.work('task',first.w.id);changed.skill_plan=skillPlan({required:[],none_reason:'A later explicit selection'});e.store.saveWork(changed);assert.equal(e.materials.verify(first.agent,decision(a)).kind,'reject','Stored delivered flag cannot satisfy a changed plan');
  checks.push('Registry resolution uses the child scope; repeated unchanged steps do not add delivery events; changed plan invalidates prior preparation');
  await call('cancel',{work:first.w.id,reason:'Close first fixture'});
  const second=await child('cancel-race');let release;gate=new Promise(resolve=>release=resolve);const count=lookups;const loading=e.materials.assemble({contexts:[]},{agent:second.agent,signal:new AbortController().signal});
  while(lookups===count)await new Promise(resolve=>setTimeout(resolve,1));await call('cancel',{work:second.w.id,reason:'Cancel while provider is loading'});release();await loading;gate=null;
  assert.equal(e.store.work('task',second.w.id).state,'cancelled');assert(!e.materials.prepared.has(second.w.child));
  checks.push('Cancellation during asynchronous provider loading cannot restore running work, publish material, or bypass lifecycle cleanup');
  const third=await child('close-race');gate=new Promise(resolve=>release=resolve);const prior=lookups;const pending=e.materials.assemble({contexts:[]},{agent:third.agent,signal:new AbortController().signal});
  while(lookups===prior)await new Promise(resolve=>setTimeout(resolve,1));await e.close();release();await pending;assert(e.closed);assert.equal(e.materials.prepared.size,0);
  checks.push('A provider returning after engine shutdown does not access the closed database or retain its material cache');
  const base=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');fs.mkdirSync(base+'/.test-results',{recursive:true});const result={ok:true,checks,externalModelCalls:0,externalTargetRequests:0};fs.writeFileSync(base+'/.test-results/skill-delivery-unit.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}finally{if(!e.closed)await e.close();}
