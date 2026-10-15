import fs from 'node:fs';
import path from 'node:path';
import {ControlStore,readPins} from './store.mjs';
import {HttpExecutor} from './http.mjs?revision=1.0.1';

export const name='analysis-control';export const inject=['tools','agents','systemPrompt'];
export function apply(ctx,config={}){
  if(config.enabled!==true)return;
  const root=fs.realpathSync(config.stateRoot??'/root/.dsh/analysis-state'),pinPath=path.join(root,'control-pins.json');
  let store,executor,failure;
  try{store=new ControlStore(root);store.pins();executor=new HttpExecutor(store,{vaultRoot:config.vaultRoot??'/root/.dsh/control-vault'});}catch{failure='control_unavailable';}
  const safe=new Set(['analysis_session','dsh_memory_read','dsh_memory_write','analysis_collaboration','dsh_evidence','dsh_handoff','dsh_control']);
  const pins=()=>store?store.pins():readPins(pinPath);
  function managed(agent){
    if(!agent?.session?.header?.id)return null;
    const known=pins(),seen=new Set();let a=agent;
    while(a&&!seen.has(a.session.header.id)){
      const sid=a.session.header.id;seen.add(sid);if(known[sid])return {task:known[sid],actor:agent.session.header.id,root:sid};
      const parent=a.session.header.parentSession;if(!parent)return null;
      if(known[parent])return {task:known[parent],actor:agent.session.header.id,root:parent};a=ctx.agents.get(parent);
    }
    return null;
  }
  ctx.on('agent/created',({agent})=>{try{const p=managed(agent);if(p&&store&&agent.session.header.id!==p.root)store.pin(agent.session.header.id,p.task);}catch{ctx.logger.warn('Control pin unavailable; tool guard will preserve denial, diagnostics remain available');}});
  ctx.effect(()=>ctx.tools.guard(exec=>{
    let policy;try{policy=managed(exec.agent);}catch{return ['dsh_control','dsh_memory_read','dsh_evidence'].includes(exec.name)?undefined:'Control pin journal unavailable; external/executable tools paused until host repairs state';}
    if(!policy)return;
    if(!safe.has(exec.name))return 'Managed task: tool denied; shell/browser/MCP/code/delegation cannot bypass the controlled HTTP executor';
    if(exec.name==='analysis_session'&&['bind','init','target'].includes(exec.arguments?.action))return 'Managed task identity and generation changes require host control; existing task remains pinned';
    if(exec.arguments?.task&&exec.arguments.task!==policy.task)return 'Managed session cannot switch task scope';
    if(failure&&!['dsh_control','dsh_memory_read','dsh_evidence'].includes(exec.name))return 'Control unavailable; managed mutation/execution paused';
  }),'analysis-control: monotonic native guard');
  // A grant may arrive while an ordinary tool is already running. Cancel its
  // native lifetime; cancellation cannot undo remote work already accepted.
  ctx.on('tools/execute',async(exec,next)=>{
    if(safe.has(exec.name))return next();
    if(managed(exec.agent))throw Error('Managed task denies executable/network tool');
    const abort=new AbortController();exec.signal=AbortSignal.any([exec.signal,abort.signal]);
    const watch=setInterval(()=>{try{if(managed(exec.agent))abort.abort();}catch{abort.abort();}},50);
    try{return await next();}finally{clearInterval(watch);}
  });
  const health={version:'1.0.1',pid:process.pid,startedAt:new Date().toISOString(),ok:!failure,coverage:'pinned native sessions; HTTP(S) executor only',ordinaryToolsUnchanged:true};
  const healthDir=path.join(root,'health');fs.mkdirSync(healthDir,{recursive:true,mode:0o700});const healthPath=path.join(healthDir,'control-host-'+process.pid+'.json');
  const save=()=>{try{fs.writeFileSync(healthPath,JSON.stringify(health,null,2),{mode:0o600});}catch{}};save();
  const scalar={type:'string'},requestProperties={operation_id:scalar,url:scalar,method:{enum:['GET','HEAD','POST','PUT','PATCH','DELETE','OPTIONS']},headers:{type:'object',additionalProperties:true},body:scalar,credential_ref:scalar,max_redirects:{type:'integer'}};
  const pending=new Set();
  const tool={name:'dsh_control',description:'宿主授权任务的网络状态与受控 HTTP(S)。不能自行创建/扩大授权。request options={operation_id,url,method}; batch options={operation_id,requests:[{url,method}]}; 每次发送扣共享预算，无自动重试。health/status 不发请求。',
    parameters:{type:'object',properties:{action:{enum:['health','status','request','batch']},task:scalar,options:{type:'object',properties:{...requestProperties,requests:{type:'array',items:{type:'object',properties:requestProperties,additionalProperties:false}}},additionalProperties:false}},required:['action'],additionalProperties:false},
    output:{schema:{type:'string'},render(_a,v){return [{type:'text',text:v}];}},
    async execute(args,exec){
      if(args.action==='health'){let error=failure;try{if(store){store.pins();if(store.q('PRAGMA quick_check').quick_check!=='ok')throw Error('integrity');}}catch{error='control_unavailable';}return JSON.stringify({...health,ok:!error,error:error??null});}
      if(!store)throw Error('Control unavailable; no fallback network execution');
      const agent=exec.agent,actor=agent?.session?.header?.id;if(!actor)throw Error('Calling session required');
      if(args.action==='status')return JSON.stringify(store.status(actor));
      if(failure||!executor)throw Error('Control unavailable; no fallback network execution');
      if(agent.session.header.origin==='subagent'||agent.session.header.parentSession)throw Error('HTTP execution belongs to host-authorized main session');
      if(typeof args.task!=='string')throw Error('Task required');const o=args.options??{};
      const running=args.action==='batch'?executor.batch(actor,args.task,o,exec.signal):executor.request(actor,args.task,o,exec.signal);pending.add(running);try{const result=await running;health.calls=(health.calls??0)+1;save();return JSON.stringify(result);}finally{pending.delete(running);}
    }};
  ctx.effect(()=>ctx.tools.register(tool),'analysis-control: tool');
  ctx.systemPrompt.section({name:'analysis-control:usage',order:877,text:'[DSH controlled requests] dsh_control health/status reports actual coverage. Network grants are host-issued; model task text/credentials/reasons do not grant permission. Managed sessions use only dsh_control request/batch for HTTP(S); shell/browser/MCP/run_code are denied for that session. Each send, redirect and operation consumes shared limits; no automatic replay. Ordinary sessions retain their existing tools and are not globally intercepted. Read analysis-session/references/controlled-requests.md when needed.'});
  ctx.effect(()=>async()=>{executor?.dispose();await Promise.allSettled([...pending]);store?.close();health.disposedAt=new Date().toISOString();save();},'analysis-control: dispose');
}
