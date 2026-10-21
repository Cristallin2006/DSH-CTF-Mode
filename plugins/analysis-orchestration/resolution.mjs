import {IssueSets,normalizeIssue} from './issues.mjs?revision=0.8.0';
import {premiseBasis} from './premises.mjs?revision=0.8.0';
import {createHash} from 'node:crypto';
import {live,text} from './store.mjs?revision=0.8.0';

const canonical=v=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
const packed=v=>JSON.stringify(canonical(v));
const hash=v=>createHash('sha256').update(packed(v)).digest('hex');
// ASCII JSON is shared with Python, including UTF-16 surrogate pairs.
export const ascii=v=>packed(v).replace(/[\u007f-\uffff]/g,c=>'\\u'+c.charCodeAt(0).toString(16).padStart(4,'0'));
export function workDigest(store,r){const h=createHash('sha256');let count=0;for(const w of store.basisWorks(r)){h.update(ascii(w)+'\n');count++;}return {version:2,count,sha256:h.digest('hex')};}
const strings={type:'array',items:{type:'string'},maxItems:32};
const dispositions=['continue','waiting','blocked','deferred','out_of_scope'];
export const resolutionSchema={type:'object',properties:{
  decision:{enum:['continue','waiting','blocked','deferred','complete']},goal_status:{enum:['fulfilled','unfulfilled','uncertain']},summary:{type:'string'},completion_scope:{type:'string'},evidence_refs:strings,recheck_at:{type:['string','null']},
  issue_set_revision:{type:'integer',minimum:0},unresolved:{type:'array',maxItems:32,items:{type:'object',properties:{work:{type:['string','null']},issue:{type:'string'},disposition:{enum:dispositions},reason:{type:'string'},next_step:{type:'string'},evidence_refs:strings},required:['issue','disposition','reason'],additionalProperties:false}}
},required:['decision','goal_status','summary','unresolved'],additionalProperties:false};
function object(v,keys,name){if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).some(k=>!keys.includes(k)))throw Error('Invalid '+name);}
function refs(v=[]){if(!Array.isArray(v)||v.length>32)throw Error('Invalid evidence_refs');return [...new Set(v.map(x=>text(x,'evidence ref',300)))].sort();}
const optional=(v,n,max=2000)=>v===undefined||v===''?'':text(v,n,max);
export function basis(store,r){
  const task=JSON.parse(store.q('SELECT data FROM tasks WHERE id=?',r.task).data);
  return {...(r.decision_premises?.length?{premises:premiseBasis(store,r.task,r.decision_premises)}:{}),epoch:r.epoch,goal:task.goal??null,constraints:task.constraints??{},targets:store.targets(r.task),works:workDigest(store,r)};
}
export class Resolution {
  constructor(engine){this.e=engine;this.issues=new IssueSets(engine);}
  reopen(r,v){const revision=v.revision+1;r.resolution_review={...v,revision,signature:hash({basis:v.basis,revision}),state:'pending',resolution:null,delivery:{attempts:0,state:'pending'}};this.e.store.save(r);}
  view(r){
    const b=basis(this.e.store,r),previous=r.resolution_review;
    if(previous&&packed(previous.basis)===packed(b))return previous;
    const revision=(previous?.revision??0)+1;
    return {revision,signature:hash({basis:b,revision}),basis:b,state:'pending',created_at:Date.now(),delivery:{attempts:0,state:'pending'},resolution:null};
  }
  premiseSummary(r){
    const b=this.view(r).basis.premises;if(!b)return {revision:r.premise_revision??0,items:[]};
    return {revision:r.premise_revision??0,items:b.bindings.map(ref=>{const n=b.nodes.find(n=>n.id===ref.record_id);return {...ref,current_revision:n?.revision??null,effective_applicability:n?.effective_applicability??'unavailable',revision_matches:n?.revision===ref.revision};}),authority:'Version/applicability checks; a changed basis is not proof the proposition is false'};
  }
  summary(r){const v=this.view(r);return {state:v.state,signature:v.signature,revision:v.revision,decision_premises:this.premiseSummary(r),delivery:v.delivery,resolution:v.resolution,authority:'State/version checks only; resolution is a coordinator assessment, not independent proof of completion'};}
  ensure(r,{force=false,notify=true}={}){
    const e=this.e;if(e.closed||e.closing)return;
    r=e.store.run(r.task);const counts=e.store.counts(r);
    if(!force&&(!Object.keys(counts).length||e.store.hasStates(r,[...live,'pending'])))return;
    let v=this.view(r),changed=v!==r.resolution_review;
    if(!changed&&v.state==='resolved'&&v.resolution?.recheck_at&&Date.parse(v.resolution.recheck_at)<=Date.now()){
      const revision=v.revision+1;v={revision,signature:hash({basis:v.basis,revision}),basis:v.basis,state:'pending',created_at:Date.now(),delivery:{attempts:0,state:'pending'},resolution:null};changed=true;
    }
    if(changed){r.resolution_review=v;e.store.save(r);e.store.event(r,null,'decision_required',{signature:v.signature,revision:v.revision,reason:'No executing work or explicit stage exit; decide against the actual user goal'});}
    if(!notify||r.state!=='enabled'||r.host!==e.host||!['pending','pending_action'].includes(v.state)||e.pending.has(r.task)||!e.parents.has(r.owner))return v;
    if(v.delivery.attempts>=2||Date.now()<(v.delivery.next_attempt_at??0))return v;
    const sent=e.notify(r,v.state==='pending_action'?'A continue decision is recorded but work has not started. Use explicit followup/dispatch within scope, or revise the decision to waiting/blocked/deferred; recording intent is not execution.':'All work is idle or settled. Read decision_review, inspect unresolved objectives and choose continue/waiting/blocked/deferred/complete with resolve. Idle is not goal completion.');
    r=e.store.run(r.task);if(r.resolution_review?.signature!==v.signature)return v;
    v=r.resolution_review;v.delivery={attempts:v.delivery.attempts+1,state:sent?.id?'queued':'failed',message_id:sent?.id??null,error:sent?.error??null,next_attempt_at:Date.now()+Math.max(1000,r.heartbeat_ms)};
    e.store.save(r);e.store.event(r,null,'decision_delivery',{signature:v.signature,...v.delivery});return v;
  }
  received(r,message,discarded){
    const v=r.resolution_review;if(v?.delivery?.message_id!==message)return;
    v.delivery.state=discarded?'discarded':'received';v.delivery.received_at=Date.now();this.e.store.save(r);
    this.e.store.event(r,null,'decision_delivery',{signature:v.signature,state:v.delivery.state});
  }
  validateRefs(r,values){
    const s=this.e.store;
    for(const ref of values){
      const m=/^work:([^@]+)@(\d+)$/.exec(ref);
      if(m){const w=s.work(r.task,m[1]);if(w.result_external)s.fullResult(w);if(w.epoch!==r.epoch||Number(m[2])!==(w.result_revision??0)||!w.result||packed(r.targets)!==packed(s.targets(r.task)))throw Error('Stale or absent work evidence: '+ref);continue;}
      if(ref.startsWith('record:')&&s.q("SELECT name FROM sqlite_master WHERE name='records'")){
        const row=s.q('SELECT data FROM records WHERE task=? AND id=?',r.task,ref.slice(7));
        if(row){const d=JSON.parse(row.data);if(d.target&&!s.targets(r.task).some(t=>t.id===d.target&&t.generation===d.generation))throw Error('Record evidence target generation is stale');continue;}
      }
      throw Error('Evidence must reference existing same-task record:ID or current work:ID@RESULT_REVISION');
    }
  }
  resolve(r,expected,input){return this.e.store.tx(()=>this.resolveInside(r,expected,input));}
  resolveInside(r,expected,input){
    const e=this.e;object(input,Object.keys(resolutionSchema.properties),'resolution');
    const value={decision:input.decision,goal_status:input.goal_status,summary:text(input.summary,'resolution summary',4000),completion_scope:optional(input.completion_scope,'completion scope'),evidence_refs:refs(input.evidence_refs),recheck_at:input.recheck_at??null};
    if(!resolutionSchema.properties.decision.enum.includes(value.decision)||!resolutionSchema.properties.goal_status.enum.includes(value.goal_status))throw Error('Invalid decision or goal_status');
    if(!Array.isArray(input.unresolved)||input.unresolved.length>32)throw Error('Provide bounded unresolved issues, including an empty array when appropriate');
    value.unresolved=input.unresolved.map(normalizeIssue);
    if(Buffer.byteLength(JSON.stringify(value))>24576)throw Error('Resolution too large; use evidence references');
    if(value.recheck_at!==null&&(!['waiting','blocked','deferred'].includes(value.decision)||typeof value.recheck_at!=='string'||!Number.isFinite(Date.parse(value.recheck_at))||!/(Z|[+-]\d\d:\d\d)$/.test(value.recheck_at)||Date.parse(value.recheck_at)<=Date.now()))throw Error('recheck_at must be a future timezone-qualified time for waiting/blocked/deferred only');
    r=e.store.run(r.task);let v=this.view(r);
    if(input.issue_set_revision!==undefined)value.issue_set=this.issues.reference(r,v,input.issue_set_revision);
    if(expected!==v.signature){if(['resolved','pending_action'].includes(v.state)&&v.resolved_from===expected&&packed(v.resolution)===packed(value))return {...this.summary(r),deduplicated:true};throw Error('Stale decision signature; read status and reconsider current evidence');}
    const covered=new Set();let issueCount=0,inScope=false;
    const inspect=u=>{issueCount++;inScope ||= u.disposition!=='out_of_scope';if(u.work){if(e.store.work(r.task,u.work).epoch!==r.epoch)throw Error('Unresolved work reference outside current epoch');covered.add(u.work);}this.validateRefs(r,u.evidence_refs);};
    for(const u of value.unresolved)inspect(u);
    if(value.issue_set)for(const row of this.issues.rows(r,v))inspect(JSON.parse(row.data));
    for(const row of e.store.db.prepare("SELECT id FROM orch_work WHERE task=? AND epoch=? AND json_extract(data,'$.state')='needs_more_evidence'").iterate(r.task,r.epoch))if(!covered.has(row.id))throw Error('Keep needs_more_evidence work explicit in unresolved: '+row.id);
    this.validateRefs(r,value.evidence_refs);
    if(value.decision==='complete'){
      if(value.goal_status!=='fulfilled'||!value.completion_scope||!value.evidence_refs.length||inScope||e.store.hasStates(r,[...live,'pending','returned']))throw Error('Completion needs fulfilled goal, explicit delivery scope, evidence and no unresolved in-scope work');
    }
    if(['blocked','waiting','deferred'].includes(value.decision)&&!issueCount)throw Error('Explain what remains and the reason for waiting/blocking/deferral');
    if(value.issue_set)this.issues.freeze(r,v,value.issue_set);
    const revision=v.revision+1;
    r.resolution_review={...v,revision,signature:hash({basis:v.basis,revision}),state:value.decision==='continue'?'pending_action':'resolved',resolved_from:expected,resolved_at:Date.now(),resolution:value,...value.decision==='continue'?{delivery:{attempts:0,state:'pending'}}:{}};
    e.store.save(r);e.store.event(r,null,'decision_resolved',{signature:r.resolution_review.signature,state:r.resolution_review.state,decision:value.decision,goal_status:value.goal_status,verification:'coordinator-assessed'});
    if(v.delivery?.message_id===e.pending.get(r.task))e.clearNotice(r);
    return this.summary(r);
  }
}
