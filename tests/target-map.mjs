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
const {Store:OrchStore}=await import(pathToFileURL(source+'/plugins/analysis-orchestration/store.mjs'));
const fixture=fs.mkdtempSync(path.join(os.tmpdir(),'dsh-map-')),state=fixture+'/state',workspace=fixture+'/work';fs.mkdirSync(state);fs.mkdirSync(workspace);
const init=spawnSync('python3',[source+'/runtime/analysis-v1/session.py','init','--session','main','--goal','Map synthetic components'],{env:{...process.env,DSH_HOME:fixture,DSH_ANALYSIS_STATE:state},encoding:'utf8'});assert.equal(init.status,0,init.stderr);const task=JSON.parse(init.stdout).result.id;
const schema=JSON.parse(fs.readFileSync(source+'/plugins/analysis-memory/candidate.schema.json','utf8'));let s=new HandoffStore(state,schema),map=new TargetMap(s),orch;
s.open('main',task,workspace);const call=(action,o={})=>map.command('main',task,action,o),checks=[];
fs.writeFileSync(workspace+'/evidence.txt','SYNTHETIC 配置提到数据库，尚未测试连通。\n');
const src=s.register('main',task,{path:'evidence.txt'});s.readSource('main',task,src.source_id);
function record(title,opts={}){
 const d={schema_version:'0.2',operation_id:randomUUID(),expected_generation:0,target_id:null,kind:'claim',title,body:'A bounded synthetic statement; no execution or permission implied',origin:'inferred',verification:'untested',evidence_refs:[{source_id:src.source_id,locator:'synthetic first line'}],accept_scope:null,unresolved:['Network connectivity remains untested'],details:{proposition:'Configuration reference only',conditions:{description:'Local config file; no network vantage or identity tested',environment_ref:null,analysis_revision_ref:null}},...opts};
 const p=s.propose('main',task,d);return s.review('main',task,{id:p.id,expected_revision:1,decision:'publish',reason:'Read synthetic source; preserve limits'});
}
const node=(k,d,kind='service',expected_revision=0)=>call('put_node',{key:k,expected_revision,kind,record_id:d.id,record_revision:d.revision});
const edge=(k,a,b,d,more={})=>call('put_edge',{key:k,expected_revision:0,kind:'connects_to',from:a,from_revision:1,to:b,to_revision:1,record_id:d.id,record_revision:d.revision,...more});
try{
 assert.equal(call('view').total,0);assert.equal(map.index('main',task),null);
 const a=record('Portal observed config',{origin:'observed'}),b=record('Database hypothesis'),link=record('Config mentions database'),hidden=record('UNRELATED_HIDDEN_NODE');
 node('portal',a);node('db',b);node('hidden',hidden);edge('portal-db','portal','db',link);
 const view=call('view',{focus:['portal'],max_bytes:32768});assert.equal(view.total,3);assert.equal(view.items.find(x=>x.type==='edge').state,'inferred');assert.equal(view.items.find(x=>x.key==='portal').state,'observed');assert(!JSON.stringify(view).includes('UNRELATED_HIDDEN_NODE'));assert.equal(call('view',{focus:['portal'],radius:0}).total,1);
 checks.push('Focused neighborhoods omit unrelated records; configuration references stay inferred while recorded observations retain untested verification and original-condition links');
 assert.throws(()=>map.command('intruder',task,'view'),/bound|session|own|bind/i);assert.throws(()=>map.command('main','other-task','view'));assert.throws(()=>node('new',a,'service',1),/conflict/);assert.throws(()=>call('view',{unknown:true}),/Invalid/);assert.throws(()=>edge('bad','portal','db',link,{from_revision:2}),/conflict/);assert.throws(()=>edge('bad','portal','db',link,{kind:'depends_on'}),/goal/);
 assert.throws(()=>s.propose('main',task,{...a,operation_id:randomUUID()}),/schema mismatch/);
 const candidate={...a,operation_id:randomUUID()};for(const k of ['id','revision','review_state','visibility','applicability','recorded_at','actor','review_reason'])delete candidate[k];
 const draft=s.propose('main',task,candidate);assert.throws(()=>node('draft',{id:draft.id,revision:1}),/reviewed/);
 checks.push('Owning-task access, strict metadata, reviewed-only basis and revision checks reject invalid writes');
}catch(e){s.close();throw e;}

try{
 const unknown=record('Unknown prerequisite',{evidence_refs:[]});node('unknown',unknown,'unknown');assert.equal(call('view',{focus:['unknown']}).items[0].state,'unknown');
 const goal=record('Access objective',{evidence_refs:[]});node('goal',goal,'goal');call('bind_goal',{key:'goal-work',expected_revision:0,node:'goal',node_revision:1,objective_ref:'portal:access'});
 let binding=()=>call('view',{focus:['goal'],radius:0,max_bytes:32768}).items.find(x=>x.type==='binding');assert.equal(binding().coverage.state,'unassigned');
 orch=new OrchStore(state);const r=orch.create('main',task,'synthetic-host',{max_parallel:2,heartbeat_ms:30000,task_ms:null,max_wakeups:null});
 const w=orch.add(r,{key:'access',question:'Check synthetic files',success:'Keep uncertainty',objective_ref:'portal:access',execution_plan:{kind:'materials',requirements:[]},skill_plan:{required:[],none_reason:'Synthetic data only'}});assert.equal(binding().coverage.works[0].id,w.id);assert.equal(binding().coverage.works[0].state,'pending');
 const page=call('view',{limit:1,max_bytes:2048});assert(Buffer.byteLength(JSON.stringify(page))<=2048);assert(page.next_offset);assert.throws(()=>call('view',{offset:1}),/snapshot/);
 let accumulated=[...page.items],next=page.next_offset;while(next!==null){const p=call('view',{offset:next,expected_snapshot:page.snapshot,limit:1,max_bytes:2048});accumulated.push(...p.items);next=p.next_offset;}assert.equal(accumulated.length,page.total);assert.equal(new Set(accumulated.map(x=>x.key)).size,page.total);
 w.state='adopted';orch.saveWork(w);assert.equal(binding().coverage.works[0].state,'adopted');assert.throws(()=>call('view',{offset:page.next_offset,expected_snapshot:page.snapshot}),/snapshot changed/);
 checks.push('Goal coverage reads actual current work state without treating adoption as fulfillment; bounded Unicode pages reconstruct a consistent snapshot and reject missing or changed snapshots');
 const seq=s.q('SELECT MAX(seq) AS n FROM mem_audit WHERE task=?',task).n;call('view');call('view');assert.equal(s.q('SELECT MAX(seq) AS n FROM mem_audit WHERE task=?',task).n,seq,'Read-only views cannot generate update events or model wakeups');
 const original=fs.readFileSync(workspace+'/evidence.txt');fs.writeFileSync(workspace+'/evidence.txt','changed');assert.equal(call('view',{focus:['portal']}).items.find(x=>x.type==='edge').state,'stale');fs.writeFileSync(workspace+'/evidence.txt',original);
 const portal=map.entry(task,'portal');node('portal',record('Updated portal'),'service',portal.revision);assert.equal(call('view',{focus:['portal']}).items.find(x=>x.type==='edge').state,'stale');
 call('remove',{key:'goal',expected_revision:1});const stale=call('view',{max_bytes:32768}).items.find(x=>x.key==='goal-work');assert.equal(stale.state,'stale');assert.equal(s.q('SELECT COUNT(*) AS n FROM mem_map_history WHERE task=? AND key=?',task,'goal').n,2);
 checks.push('Original-file drift, endpoint revision changes and tombstone removal invalidate dependent edges/bindings; history persists and reads cause no audit churn');
 // Cross-target edges pin both independently versioned endpoint memories.
 for(const id of ['left','right'])s.run('INSERT INTO targets VALUES(?,?,?,?)',task,id,1,'{}');
 const targetRecord=id=>{const source=s.register('main',task,{path:'evidence.txt',target_id:id,expected_generation:1});s.readSource('main',task,source.source_id);return record(id+' component',{target_id:id,expected_generation:1,evidence_refs:[{source_id:source.source_id,locator:'synthetic'}]});};
 node('left',targetRecord('left'));node('right',targetRecord('right'));edge('cross','left','right',record('Cross-target relation, still inferred'));
 s.run('INSERT INTO targets VALUES(?,?,?,?)',task,'right',2,'{}');const cross=call('view',{focus:['left'],max_bytes:32768});assert.equal(cross.items.find(x=>x.key==='right').state,'stale');assert.equal(cross.items.find(x=>x.key==='cross').state,'stale');assert.throws(()=>edge('new-cross','left','right',record('New relation')),/current/);
 checks.push('Cross-target topology checks both endpoint generations; replacing either instance invalidates the edge and blocks new stale bindings');
 const d=record('Conflicted record');node('conflict',d);const peer=record('Alternative');s.link('main',task,{left:d.id,right:peer.id,left_revision:2,right_revision:2,kind:'contradicts',reason:'Synthetic contradiction'});const conflicted=call('view',{focus:['conflict']}).items[0];assert.equal(conflicted.state,'stale');assert.equal(conflicted.basis.conflict_present,true);
 assert.throws(()=>call('bind_goal',{key:'secret',expected_revision:0,node:'unknown',node_revision:1,objective_ref:'x'}),/goal/);
 orch.close();orch=null;s.close();s=new HandoffStore(state,schema);map=new TargetMap(s);assert.equal(call('view',{focus:['left'],max_bytes:32768}).items.find(x=>x.key==='cross').state,'stale');
 checks.push('Conflicts remain visible without masking stale revisions; additive schema reopens durably without replaying execution');
}finally{orch?.close();s.close();}
const result={ok:true,checks,externalModelCalls:0,externalTargetRequests:0,fixture,source};fs.mkdirSync(base+'/.test-results',{recursive:true});fs.writeFileSync(base+'/.test-results/target-map.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
