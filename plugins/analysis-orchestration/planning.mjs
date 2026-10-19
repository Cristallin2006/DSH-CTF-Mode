// Plans describe requirements, not new permissions. Unknown execution paths
// cannot be promoted to hard-limit coverage by a model-authored declaration.
const string=(v,max=2000)=>typeof v==='string'&&v.trim()&&v.length<=max;
const object=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).every(k=>keys.includes(k));
const str={type:'string'};
export const executionPlanSchema={type:'object',properties:{
  kind:{enum:['materials','execution','resource']},
  requirements:{type:'array',maxItems:16,items:{type:'object',properties:{purpose:str,any_of:{type:'array',minItems:1,maxItems:8,items:str}},required:['purpose','any_of'],additionalProperties:false}},
  limits:{type:'array',maxItems:8,items:{type:'object',properties:{unit:{enum:['candidate','verification','request']},max:{type:'integer',minimum:1},authority_ref:str},required:['unit','max','authority_ref'],additionalProperties:false}}
},required:['kind','requirements'],additionalProperties:false};
export function executionPlan(v){
  if(!object(v,['kind','requirements','limits'])||!['materials','execution','resource'].includes(v.kind)||!Array.isArray(v.requirements)||v.requirements.length>16)throw Error('Declare execution_plan={kind:materials|execution|resource,requirements:[{purpose,any_of:[exact_tool_name]}]}');
  const requirements=v.requirements.map(r=>{
    if(!object(r,['purpose','any_of'])||!string(r.purpose)||!Array.isArray(r.any_of)||!r.any_of.length||r.any_of.length>8||r.any_of.some(n=>!string(n,200))||new Set(r.any_of).size!==r.any_of.length)throw Error('Invalid capability requirement');
    return {purpose:r.purpose,any_of:[...r.any_of]};
  });
  if(v.kind!=='materials'&&!requirements.length)throw Error('Execution/resource work needs explicit capability requirements');
  if(!Array.isArray(v.limits??[]))throw Error('Invalid limits');
  const limits=(v.limits??[]).map(l=>{
    if(!object(l,['unit','max','authority_ref'])||!['candidate','verification','request'].includes(l.unit)||!Number.isSafeInteger(l.max)||l.max<1||!string(l.authority_ref,1000))throw Error('Invalid explicit execution limit');
    return {unit:l.unit,max:l.max,authority_ref:l.authority_ref};
  });
  if(!Array.isArray(v.limits??[])||limits.length>8)throw Error('Invalid limits');
  const result={kind:v.kind,requirements,limits};if(Buffer.byteLength(JSON.stringify(result))>12000)throw Error('Execution plan too large');return result;
}
export function preflight(e,w,agent){
  if(w.role==='observer')return {ok:true,kind:'observer',missing:[],coverage:'zero tools'};
  let plan;try{plan=executionPlan(w.execution_plan);}catch(error){return {ok:false,missing:[error.message],coverage:'undeclared'};}
  const tools=e.effectiveTools(w),missing=[];
  for(const r of plan.requirements)if(!r.any_of.some(n=>(plan.kind==='materials'||!['skill','dsh_solver_feedback'].includes(n))&&tools.includes(n)&&e.ctx.tools.get(n,agent)))missing.push({purpose:r.purpose,any_of:r.any_of});
  if(plan.kind==='resource')missing.push({reason:'Resource mutation requires a compatible resource adapter with exact identity, generation and shared-use checks; generic shell is not such an adapter'});
  // Neither generic shell nor the current HTTP-only control mode can promise
  // per-action accounting for these executable native children.
  if(plan.limits.length)missing.push({reason:'Hard execution limits require a compatible mediated adapter; arbitrary Solver tools are not counted',units:plan.limits.map(l=>l.unit)});
  return {ok:!missing.length,kind:plan.kind,missing,coverage:{tools:'declared requirements checked against granted/native tools; not proof of reachability',limits:plan.limits.length?'unsupported':'not_requested',resources:plan.kind==='resource'?'unsupported; mutation blocked':'cooperative only; no universal close interception'}};
}
export function lineage(o){
  const result={assignment_kind:o.assignment_kind??'primary'};
  if(!['primary','independent_branch','review'].includes(result.assignment_kind))throw Error('Invalid assignment_kind');
  if(o.objective_ref!==undefined){if(!string(o.objective_ref,200))throw Error('Invalid objective_ref');result.objective_ref=o.objective_ref;}
  if(result.assignment_kind!=='primary'){
    if(!string(o.source_work,200)||!string(o.branch_reason))throw Error('Independent/review work needs source_work and branch_reason');
    result.source_work=o.source_work;result.branch_reason=o.branch_reason;
  }else if(o.source_work!==undefined||o.branch_reason!==undefined)throw Error('Primary work cannot silently replace a prior branch');
  return result;
}
export function route(w){return {work:w.id,child:w.child??null,state:w.state,action:w.state==='pending'?'dispatch':['launching','running','stopping','cleanup_unknown'].includes(w.state)?'inspect_or_steer':w.mode==='continuable'&&w.child?'followup':'explicit_branch',automatic_execution:false};}
