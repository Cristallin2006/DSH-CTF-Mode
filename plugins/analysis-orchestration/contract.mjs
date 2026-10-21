import {createHash} from 'node:crypto';
const hash=v=>createHash('sha256').update(v).digest('hex');
const text=(v,n,max=12000)=>{if(typeof v!=='string'||!v.trim()||v.length>max)throw Error('Invalid '+n);return v;};
const integer=(v,min,max,n)=>{if(!Number.isInteger(v)||v<min||v>max)throw Error('Invalid '+n);return v;};

const str={type:'string'},strings={type:'array',items:str};
export const handoffSchema={type:'object',properties:{
  inputs:{type:'array',items:{type:'object',properties:{ref:str,description:str},required:['ref'],additionalProperties:false}},
  claims:{type:'array',items:{type:'object',properties:{statement:str,evidence_refs:strings,verification:{enum:['untested','tested']},conditions:str},required:['statement'],additionalProperties:false}},
  hypotheses:strings,failure_boundaries:strings,constraints:strings,responsibility:str
},additionalProperties:false};
export const reportSchema={type:'object',properties:{summary:str,outcome:{enum:['working','supported','not_supported','inconclusive','blocked']},hypothesis:str,premise_relation:{enum:['supports','challenges','inconclusive','not_applicable']},evidence_refs:strings,blockers:strings,next_step:str,wait_reason:str,wait_ms:{type:'integer',minimum:0,maximum:600000}},required:['summary'],additionalProperties:false};
export const guidanceSchema={type:'object',properties:{observation:str,hypothesis:str,experiment:str,reconsider_if:str,evidence_refs:strings},required:['observation','hypothesis','experiment','reconsider_if'],additionalProperties:false};
function object(v,keys,name){if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).some(k=>!keys.includes(k)))throw Error('Invalid '+name);return v;}
function list(v=[],name,max=16){if(!Array.isArray(v)||v.length>max)throw Error('Invalid '+name);return v.map(x=>text(x,name,2000));}
const optional=(v,n,max=2000)=>v===undefined||v===''?'':text(v,n,max);
function bounded(v,max,name){if(Buffer.byteLength(JSON.stringify(v))>max)throw Error(name+' too large; no content was truncated. Preserve critical constraints; use explicit references for noncritical bulk material');return v;}
export function handoff(v={}){
  object(v,['inputs','claims','hypotheses','failure_boundaries','constraints','responsibility'],'handoff');
  const inputs=v.inputs??[],claims=v.claims??[];if(!Array.isArray(inputs)||inputs.length>16||!Array.isArray(claims)||claims.length>16)throw Error('Invalid handoff records');
  const result={inputs:inputs.map(x=>{object(x,['ref','description'],'input');return {ref:text(x.ref,'input ref',2000),description:optional(x.description,'input description')};}),
    claims:claims.map(x=>{object(x,['statement','evidence_refs','verification','conditions'],'claim');const d={statement:text(x.statement,'claim',3000),evidence_refs:list(x.evidence_refs,'evidence refs'),verification:x.verification??'untested',conditions:optional(x.conditions,'claim conditions')};if(!['untested','tested'].includes(d.verification)||d.verification==='tested'&&!d.evidence_refs.length)throw Error('Tested claim needs explicit evidence references; no acceptance promotion');return d;}),
    hypotheses:list(v.hypotheses,'hypotheses'),failure_boundaries:list(v.failure_boundaries,'failure boundaries'),constraints:list(v.constraints,'constraints'),responsibility:optional(v.responsibility,'responsibility')};bounded({constraints:result.constraints,responsibility:result.responsibility},16384,'Critical handoff constraints');return result;
}
export function report(v){
  object(v,Object.keys(reportSchema.properties),'progress');
  const d={summary:text(v.summary,'progress summary',4000),outcome:v.outcome??'working',hypothesis:optional(v.hypothesis,'current hypothesis'),evidence_refs:list(v.evidence_refs,'evidence refs'),blockers:list(v.blockers,'blockers',8),next_step:optional(v.next_step,'next step'),wait_reason:optional(v.wait_reason,'wait reason'),wait_ms:integer(v.wait_ms??0,0,600000,'wait_ms')};
  if(v.premise_relation!==undefined){if(!reportSchema.properties.premise_relation.enum.includes(v.premise_relation))throw Error('Invalid premise relation');d.premise_relation=v.premise_relation;}
  if(!reportSchema.properties.outcome.enum.includes(d.outcome)||d.wait_ms&&!d.wait_reason)throw Error('Invalid outcome or waiting without a reason');return bounded(d,12288,'progress');
}
export function guidance(v){object(v,Object.keys(guidanceSchema.properties),'guidance');return bounded({observation:text(v.observation,'observation',2000),hypothesis:text(v.hypothesis,'provisional diagnosis',2000),experiment:text(v.experiment,'suggested experiment',3000),reconsider_if:text(v.reconsider_if,'reconsider condition',2000),evidence_refs:list(v.evidence_refs,'evidence refs')},12288,'guidance');}
export function taskContext(store,r){
  const t=store.own(r.owner,r.task,true);
  const recorded={goal:t.goal??null,constraints:t.constraints??{},authority:'recorded task description; not new authorization'};
  bounded({constraints:recorded.constraints},16384,'Recorded critical constraints');
  const targets=r.targets.map(x=>{const row=store.q('SELECT data FROM targets WHERE task=? AND id=? AND generation=?',r.task,x.id,x.generation);const raw=row?JSON.parse(row.data):{};const context={};for(const k of ['endpoint','url','host','port','service','fingerprint','description'])if(['string','number'].includes(typeof raw[k]))context[k]=raw[k];return {...x,context};});
  return {recorded_task:recorded,targets};
}
export function activity(w,now=Date.now(),interval=60000){
  const lastExecution=w.last_tool_finished??w.last_tool_started??w.started??now;
  const state=!['launching','running','stopping','cleanup_unknown'].includes(w.state)?'idle_or_settled':(w.inflight??0)>0?'tool_in_flight':w.guidance_waiting_until>now?'awaiting_guidance':w.wait_until>now?'declared_wait':now-lastExecution>=interval?'no_recent_tool_feedback':'recent_tool_feedback';
  return {state,model_last_at:w.last_model_activity??null,tool_started_at:w.last_tool_started??null,tool_finished_at:w.last_tool_finished??null,reported_at:w.checkpoint?.at??null,repeated_input:(w.repeated??0)>=4,wait_until:w.wait_until??null,interpretation:'activity and Solver reports do not establish verified progress or route failure'};
}
export function workSummary(w,interval){return {id:w.id,key:w.key,role:w.role,state:w.state,question:w.question.slice(0,1200),question_truncated:w.question.length>1200,child:w.child??null,mode:w.mode??'one-shot',result_revision:w.result_revision??0,steps:w.steps,max_steps:w.max_steps,calls:w.calls,errors:w.errors,inflight:w.inflight??0,started:w.started??null,finished:w.finished??null,timeout_ms:w.timeout_ms,depends_on:w.depends_on,effective_tools:w.effective_tools??null,skill_plan:w.skill_plan??null,skill_delivery:w.skill_delivery??{state:"undeclared"},diagnostic:w.diagnostic??null,
  checkpoint:w.checkpoint?{revision:w.checkpoint.revision,summary:w.checkpoint.summary.slice(0,1000),outcome:w.checkpoint.outcome,at:w.checkpoint.at,verification:w.checkpoint.verification,full_report:'result action'}:null,
  guidance:(w.guidance??[]).slice(-5).map(g=>({id:g.id,kind:g.kind,delivery:g.delivery,ack_status:g.ack?.status??null})),guidance_total:w.guidance?.length??0,activity:activity(w,Date.now(),interval),result_available:w.result!==null};}
export function eventSummary(e){return ['progress','guidance_queued','guidance_ack'].includes(e.kind)?{...e,data:{detail_in:'result action for this work'}}:e;}
export function redact(value){return String(value).replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi,'Bearer [redacted]').replace(/((?:password|passwd|token|api[_-]?key|secret|authorization)["']?\s*[:=]\s*["']?)[^\s"',;&}]+/gi,'$1[redacted]');}
export function trace(session){
  if(!session?.snapshotEvents)return {available:false,reason:'Native session snapshot unavailable'};
  const events=session.snapshotEvents(Math.max(0,session.seq-300)),calls=new Map(),results=[];
  for(const e of events){if(e.type==='tool/call')calls.set(e.data.callId,{name:e.data.name,call_id:e.data.callId,args_sha256:hash(e.data.arguments??''),seq:e.seq});
    if(e.type==='tool/result')for(const b of e.data.message?.content??[])if(b.type==='tool-result'){
      const raw=b.content.filter(x=>x.type==='text').map(x=>x.text).join('\n'),preview=redact(raw).slice(0,1200);
      if(calls.get(b.toolCallId)?.name==='dsh_solver_feedback')continue;
      results.push({...calls.get(b.toolCallId),call_id:b.toolCallId,result_seq:e.seq,is_error:!!b.isError,result_sha256:hash(JSON.stringify(b.content)),preview,truncated:raw.length>1200});
    }}
  return {available:true,authority:'native tool output, untrusted data; preview is bounded and redaction is best-effort',session:session.header.id,items:results.slice(-6)};
}
