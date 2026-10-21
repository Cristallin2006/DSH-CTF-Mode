import {hash,text,integer} from './store.mjs?revision=0.7.1';
import {premiseBasis} from './premises.mjs?revision=0.7.1';

const str={type:'string'},strings={type:'array',items:str,maxItems:16};
export const memoryPlanSchema={type:'object',properties:{bindings:{type:'array',maxItems:40,items:{type:'object',properties:{record_id:str,revision:{type:'integer',minimum:1},use:{enum:['context','premise','challenge']}},required:['record_id','revision','use'],additionalProperties:false}},sources:{type:'array',maxItems:40,items:{type:'object',properties:{source_id:str,sha256:str,access:{enum:['full','ranges']},ranges:{type:'array',maxItems:16,items:{type:'array',items:{type:'integer',minimum:0},minItems:2,maxItems:2}}},required:['source_id','sha256','access'],additionalProperties:false}}},additionalProperties:false};
export const premiseSchema={type:'array',maxItems:40,items:{type:'object',properties:{record_id:str,revision:{type:'integer',minimum:1}},required:['record_id','revision'],additionalProperties:false}};
export const contrastSchema={type:'object',properties:{mode:{enum:['informed','independent']},basis:{type:'object',properties:{source_result_revision:{type:'integer',minimum:1},source_checkpoint_revision:{type:'integer',minimum:1},source_assignment_fingerprint:str},additionalProperties:false},question:str,challenged_premise:{type:'object',properties:{statement:str,memory_ref:{type:'object',properties:{id:str,revision:{type:'integer',minimum:1}},required:['id','revision'],additionalProperties:false}},required:['statement'],additionalProperties:false},difference_axes:{type:'array',items:{enum:['evidence_source','method','conditions','interpretation','responsibility']},minItems:1,maxItems:5},approach:str,discriminating_outcomes:strings,required_sources:strings},required:['basis','question','challenged_premise','difference_axes','approach','discriminating_outcomes'],additionalProperties:false};
const object=(v,keys)=>{if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).some(k=>!keys.includes(k)))throw Error('Invalid collaboration contract');};
export const independent=w=>w.contrast_plan?.mode==='independent';
export function contrast(store,r,o){
  if(o.contrast_plan===undefined)return;
  const c=structuredClone(o.contrast_plan);object(c,Object.keys(contrastSchema.properties));if(!['independent_branch','review'].includes(o.assignment_kind)||!o.source_work)throw Error('Contrast requires an explicit branch source');
  const source=store.work(r.task,o.source_work);if(source.epoch!==r.epoch)throw Error('Contrast source belongs to old epoch');
  object(c.basis,Object.keys(contrastSchema.properties.basis.properties));if(!Object.keys(c.basis).length)throw Error('Contrast needs an actual source basis');
  for(const [field,value] of Object.entries(c.basis)){if(field==='source_assignment_fingerprint'){if(value!==source.fingerprint)throw Error('Contrast assignment basis mismatch');}else {integer(value,1,Number.MAX_SAFE_INTEGER,field);const actual=field==='source_result_revision'?source.result_revision:source.checkpoint?.revision;if(actual!==value)throw Error('Contrast source revision mismatch');}}
  c.mode??='informed';if(!['informed','independent'].includes(c.mode))throw Error('Invalid contrast mode');
  for(const k of ['question','approach'])text(c[k],k,3000);object(c.challenged_premise,['statement','memory_ref']);text(c.challenged_premise.statement,'challenged proposition',3000);
  if(c.challenged_premise.memory_ref){const m=c.challenged_premise.memory_ref;object(m,['id','revision']);integer(m.revision,1,Number.MAX_SAFE_INTEGER,'memory revision');const row=store.q('SELECT data FROM mem_revisions WHERE task=? AND id=? AND rev=?',r.task,m.id,m.revision);if(!row)throw Error('Contrast memory basis unavailable');const d=JSON.parse(row.data);if(d.target_id===null?d.expected_generation!==0:!r.targets.some(t=>t.id===d.target_id&&t.generation===d.expected_generation))throw Error('Contrast memory target generation changed');}
  if(!Array.isArray(c.difference_axes)||!c.difference_axes.length||c.difference_axes.length>5||c.difference_axes.some(a=>!contrastSchema.properties.difference_axes.items.enum.includes(a)))throw Error('Declare an evidence or responsibility difference');
  if(!Array.isArray(c.discriminating_outcomes)||!c.discriminating_outcomes.length||c.discriminating_outcomes.length>16)throw Error('Declare discriminating outcomes');c.discriminating_outcomes.forEach(s=>text(s,'discriminating outcome',1000));
  c.required_sources??=[];if(!Array.isArray(c.required_sources)||c.required_sources.length>16)throw Error('Invalid required sources');
  for(const id of c.required_sources)if(!o.memory_plan?.sources?.some(s=>s.source_id===id))throw Error('Required contrast source needs an explicit source grant');
  if(c.mode==='independent'&&(o.memory_plan?.bindings?.length||o.handoff&&Object.keys(o.handoff).length||o.depends_on?.length||o.role==='observer'))throw Error('Independent contrast uses neutral question and source grants only; omit memory bindings, handoff, dependencies and Observer role');
  return c;
}
export function contrastState(store,r,w){
  const c=w.contrast_plan;if(!c)return null;const s=store.work(r.task,w.source_work),current={source_result_revision:s.result_revision??0,source_checkpoint_revision:s.checkpoint?.revision??0,source_assignment_fingerprint:s.fingerprint};
  const ref=c.challenged_premise.memory_ref,n=ref?premiseBasis(store,r.task,[{record_id:ref.id,revision:ref.revision}]).nodes.find(n=>n.id===ref.id):null;
  const memory=ref?{record_id:ref.id,used_revision:ref.revision,current_revision:n?.revision??null,effective_applicability:n?.effective_applicability??'unavailable'}:null;
  return {mode:c.mode,basis:c.basis,challenged_memory:memory,basis_current:Object.entries(c.basis).every(([k,v])=>current[k]===v)&&(!ref||n?.revision===ref.revision&&['current','disputed'].includes(n?.effective_applicability)),interpretation:'A changed basis needs review; it neither cancels this work nor proves its result false'};
}
export class Collaborative {
  constructor(engine){this.e=engine;this.dispose=new Map();}
  broker(){const b=this.e.ctx.get?.('analysisMemoryBroker');if(!b)throw Error('Restricted memory service unavailable');return b;}
  prepare(r,o){
    const c=contrast(this.e.store,r,o);
    if(o.memory_plan!==undefined){if(o.role==='observer')throw Error('Observer has no memory tools');this.broker().normalize(r.owner,r.task,o.memory_plan);}
    return c;
  }
  principal(agent,signal){
    const e=this.e,sid=agent?.session?.header?.id,item=e.children.get(sid);if(!item||item.orphan)throw Error('Only a live assigned Solver can recall memory');
    const r=e.store.run(item.task),w=e.store.work(item.task,item.id);
    const p={task:r?.task,owner:r?.owner,host:e.host,epoch:r?.epoch,work:w.id,child:sid,turn:w.turn_serial??1};
    p.check=()=>{if(e.closed||e.closing||signal?.aborted||item.controller.signal.aborted||e.children.get(sid)!==item||e.ctx.agents?.get(sid)!==agent||agent.session.header.parentSession!==p.owner)throw Error('Solver memory unavailable');const current=e.store.run(p.task),work=e.store.work(p.task,p.work);if(!current||current.owner!==p.owner||current.host!==p.host||current.epoch!==p.epoch||current.state!=='enabled'||work.child!==sid||work.host!==p.host||work.epoch!==p.epoch||(work.turn_serial??1)!==p.turn||work.role==='observer'||!['launching','running'].includes(work.state)||work.memory_plan===undefined)throw Error('Solver memory unavailable');e.store.scope(current);};p.check();return p;
  }
  boundary(agent,signal){
    const item=this.e.children.get(agent?.session?.header?.id);if(!item)return;const w=this.e.store.work(item.task,item.id);if(w.memory_plan===undefined)return;
    const p=this.principal(agent,signal);try{this.broker().boundary(p);}catch(error){w.memory_warning='Restricted memory unavailable; use original assigned evidence or report missing scope';this.e.store.saveWork(w);return;}
  }
  assemble(assembly,context){
    const e=this.e,item=e.children.get(context.agent?.session?.header?.id);if(!item||e.closed||e.closing)return assembly;
    const w=e.store.work(item.task,item.id);if(w.memory_plan===undefined||w.role==='observer')return assembly;
    let text;try{const p=this.principal(context.agent,context.signal);this.broker().boundary(p);text='[DSH current restricted memory] '+JSON.stringify(this.broker().status(p));}catch{text='[DSH restricted memory unavailable; no parent-authority fallback; report missing evidence scope]';}
    const section='analysis-orchestration:memory';return {...assembly,contexts:[...assembly.contexts.filter(c=>c.name!==section),{name:section,text}]};
  }
  async read(args,exec){return this.broker().read(this.principal(exec.agent,exec.signal),args);}
  grant(r,w,plan,expected){
    if(w.epoch!==r.epoch||w.memory_plan===undefined||w.role==='observer')throw Error('Memory capability must be reserved before first dispatch');if(independent(w)&&plan.bindings?.length)throw Error('Independent contrast accepts original sources only');
    const result=this.broker().grant(r.owner,r.task,w.id,plan,expected);w.memory_plan=plan;w.memory_grant_revision=result.grant_revision;this.e.store.saveWork(w);return result;
  }
  coverage(r,w){try{return this.broker().coverage(r.owner,r.task,w.id,w.contrast_plan?.required_sources??[]);}catch{return {enabled:false,unavailable:true};}}
  close(){for(const d of this.dispose.values())d();this.dispose.clear();}
}
