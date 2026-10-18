// Action-specific contract shared by schema, validation and recovery feedback.
const text={type:'string',minLength:1},object={type:'object',additionalProperties:true};
const integer={type:'integer',minimum:1},positive={type:'number',exclusiveMinimum:0};
export const contracts={
  health:{},list:{},status:{},bind:{},schema:{action:{enum:['health','init','list','status','bind','checkpoint','transition','target','artifact','record','lease','resource','events','job_scope','schema']}},
  init:{goal:text,id:text,data:object},checkpoint:{data:object},
  transition:{status:{enum:['running','waiting','paused','blocked','complete','cancelled']},data:object},
  target:{id:text,data:object},artifact:{path:text},
  record:{kind:{enum:['experiment','evidence','claim','hypothesis','handoff','note']},data:object},
  lease:{action:{enum:['acquire','renew','release']},resource:text,token:text,ttl:positive},
  resource:{id:text,data:object},events:{limit:integer},
  job_scope:{action:{enum:['set','status','clear']},target_id:text,generation:integer,environment:text,ttl_seconds:positive,budget_ref:text}
};
const required={init:['goal'],checkpoint:['data'],transition:['status','data'],target:['id'],artifact:['path'],record:['kind','data'],lease:['action','resource'],resource:['id','data'],job_scope:['action']};
const examples={
  init:{action:'init',options:{goal:'当前用户目标',data:{}}},
  checkpoint:{action:'checkpoint',task:'TASK_ID',options:{data:{summary:'已确认的事实',unresolved:['未决项'],next_experiment:'下一项区分实验'}}},
  transition:{action:'transition',task:'TASK_ID',options:{status:'complete',data:{summary:'已完成目标',unresolved:[]}}},
  target:{action:'target',task:'TASK_ID',options:{id:'service',data:{endpoint:'由可信平台返回的当前地址'}}},
  record:{action:'record',task:'TASK_ID',options:{kind:'experiment',data:{hypothesis:'待区分解释',candidate_source:'来源引用',candidate_count:12,scope:'预先确定的有限集合',stop_conditions:['集合结束','服务异常','额度耗尽']}}},
  job_scope:{action:'job_scope',task:'TASK_ID',options:{action:'set',target_id:'service',generation:1,environment:'SHARED_ENV_ID',ttl_seconds:60}}
};
export const actions=Object.keys(contracts);
export function contract(action){
  if(!contracts[action])throw Error('Unknown action. Available actions: '+actions.join(', '));
  return {action,options:contracts[action],required:required[action]??[],example:examples[action]??{action,...(['health','list','init','schema'].includes(action)?{}:{task:'TASK_ID'}),options:{}},
    note:action==='transition'?'complete checks the actual task delivery scope. Previously orchestrated tasks need a current dsh_orchestration resolve decision=complete, goal_status=fulfilled, completion_scope and evidence, then finish/disable. Empty unresolved alone cannot bypass this. Pause/block/cancel remain available; a stage report is not automatically total-goal completion.':action==='job_scope'?'set requires target_id,generation,environment,ttl_seconds. Applies to future native background bash jobs of this owner only; budget_ref is a reference, not protocol quota enforcement.':
      'task stays at top level; checkpoint, transition and record content belongs inside options.data. Caller identity is host-provided.'};
}
export function validate(args){
  const c=contract(args.action),o=args.options??{};
  const fail=reason=>{throw Error(reason+'; action='+args.action+'; allowed options: '+Object.keys(c.options).join(', ')+'; required: '+c.required.join(', ')+'; example: '+JSON.stringify(c.example));};
  if(!o||typeof o!=='object'||Array.isArray(o))fail('options must be an object');
  for(const k of Object.keys(o))if(!c.options[k])fail('Unsupported option '+k);
  for(const k of c.required)if(o[k]===undefined)fail('Missing option '+k);
  for(const [k,v] of Object.entries(o)){
    const s=c.options[k];
    if(s.enum&&!s.enum.includes(v))fail('Invalid enum for '+k);
    if(s.type==='object'&&(!v||typeof v!=='object'||Array.isArray(v)))fail(k+' must be an object');
    if(s.type==='string'&&(typeof v!=='string'||!v.trim()))fail(k+' must be a nonempty string');
    if(['number','integer'].includes(s.type)&&(!Number.isFinite(v)||(s.type==='integer'&&!Number.isInteger(v))||v<=0))fail(k+' must be a positive '+s.type);
  }
  if(!['health','init','list','schema'].includes(args.action)&&(typeof args.task!=='string'||!args.task||args.task.startsWith('-')))fail('Valid task ID required at top level');
  if(args.action==='job_scope'&&o.action==='set')for(const k of ['target_id','generation','environment','ttl_seconds'])if(o[k]===undefined)fail('Missing option '+k+' for set');
  if(args.action==='job_scope'&&o.action!=='set'&&Object.keys(o).some(k=>k!=='action'))fail('status/clear accept only options.action');
  if(args.action==='lease'&&['renew','release'].includes(o.action)&&!o.token)fail('Current lease token required');
  return o;
}
const optionProperties={};
for(const c of Object.values(contracts))for(const [k,v] of Object.entries(c)){
  if(k==='action')optionProperties[k]={type:'string',description:'schema: inspected tool action; lease: acquire/renew/release; job_scope: set/status/clear.'};
  else optionProperties[k]=v;
}
export const parameters={type:'object',properties:{action:{type:'string',enum:actions},task:text,options:{type:'object',properties:optionProperties,additionalProperties:false}},required:['action'],additionalProperties:false};
