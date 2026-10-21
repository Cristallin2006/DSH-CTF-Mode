import {premiseBasis} from './premises.mjs?revision=0.7.1';
import {createHash} from 'node:crypto';
import {live,text} from './store.mjs?revision=0.7.1';

const canonical=v=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
const packed=v=>JSON.stringify(canonical(v));
const hash=v=>createHash('sha256').update(packed(v)).digest('hex');
const strings={type:'array',items:{type:'string'},maxItems:32};
const dispositions=['continue','waiting','blocked','deferred','out_of_scope'];
export const resolutionSchema={type:'object',properties:{
  decision:{enum:['continue','waiting','blocked','deferred','complete']},goal_status:{enum:['fulfilled','unfulfilled','uncertain']},summary:{type:'string'},completion_scope:{type:'string'},evidence_refs:strings,recheck_at:{type:['string','null']},
  unresolved:{type:'array',maxItems:32,items:{type:'object',properties:{work:{type:['string','null']},issue:{type:'string'},disposition:{enum:dispositions},reason:{type:'string'},next_step:{type:'string'},evidence_refs:strings},required:['issue','disposition','reason'],additionalProperties:false}}
},required:['decision','goal_status','summary','unresolved'],additionalProperties:false};
function object(v,keys,name){if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).some(k=>!keys.includes(k)))throw Error('Invalid '+name);}
function refs(v=[]){if(!Array.isArray(v)||v.length>32)throw Error('Invalid evidence_refs');return [...new Set(v.map(x=>text(x,'evidence ref',300)))].sort();}
const optional=(v,n,max=2000)=>v===undefined||v===''?'':text(v,n,max);
export function basis(store,r){
  const task=JSON.parse(store.q('SELECT data FROM tasks WHERE id=?',r.task).data);
  return {...(r.decision_premises?.length?{premises:premiseBasis(store,r.task,r.decision_premises)}:{}),epoch:r.epoch,goal:task.goal??null,constraints:task.constraints??{},targets:store.targets(r.task),works:store.works(r).map(w=>({
    id:w.id,state:w.state,result_revision:w.result_revision??0,
    review:w.review?{decision:w.review.decision,result_revision:w.review.result_revision??0}:null,
    feedback:{outcome:w.checkpoint?.outcome??null,evidence_refs:[...new Set(w.checkpoint?.evidence_refs??[])].sort()}
  })).sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0)};
}
export class Resolution {
  constructor(engine){this.e=engine;}
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
    r=e.store.run(r.task);const works=e.store.works(r);
    if(!force&&(!works.length||works.some(w=>live.has(w.state)||w.state==='pending')))return;
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
      if(m){const w=s.work(r.task,m[1]);if(w.epoch!==r.epoch||Number(m[2])!==(w.result_revision??0)||!w.result||packed(r.targets)!==packed(s.targets(r.task)))throw Error('Stale or absent work evidence: '+ref);continue;}
      if(ref.startsWith('record:')&&s.q("SELECT name FROM sqlite_master WHERE name='records'")){
        const row=s.q('SELECT data FROM records WHERE task=? AND id=?',r.task,ref.slice(7));
        if(row){const d=JSON.parse(row.data);if(d.target&&!s.targets(r.task).some(t=>t.id===d.target&&t.generation===d.generation))throw Error('Record evidence target generation is stale');continue;}
      }
      throw Error('Evidence must reference existing same-task record:ID or current work:ID@RESULT_REVISION');
    }
  }
  resolve(r,expected,input){
    const e=this.e;object(input,Object.keys(resolutionSchema.properties),'resolution');
    const value={decision:input.decision,goal_status:input.goal_status,summary:text(input.summary,'resolution summary',4000),completion_scope:optional(input.completion_scope,'completion scope'),evidence_refs:refs(input.evidence_refs),recheck_at:input.recheck_at??null};
    if(!resolutionSchema.properties.decision.enum.includes(value.decision)||!resolutionSchema.properties.goal_status.enum.includes(value.goal_status))throw Error('Invalid decision or goal_status');
    if(!Array.isArray(input.unresolved)||input.unresolved.length>32)throw Error('Provide bounded unresolved issues, including an empty array when appropriate');
    value.unresolved=input.unresolved.map(u=>{object(u,['work','issue','disposition','reason','next_step','evidence_refs'],'unresolved issue');if(!dispositions.includes(u.disposition))throw Error('Invalid issue disposition');return {work:u.work==null?null:text(u.work,'work ref',200),issue:text(u.issue,'unresolved issue',2000),disposition:u.disposition,reason:text(u.reason,'issue reason',2000),next_step:optional(u.next_step,'next step'),evidence_refs:refs(u.evidence_refs)};});
    if(Buffer.byteLength(JSON.stringify(value))>24576)throw Error('Resolution too large; use evidence references');
    if(value.recheck_at!==null&&(!['waiting','blocked','deferred'].includes(value.decision)||typeof value.recheck_at!=='string'||!Number.isFinite(Date.parse(value.recheck_at))||!/(Z|[+-]\d\d:\d\d)$/.test(value.recheck_at)||Date.parse(value.recheck_at)<=Date.now()))throw Error('recheck_at must be a future timezone-qualified time for waiting/blocked/deferred only');
    r=e.store.run(r.task);let v=this.view(r);
    if(expected!==v.signature){if(['resolved','pending_action'].includes(v.state)&&v.resolved_from===expected&&packed(v.resolution)===packed(value))return {...this.summary(r),deduplicated:true};throw Error('Stale decision signature; read status and reconsider current evidence');}
    const works=e.store.works(r);
    for(const u of value.unresolved)if(u.work&&!works.some(w=>w.id===u.work))throw Error('Unresolved work reference outside current epoch');
    for(const w of works)if(w.state==='needs_more_evidence'&&!value.unresolved.some(u=>u.work===w.id))throw Error('Keep needs_more_evidence work explicit in unresolved: '+w.id);
    this.validateRefs(r,[...value.evidence_refs,...value.unresolved.flatMap(u=>u.evidence_refs)]);
    if(value.decision==='complete'){
      if(value.goal_status!=='fulfilled'||!value.completion_scope||!value.evidence_refs.length||value.unresolved.some(u=>u.disposition!=='out_of_scope')||works.some(w=>live.has(w.state)||['pending','returned'].includes(w.state)))throw Error('Completion needs fulfilled goal, explicit delivery scope, evidence and no unresolved in-scope work');
    }
    if(['blocked','waiting','deferred'].includes(value.decision)&&!value.unresolved.length)throw Error('Explain what remains and the reason for waiting/blocking/deferral');
    const revision=v.revision+1;
    r.resolution_review={...v,revision,signature:hash({basis:v.basis,revision}),state:value.decision==='continue'?'pending_action':'resolved',resolved_from:expected,resolved_at:Date.now(),resolution:value,...value.decision==='continue'?{delivery:{attempts:0,state:'pending'}}:{}};
    e.store.save(r);e.store.event(r,null,'decision_resolved',{signature:r.resolution_review.signature,state:r.resolution_review.state,decision:value.decision,goal_status:value.goal_status,verification:'coordinator-assessed'});
    if(v.delivery?.message_id===e.pending.get(r.task))e.clearNotice(r);
    return this.summary(r);
  }
}
