import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath,pathToFileURL} from 'node:url';

const base=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),source=process.env.DSH_ORCHESTRATION_TEST_ROOT??base;
const {HandoffStore}=await import(pathToFileURL(source+'/plugins/analysis-memory/handoff.mjs'));
const {Knowledge}=await import(pathToFileURL(source+'/plugins/analysis-memory/knowledge.mjs'));
const fixture=fs.mkdtempSync(path.join(os.tmpdir(),'dsh-methods-')),state=fixture+'/state',workspace=fixture+'/project',other=fixture+'/other';
for(const p of [state,workspace,other])fs.mkdirSync(p);
const env={PATH:process.env.PATH,HOME:os.homedir(),LANG:'C.UTF-8',DSH_HOME:fixture,DSH_ANALYSIS_STATE:state};
function init(actor,dir=workspace){const p=spawnSync('python3',[source+'/runtime/analysis-v1/session.py','init','--session',actor,'--goal','Synthetic method reuse'],{env,encoding:'utf8'});assert.equal(p.status,0,p.stderr);const task=JSON.parse(p.stdout).result.id;return {actor,task,dir};}
const a=init('main'),b=init('next'),c=init('other',other);
let s=new HandoffStore(state,JSON.parse(fs.readFileSync(source+'/plugins/analysis-memory/candidate.schema.json','utf8')));
for(const x of [a,b,c])s.open(x.actor,x.task,x.dir);
fs.writeFileSync(workspace+'/original.txt','PRIVATE_ORIGINAL_NOT_EXPORTED: a synthetic byte contract.');
const src=s.register(a.actor,a.task,{path:'original.txt'});s.readSource(a.actor,a.task,src.source_id);
const candidate=redaction=>({schema_version:'0.2',operation_id:randomUUID(),expected_generation:0,target_id:null,kind:'method_candidate',title:'PRIVATE_CASE_NOT_EXPORTED',body:'PRIVATE_CASE_NOT_EXPORTED',origin:'inferred',verification:'untested',evidence_refs:[{source_id:src.source_id,locator:'synthetic'}],accept_scope:null,unresolved:['Current target must be verified'],details:{preconditions:['Raw bytes available'],failure_boundaries:['No original means unknown'],case_refs:['synthetic'],redaction_status:redaction}});
function record(redaction='reviewed'){const d=s.propose(a.actor,a.task,candidate(redaction));return s.review(a.actor,a.task,{id:d.id,expected_revision:1,decision:'publish',reason:'Read local synthetic original; inferred only'});}
const r=record(),unredacted=record('not_reviewed');
const card={title:'Byte encoding mismatch 字节编码差异',signals:['文本显示相同，原始字节不同'],aliases:['base64 newline mismatch'],preconditions:['Original raw bytes are available'],procedure:['Compare original length and ending bytes; choose an experiment based on the difference'],verification:['Replay exact bytes and compare full output'],failure_boundaries:['Missing original bytes means inconclusive'],counterexamples:['UI rendering can hide differing line endings'],uncertainties:['No current target verified'],tags:['encoding','evidence']};
let k=new Knowledge(s);
const skillNames=new Set(k.catalog.map(d=>d.skill)),skills=new Map([...skillNames].map(name=>[name,{name,invocation:{modelInvocable:true},resourceBase:{kind:'directory',path:base+'/skills/'+name}}]));
const run=(x,action,options={},visible=skills)=>k.command(x.actor,x.task,action,options,visible),checks=[];
try{
 const en=await run(a,'search',{query:'sign extension',kind:'reference'});assert.equal(en.items[0].id,'reverse-width');assert(en.items[0].matches.some(v=>v.field==='aliases'));assert(en.items[0].failure_boundaries.length);
 const zh=await run(a,'search',{query:'位宽 符号扩展',kind:'reference'});assert.equal(zh.items[0].id,'reverse-width');assert.equal((await run(a,'search',{query:'unlistedzzzzzz'})).total,0);
 const denied=new Map(skills);denied.set('ghidra-static',{invocation:{modelInvocable:false}});assert(!(await run(a,'search',{query:'位宽'},denied)).items.some(v=>v.skill==='ghidra-static'));await assert.rejects(run(a,'read_reference',{id:'reverse-width'},denied),/unavailable/);
 let text='',offset=0,snapshot;do{const p=await run(a,'read_reference',{id:'reverse-width',offset,max_bytes:2048,...snapshot?{snapshot}:{}});text+=p.text;offset=p.next_offset;snapshot=p.snapshot;assert(Buffer.byteLength(JSON.stringify(p))<=2048);}while(offset!==null);assert.equal(text,fs.readFileSync(base+'/skills/ghidra-static/references/pcode-width-contracts.md','utf8'));
 await assert.rejects(run(a,'read_reference',{id:'../../private'}),/unavailable/);await assert.rejects(run(a,'read_reference',{id:'reverse-width',snapshot:'old'}),/snapshot changed/);
 checks.push('Bilingual metadata routing returns reasons and negative conditions; disabled/unknown skills stay unavailable; exact Unicode original pages and stale-snapshot rejection');
 const redaction_note='Private audit note PRIVATE_REVIEW_NOTE; source '+r.id+'; removed identifiers from the card';
 const d=await run(a,'draft_method',{record_id:r.id,record_revision:r.revision,card,redaction_note});
 assert.equal((await run(a,'draft_method',{record_id:r.id,record_revision:r.revision,card:Object.fromEntries(Object.entries(card).reverse()),redaction_note})).id,d.id);
 assert.equal((await run(a,'search',{kind:'method'})).total,0);assert.equal((await run(a,'search',{kind:'method',include_history:true})).total,1);assert.equal((await run(b,'search',{kind:'method',include_history:true})).total,0);
 await assert.rejects(run(b,'read_method',{id:d.id}),/unavailable/);await assert.rejects(run(c,'read_method',{id:d.id}),/unavailable/);await assert.rejects(run(b,'review_method',{id:d.id,expected_revision:1,decision:'publish',reason:'Not mine'}),/unavailable/);
 const u=await run(a,'draft_method',{record_id:unredacted.id,record_revision:unredacted.revision,card,redaction_note:'Synthetic pending review'});await assert.rejects(run(a,'review_method',{id:u.id,expected_revision:1,decision:'publish',reason:'Too early'}),/redaction/);
 await assert.rejects(run(a,'draft_method',{record_id:r.id,record_revision:r.revision,card:{...card,procedure:['password=ThisIsSyntheticSecret123']},redaction_note:'Not redacted'}),/Sensitive/);
 await assert.rejects(run(a,'draft_method',{record_id:r.id,record_revision:1,card,redaction_note:'Old source'}),/current reviewed/);
 await run(a,'review_method',{id:d.id,expected_revision:1,decision:'publish',reason:'Checked conditions, failure boundaries and removed instance facts'});
 const found=await run(b,'search',{query:'编码差异',kind:'method'});assert.equal(found.items[0].id,d.id);assert.equal(found.items[0].state,'published');assert.equal((await run(c,'search',{kind:'method',include_history:true})).total,0);
 let raw='';offset=0;snapshot=undefined;do{const p=await run(b,'read_method',{id:d.id,expected_revision:2,offset,max_bytes:2048,...snapshot?{snapshot}:{}});raw+=p.text;offset=p.next_offset;snapshot=p.snapshot;}while(offset!==null);const shared=JSON.parse(raw);assert.deepEqual(shared.card,card);assert.equal(shared.verification,'not-validated-for-current-target');for(const hidden of [a.task,r.id,src.source_id,workspace,'PRIVATE_CASE','PRIVATE_ORIGINAL','PRIVATE_REVIEW_NOTE'])assert(!raw.includes(hidden));
 await assert.rejects(run(a,'review_method',{id:d.id,expected_revision:1,decision:'retire',reason:'Stale version'}),/revision conflict/);
 checks.push('Drafts stay within origin task; explicit redaction publication shares only sanitized cards across same-workspace tasks; other workspaces and private case provenance remain isolated');
 await run(b,'review_method',{id:d.id,expected_revision:2,decision:'retire',reason:'A new counterexample warrants withdrawal'});assert.equal((await run(a,'search',{kind:'method'})).total,0);assert.equal((await run(b,'search',{kind:'method',include_history:true})).items[0].state,'retired');await assert.rejects(run(a,'read_method',{id:d.id,expected_revision:2}),/revision changed/);
 // Exercise the public write/review API beyond legacy latest-500 scan windows.
 for(let i=0;i<505;i++){const d=await run(a,'draft_method',{record_id:r.id,record_revision:r.revision,card:{...card,title:i===0?'old_unique_sentinel':`method_${i}`},redaction_note:'Synthetic sanitized method'});await run(a,'review_method',{id:d.id,expected_revision:1,decision:'publish',reason:'Synthetic method reference only'});}
 assert.equal((await run(b,'search',{kind:'method',query:'old_unique_sentinel'})).total,1);
 const all=[],seen=new Set();offset=0;snapshot=undefined;do{const p=await run(b,'search',{kind:'method',offset,limit:7,max_bytes:2048,...snapshot?{snapshot}:{}});all.push(...p.items);assert(Buffer.byteLength(JSON.stringify(p))<=2048);offset=p.next_offset;snapshot=p.snapshot;}while(offset!==null);assert.equal(all.length,505);for(const item of all){assert(!seen.has(item.id));seen.add(item.id);}
 const before=await run(b,'search',{kind:'method',limit:1});await run(a,'review_method',{id:all[0].id,expected_revision:2,decision:'retire',reason:'Retire test'});await assert.rejects(run(b,'search',{kind:'method',snapshot:before.snapshot,offset:1}),/search changed/);
 checks.push('All 505 published methods are searchable and paged without a history-count cap; older matches survive and concurrent library changes invalidate page snapshots');
 fs.writeFileSync(workspace+'/original.txt','Changed original');assert.equal((await run(b,'search',{kind:'method'})).total,0);const historical=await run(b,'search',{kind:'method',include_history:true});assert(historical.items.every(v=>v.source_status==='needs_recheck'));
 await assert.rejects(run(a,'review_method',{id:u.id,expected_revision:1,decision:'publish',reason:'Source changed'}),/Source changed/);
 s.close();s=new HandoffStore(state,JSON.parse(fs.readFileSync(source+'/plugins/analysis-memory/candidate.schema.json','utf8')));k=new Knowledge(s);assert.equal((await run(b,'search',{kind:'method',include_history:true})).total,506);assert(s.q("SELECT value FROM mem_meta WHERE key='method-library'").value==='1');
 checks.push('Source drift hides default reuse without erasing counterexamples/history; status revisions and private provenance survive database reopen');
}finally{s.close();}
const report={ok:true,checks,fixture,installedSource:source,externalModelCalls:0,externalTargetRequests:0,limitation:'Mechanisms and authored routing cases only; not model understanding or measured solving gains'};fs.mkdirSync(base+'/.test-results',{recursive:true});fs.writeFileSync(base+'/.test-results/knowledge-library.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
