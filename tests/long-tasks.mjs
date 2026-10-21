import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath,pathToFileURL} from 'node:url';
const base=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),source=process.env.DSH_ORCHESTRATION_TEST_ROOT??base;
const {HandoffStore}=await import(pathToFileURL(source+'/plugins/analysis-memory/handoff.mjs'));
const {TargetMap}=await import(pathToFileURL(source+'/plugins/analysis-memory/target-map.mjs'));
const {Engine}=await import(pathToFileURL(source+'/plugins/analysis-orchestration/engine.mjs'));
const fixture=fs.mkdtempSync(path.join(os.tmpdir(),'dsh-long-')),state=fixture+'/state',workspace=fixture+'/work';fs.mkdirSync(state);fs.mkdirSync(workspace);
const runtime=source+'/runtime/analysis-v1/session.py',env={...process.env,DSH_HOME:fixture,DSH_ANALYSIS_STATE:state};
const init=spawnSync('python3',[runtime,'init','--session','main','--goal','Review a bounded set of synthetic observations'],{env,encoding:'utf8'});assert.equal(init.status,0,init.stderr);const task=JSON.parse(init.stdout).result.id;
const memory=new HandoffStore(state,JSON.parse(fs.readFileSync(source+'/plugins/analysis-memory/candidate.schema.json','utf8')));memory.open('main',task,workspace);const map=new TargetMap(memory);
const parent={session:{header:{id:'main'}},ctx:{systemPrompt:{context:()=>()=>{}}},inbox:{remove(){}},steer(){}};
let e=new Engine({tools:{get:()=>({})}},state,t=>({id:randomUUID(),content:[{type:'text',text:t}]}));
const call=(action,options={})=>e.command({action,task,options},{agent:parent}),checks=[];
const guard=()=>spawnSync('python3',['-c',"import importlib.util,sys;spec=importlib.util.spec_from_file_location('s',sys.argv[1]);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)\nwith m.database() as c:m.require_orchestration_resolution(c,sys.argv[2])",runtime,task],{env,encoding:'utf8'});
try{
 await call('enable');const all=[];
 for(let i=0;i<100;i++){
   const w=await call('add',{key:'phase-'+i,question:'Inspect synthetic evidence '+i,success:'Preserve conditions',objective_ref:'aggregate',...(i?{assignment_kind:'independent_branch',source_work:all[0].id,branch_reason:'Independent synthetic subproblem '+i}:{}),execution_plan:{kind:'materials',requirements:[]},skill_plan:{required:[],none_reason:'Synthetic boundary test'}});
   w.state='needs_more_evidence';w.result='Synthetic reviewed observation';w.result_revision=1;w.review={decision:'needs_more_evidence',result_revision:1};w.checkpoint={outcome:'inconclusive',evidence_refs:['中','😀','\ue000','\x7f'],revision:1};e.store.saveWork(w);all.push(w);
 }
 // Default supervision must not fall back to the old full-body history loader.
 e.store.works=()=>{throw Error('Unexpected full history body load');};
 let offset=0,snapshot,ids=[];do{const p=await call('status',{offset,limit:13,max_bytes:6000,...snapshot?{snapshot}:{}});assert(Buffer.byteLength(JSON.stringify(p))<=6000);snapshot=p.snapshot;ids.push(...p.works.map(w=>w.id));offset=p.next_offset;}while(offset!==null);assert.equal(ids.length,100);await e.tick();
 let active=e.store.work(task,all[99].id);active.state='running';e.store.saveWork(active);assert.equal((await call('status',{limit:1})).works[0].id,active.id);assert.equal((await call('status',{states:['running']})).total,1);active.state='needs_more_evidence';e.store.saveWork(active);
 checks.push('100 same-epoch work items exceed the old cap; paged status and heartbeat use database pages/metadata instead of loading historical bodies');
 let revision=0;for(let start=0;start<all.length;start+=25){const sig=(await call('status')).decision_review.signature;const staged=await call('issues',{expected_signature:sig,expected_revision:revision,upsert:all.slice(start,start+25).map((w,j)=>({key:'issue-'+(start+j),work:w.id,issue:'Additional paths remain untested',disposition:'out_of_scope',reason:'Synthetic user goal covers supplied observations, not exhaustive execution'}))});revision=staged.issue_set_revision;}
 await assert.rejects(call('issues',{expected_signature:(await call('status')).decision_review.signature,expected_revision:0,upsert:[]}),/revision conflict/);
 const resolution={decision:'complete',goal_status:'fulfilled',summary:'Delivered supplied-observation review',completion_scope:'Synthetic observations only',evidence_refs:[`work:${all[0].id}@1`],unresolved:[],issue_set_revision:revision};
 await call('issues',{expected_signature:(await call('status')).decision_review.signature,expected_revision:revision,remove:['issue-99']});revision++;
 await assert.rejects(call('resolve',{expected_signature:(await call('status')).decision_review.signature,resolution:{...resolution,issue_set_revision:revision}}),/needs_more_evidence/);
 await call('issues',{expected_signature:(await call('status')).decision_review.signature,expected_revision:revision,upsert:[{key:'issue-99',work:all[99].id,issue:'Other paths',disposition:'out_of_scope',reason:'Outside the synthetic requested delivery'}]});revision++;
 await call('resolve',{expected_signature:(await call('status')).decision_review.signature,resolution:{...resolution,issue_set_revision:revision}});
 await call('finish',{reason:'Synthetic review delivered'});assert.equal(guard().status,0,guard().stderr);
 const ref=e.store.run(task).resolution_review.resolution.issue_set;assert.equal(ref.count,100);
 offset=0;snapshot=undefined;let issues=[];do{const p=await call('issues',{issue_set_id:ref.id,offset,max_bytes:2048,...snapshot?{snapshot}:{}});assert(Buffer.byteLength(JSON.stringify(p))<=2048);issues.push(...p.items);snapshot=p.snapshot;offset=p.next_offset;}while(offset!==null);assert.equal(issues.length,100);
 const old=e.store.q('SELECT key,data FROM orch_issue_snapshot_items WHERE snapshot=? LIMIT 1',ref.id);e.store.sql('UPDATE orch_issue_snapshot_items SET data=? WHERE snapshot=? AND key=?','{}',ref.id,old.key);assert.notEqual(guard().status,0);e.store.sql('UPDATE orch_issue_snapshot_items SET data=? WHERE snapshot=? AND key=?',old.data,ref.id,old.key);
 checks.push('100 issues are staged in bounded CAS batches and frozen for completion; missing one cannot pass, snapshots page fully and Python verifies Unicode work digests plus issue integrity');
 const raw='😀中\0line\n'.repeat(12000)+'FULL_RESULT_TAIL';let w=e.store.work(task,all[0].id);e.store.saveResult(w,raw);e.store.saveWork(w);assert(w.result_preview_truncated);assert(!w.result_truncated);
 offset=0;const pieces=[];do{const p=await call('result',{work:w.id,offset,max_bytes:8192,expected_revision:w.result_revision});assert(Buffer.byteLength(JSON.stringify(p))<=8192);pieces.push(p.result);offset=p.next_offset;}while(offset!==null);assert.equal(pieces.join(''),raw);assert.notEqual(guard().status,0,'New result invalidates an older completion');
 checks.push('Long Unicode/NUL results preserve their exact full text and tail across pages; inline previews are marked and a new result invalidates prior completion');
 fs.writeFileSync(workspace+'/source.txt','Synthetic config only');const src=memory.register('main',task,{path:'source.txt'});memory.readSource('main',task,src.source_id);
 const draft=memory.propose('main',task,{schema_version:'0.2',operation_id:randomUUID(),expected_generation:0,target_id:null,kind:'claim',title:'Synthetic component',body:'Only supplied configuration was inspected',origin:'inferred',verification:'untested',evidence_refs:[{source_id:src.source_id,locator:'line 1'}],accept_scope:null,unresolved:['Connectivity untested'],details:{proposition:'Component reference exists',conditions:{description:'Local text only',environment_ref:null,analysis_revision_ref:null}}});const d=memory.review('main',task,{id:draft.id,expected_revision:1,decision:'publish',reason:'Read supplied text'});
 const m=(action,o={})=>map.command('main',task,action,o);
 for(let i=0;i<700;i++)m('put_node',{key:'node-'+String(i).padStart(4,'0'),expected_revision:0,kind:'service',record_id:d.id,record_revision:2});
 for(let i=0;i<20;i++)m('remove',{key:'node-'+String(i).padStart(4,'0'),expected_revision:1});
 const first=m('view',{limit:1});assert.equal(first.total,680);const later=m('view',{offset:600,limit:1,expected_snapshot:first.snapshot});assert.equal(later.offset,600);assert.equal(later.items.length,1);
 m('put_node',{key:'goal',expected_revision:0,kind:'goal',record_id:d.id,record_revision:2});m('bind_goal',{key:'binding',expected_revision:0,node:'goal',node_revision:1,objective_ref:'aggregate'});
 offset=0;snapshot=undefined;const covered=[];do{const p=m('coverage',{key:'binding',offset,limit:17,max_bytes:8192,...snapshot?{expected_snapshot:snapshot}:{}});assert(Buffer.byteLength(JSON.stringify(p))<=8192);covered.push(...p.works);snapshot=p.snapshot;offset=p.next_offset;}while(offset!==null);assert.equal(covered.length,100);
 checks.push('700 historical map keys and tombstones do not block creation; offsets beyond 512 work and all 100 objective branches remain available through bounded coverage pages');
}finally{await e.close();memory.close();}
const report={ok:true,checks,externalModelCalls:0,externalTargetRequests:0,source,fixture};fs.mkdirSync(base+'/.test-results',{recursive:true});fs.writeFileSync(base+'/.test-results/long-tasks.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
