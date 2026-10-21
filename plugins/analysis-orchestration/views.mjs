import {createHash} from 'node:crypto';
import {eventSummary} from './contract.mjs?revision=0.8.0';
const bytes=v=>Buffer.byteLength(JSON.stringify(v));
const hash=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const n=(v,fallback,min,max,name)=>{v??=fallback;if(!Number.isSafeInteger(v)||v<min||v>max)throw Error('Invalid '+name);return v;};
export const queryLimits=o=>({offset:n(o.offset,0,0,Number.MAX_SAFE_INTEGER,'offset'),limit:n(o.limit,8,1,32,'limit'),max_bytes:n(o.max_bytes,12000,2048,24000,'max_bytes')});
const short=(v,size=240)=>typeof v==='string'?v.slice(0,size):null;
export function compactWork(w){return {id:w.id,key:short(w.key,160),state:w.state,role:w.role,child:w.child??null,objective_ref:w.objective_ref??null,assignment_kind:w.assignment_kind??'legacy',memory_capability:w.memory_plan!==undefined,memory_grant_revision:w.memory_grant_revision??null,contrast_mode:w.contrast_plan?.mode??null,result_revision:w.result_revision??0,result_available:w.result!==null,skill_delivery:w.skill_delivery?.state??'undeclared',material_delivery:w.material_delivery?.state??'not_required',result_preview_truncated:!!w.result_preview_truncated,skill_materials:w.skill_delivery?.coverage??null,preflight:w.preflight?{ok:w.preflight.ok,kind:w.preflight.kind}:null,checkpoint:w.checkpoint?{revision:w.checkpoint.revision,outcome:w.checkpoint.outcome,summary:short(w.checkpoint.summary)}:null,diagnostic:short(w.diagnostic)};}
function reviewSummary(v){return {state:v.state,signature:v.signature,revision:v.revision,premises:{count:v.decision_premises?.items.length??0,needs_recheck:v.decision_premises?.items.filter(p=>!p.revision_matches||p.effective_applicability!=='current').length??0},delivery:{state:v.delivery?.state??null,attempts:v.delivery?.attempts??0},resolution:v.resolution?{decision:v.resolution.decision,goal_status:v.resolution.goal_status,summary:short(v.resolution.summary),unresolved_count:(v.resolution.unresolved?.length??0)+(v.resolution.issue_set?.count??0)}:null,detail:'decision action; assessment is not independent proof'};}
export function statusView(e,r,o={}){
  const {offset,limit,max_bytes}=queryLimits(o),snapshot=hash({selection:{work:o.work??null,objective_ref:o.objective_ref??null,states:o.states??null},metadata:e.store.statusDigest(r),run:r,decision:e.resolutions.view(r).signature,seq:e.store.latestSeq(r)});
  if(offset>0&&o.snapshot===undefined)throw Error('Subsequent status pages require snapshot');
  if(o.snapshot!==undefined&&o.snapshot!==snapshot)throw Error('Status snapshot changed; restart pagination');
  const selected=e.store.pageWorks(r,{...o,offset,limit});if(o.work&&!selected.total)throw Error('Work unavailable in current epoch');
  const counts=e.store.counts(r);
  const value={task:r.task,state:r.state,epoch:r.epoch,host_current:r.host===e.host,expires:r.expires??null,max_wakeups:r.max_wakeups??null,counts,decision_review:reviewSummary(e.resolutions.summary(r)),latest_seq:e.store.latestSeq(r),snapshot,works:[],offset,next_offset:null,has_more:false,total:selected.total,health:{ok:!e.fault,error:short(e.fault),notification_warning:short(e.noticeFault)},detail:'status view=detail is legacy; result work/view=summary or paged is bounded'};
  for(const w of selected.items){const row=compactWork(w);value.works.push(row);if(bytes(value)>max_bytes-200){value.works.pop();break;}}
  const next=offset+value.works.length;value.has_more=next<selected.total;value.next_offset=value.has_more?next:null;
  if(value.has_more&&!value.works.length)throw Error('Response budget too small for one work; increase max_bytes');
  if(bytes(value)>max_bytes)throw Error('Response budget too small for summary');return value;
}
export function eventPage(e,r,o={}){
  const {limit,max_bytes}=queryLimits(o),after=n(o.after_seq,0,0,Number.MAX_SAFE_INTEGER,'after_seq'),latest=e.store.latestSeq(r),snapshot=n(o.snapshot_seq,latest,0,latest,'snapshot_seq');
  if(after>snapshot)throw Error('after_seq exceeds snapshot_seq');
  if(o.work){const w=e.store.work(r.task,o.work);if(w.epoch!==r.epoch)throw Error('Old epoch');}
  const rows=e.store.all('SELECT * FROM orch_events WHERE task=? AND epoch=? AND seq>? AND seq<=? AND (? IS NULL OR work=?) ORDER BY seq ASC LIMIT ?',r.task,r.epoch,after,snapshot,o.work??null,o.work??null,limit+1);
  const value={task:r.task,epoch:r.epoch,snapshot_seq:snapshot,latest_seq:latest,after_seq:after,next_seq:after,has_more:false,gap:false,events:[]};
  for(const row of rows.slice(0,limit)){
    const original=eventSummary({...row,data:JSON.parse(row.data)});let item=original;
    if(bytes(item)>1200)item={seq:row.seq,work:row.work,kind:row.kind,at:row.at,data:{omitted:true,detail:'event action with seq',sha256:hash(original.data)}};
    value.events.push(item);if(bytes(value)>max_bytes-100){value.events.pop();break;}value.next_seq=row.seq;
  }
  value.has_more=rows.length>value.events.length;return value;
}
export function resultPage(w,o={},extra={}){
  const {offset,max_bytes}=queryLimits(o);const revision=w.result_revision??0;
  if(offset>0&&o.expected_revision===undefined)throw Error('Subsequent result pages require expected_revision');
  if(o.expected_revision!==undefined&&o.expected_revision!==revision)throw Error('Result revision changed; restart pagination');
  if(o.view==='summary')return compactWork(w);
  const result=w.result??'',points=Array.from(result);if(offset>points.length)throw Error('offset exceeds stored result');
  const value={work:w.id,child:w.child??null,state:w.state,result_revision:revision,result_available:w.result!==null,result:'',offset,next_offset:null,has_more:false,stored_characters:points.length,source_truncated:!!w.result_truncated,original_source:w.original_source??'native child conversation; source_truncated marks legacy stored truncation',sha256:createHash('sha256').update(result).digest('hex'),...extra};
  let lo=0,hi=Math.min(points.length-offset,24000);while(lo<hi){const mid=Math.ceil((lo+hi)/2);value.result=points.slice(offset,offset+mid).join('');if(bytes(value)<=max_bytes-100)lo=mid;else hi=mid-1;}
  value.result=points.slice(offset,offset+lo).join('');value.has_more=offset+lo<points.length;value.next_offset=value.has_more?offset+lo:null;if(value.has_more&&!lo)throw Error('Response budget too small');return value;
}
