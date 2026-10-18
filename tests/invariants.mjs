import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {Engine} from '../plugins/analysis-orchestration/engine.mjs';
fs.mkdirSync(new URL('../.test-results/',import.meta.url),{recursive:true});
const base=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),root=fs.mkdtempSync(path.join(os.tmpdir(),'dsh-continuable-invariants-')),db=new DatabaseSync(root+'/state.sqlite3');
db.exec('CREATE TABLE tasks(id TEXT,data TEXT);CREATE TABLE sessions(id TEXT,task TEXT);CREATE TABLE targets(task TEXT,id TEXT,generation INTEGER,data TEXT);CREATE TABLE mem_owners(task TEXT,actor TEXT);');
db.prepare('INSERT INTO tasks VALUES(?,?)').run('task',JSON.stringify({status:'running',goal:'Synthetic invariant checks',constraints:{}}));db.prepare('INSERT INTO sessions VALUES(?,?)').run('main','task');db.prepare('INSERT INTO mem_owners VALUES(?,?)').run('task','main');db.close();
const parent={id:'main',session:{header:{id:'main'}},options:{},ctx:{systemPrompt:{context:()=>()=>{}}},inbox:{remove(){}},steer(){}},child={id:'child',session:{header:{id:'child',parentSession:'main',origin:'subagent'}},cancel(){}};
const ctx={tools:{get:()=>({})},agents:{get:id=>id==='main'?parent:child},subagents:{async sendMessage(){return randomUUID();},async drainContinuableChildren(){}}},e=new Engine(ctx,root,text=>({id:randomUUID(),content:[{type:'text',text}]})),checks=[];
const call=(action,options={})=>e.command({action,task:'task',options},{agent:parent,signal:new AbortController().signal});
try{
 const enabled=await call('enable');assert.equal(enabled.expires,null);assert.equal(enabled.max_wakeups,null);let r=e.store.run('task');r.started=Date.now()-86400000;r.wakeups=10000;e.store.save(r);await e.tick();assert.equal(e.store.run('task').state,'enabled');
 let w=await call('add',{key:'long',question:'Continue local analysis',success:'Preserve evidence'});assert.equal(w.timeout_ms,null);assert.equal(w.max_steps,null);w=e.store.claim(r,w.id,e.host,3);w.child='child';w.mode='continuable';w.state='running';w.started=Date.now()-86400000;w.steps=10000;e.store.saveWork(w);const item=e.lifecycle.item(r,w,parent);item.run.localAgent=child;
 let advanced=false;await e.beforeStep({agent:child,signal:new AbortController().signal},()=>{advanced=true;return Promise.resolve({kind:'enter'});});assert(advanced);assert(!item.controller.signal.aborted);await e.tick();assert.equal(e.store.run('task').state,'enabled');assert.equal(e.store.work('task',w.id).state,'running');checks.push('default-null deadlines, step cap and wake cap stay disabled beyond prior thresholds; no hidden time-to-step substitution');
 w=e.store.work('task',w.id);w.report_count=200;e.store.saveWork(w);e.feedback({action:'progress',report:{summary:'A new bounded checkpoint after 200 prior reports'}},{agent:child});assert.equal(e.store.work('task',w.id).report_count,201);checks.push('long-running child does not lose progress reporting after 200 reports');
 w=e.store.work('task',w.id);w.guidance=Array.from({length:40},(_,i)=>({id:'old-'+i,delivery:'seen',ack:{status:'evaluated'}}));e.store.saveWork(w);await call('steer',{work:w.id,message:'New evidence within the original authorization'});w=e.store.work('task',w.id);assert.equal(w.guidance.length,40);assert(!w.guidance.some(g=>g.id==='old-0'));checks.push('bounded guidance window rotates acknowledged history instead of ending long collaboration');
 await call('cancel',{work:w.id,reason:'Synthetic stop'});assert.equal(e.active.size,0);const denied=await e.preTool({agent:child,name:'read',arguments:{}},()=>{throw Error('Must not execute');});assert.equal(denied.kind,'deny');checks.push('persisted managed-child identity remains guarded after its active entry was released');
 await call('disable',{reason:'Unit checks complete'});e.store.db.exec('CREATE TABLE control_pins(actor TEXT,task TEXT)');e.store.sql('INSERT INTO control_pins VALUES(?,?)','main','task');await assert.rejects(call('enable'),/Strict HTTP/);checks.push('strict HTTP incompatibility is preserved; continuous lifetime does not bypass network control');
 const result={ok:true,checks,externalModelCalls:0,externalTargetRequests:0};fs.writeFileSync(base+'/.test-results/invariants.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}finally{e.active.clear();e.children.clear();const r=e.store.run('task');if(r){r.state='disabled';e.store.save(r);}await e.close();}
