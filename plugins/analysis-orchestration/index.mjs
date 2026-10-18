import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {Engine} from './engine.mjs?revision=0.4.0';
import {handoffSchema,reportSchema,guidanceSchema} from './contract.mjs?revision=0.4.0';
import {resolutionSchema} from './resolution.mjs?revision=0.4.0';
export const name='analysis-orchestration';
export const inject=['tools','agents','subagents','systemPrompt'];
const nativeRequire=createRequire(path.join(process.env.DSH_NATIVE_PACKAGE_ROOT??'/opt/node24/lib/node_modules/@deepseek-ai/dsh','package.json'));
const {createUserMessage}=await import(pathToFileURL(nativeRequire.resolve('@deepseek-ai/dsh-llm')).href);
const actions={enable:['max_parallel','heartbeat_ms','task_ms','max_wakeups'],add:['key','question','success','depends_on','tools','role','observe_work','timeout_ms','max_steps','handoff'],dispatch:['work'],status:[],resolve:['expected_signature','resolution'],result:['work'],trace:['work'],request_checkpoint:['work','reason'],wait:['after_seq','timeout_ms'],followup:['work','message'],steer:['work','message','guidance'],cancel:['work','reason'],review:['work','decision','reason'],pause:['reason'],resume:[],disable:['reason'],finish:['reason'],recover:[]};
export function apply(ctx,config={}){
  if(config.enabled!==true)return;
  const state=fs.realpathSync(config.stateRoot??'/root/.dsh/analysis-state');
  const engine=new Engine(ctx,state,text=>createUserMessage({content:[{type:'text',text}],source:{kind:'plugin',plugin:name}}),config);
  const file=path.join(state,'health','orchestration-host-'+process.pid+'.json');fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});
  let published=false;
  const save=()=>{if(published){try{const previous=JSON.parse(fs.readFileSync(file,'utf8'));if(previous.host!==engine.host)return;}catch(e){if(e.code!=='ENOENT')throw e;}}const value={version:'0.4.0',ok:!engine.fault,error:engine.fault,notification_warning:engine.noticeFault,pid:process.pid,host:engine.host,active:engine.active.size,solverDefaultTools:['skill','dsh_solver_feedback'],observerDefaultTools:[],capabilities:['dedicated coordinator','native asynchronous Solvers','event and heartbeat supervision','steer and confirmed cancellation','read-only optional observer','native continuable children','no default task deadline or step cap','durable idle decision review','versioned completion resolution'],coverage:'opt-in tasks; ordinary native permissions; no global request counting; strict HTTP sessions unsupported'};const tmp=file+'.'+engine.host+'.tmp';fs.writeFileSync(tmp,JSON.stringify(value),{mode:0o600});fs.renameSync(tmp,file);published=true;};save();
  ctx.on('agent/created',({agent})=>engine.attach(agent));
  ctx.on('agent/disposed',({agent})=>engine.disposeParent(agent));
  ctx.on('agent/pre-step',(p,next)=>engine.beforeStep(p,next));
  ctx.on('subagent/end',info=>{if(engine.closed)return;try{engine.lifecycle.end(info);}catch(e){engine.fault='Native child settlement failed: '+String(e.message).slice(0,300);for(const item of engine.active.values())item.controller.abort('Settlement failed');}});
  ctx.on('agent/inbox/claimed',p=>engine.claimed(p));
  ctx.on('agent/inbox/discarded',p=>engine.claimed(p,true));
  ctx.on('tools/pre-execute',(exec,next)=>engine.preTool(exec,next));
  ctx.on('tools/execute',(exec,next)=>engine.aroundTool(exec,next));
  for(const agent of ctx.agents.list())engine.attach(agent);
  const scalar={type:'string'},int={type:['integer','null']},strings={type:'array',items:scalar};
  const options={key:scalar,question:scalar,success:scalar,depends_on:strings,tools:strings,role:{enum:['solver','observer']},observe_work:scalar,timeout_ms:int,max_steps:int,work:{oneOf:[scalar,strings]},reason:scalar,message:scalar,guidance:guidanceSchema,handoff:handoffSchema,decision:{enum:['adopted','rejected','needs_more_evidence']},max_parallel:int,heartbeat_ms:int,task_ms:int,max_wakeups:int,after_seq:int,expected_signature:scalar,resolution:resolutionSchema};
  const tool={name:'dsh_orchestration',description:'按绑定任务启用专职编排，派发可执行原生 Solver 并持续监督。先 analysis_session init/bind、dsh_memory_write open，再 enable。add options={key,question,success,tools:[原生工具名],depends_on:[]}；dispatch={work:[ID]} 立即返回；status/result/wait/steer/cancel/review/resolve/pause/resume/finish/disable/recover。空闲后用 status 的 decision_review.signature 调用 resolve options={expected_signature,resolution:{decision,goal_status,summary,unresolved,...}}，明确继续、等待、阻塞、暂缓或完成；finish 仅结束编排。持续型 Solver 默认无任务时限和步数上限，followup={work,message} 在同一子会话继续；空闲不循环调用模型。Solver 默认 skill 和 dsh_solver_feedback，额外执行工具仍单独授权；handoff 交接、trace 查看真实反馈、request_checkpoint 保存中途进展，steer 支持带依据的指导及回执。可选 role=observer 为零工具独立审查。只在启用任务中限制主代理执行；不会扩展沙箱、审批或用户授权。详见 analysis-orchestration skill。',
    parameters:{type:'object',properties:{action:{enum:['health','schema',...Object.keys(actions)]},task:scalar,options:{type:'object',properties:options,additionalProperties:false}},required:['action'],additionalProperties:false},
    output:{schema:{type:'string'},render(_a,v){return [{type:'text',text:v}];}},
    async execute(args,exec){
      if(args.action==='health')return JSON.stringify({version:'0.4.0',ok:!engine.fault,error:engine.fault,active:engine.active.size});
      if(args.action==='schema')return JSON.stringify({actions,required:{add:['key','question','success'],steer:['work'],review:['work','decision','reason'],resolve:['expected_signature','resolution']},note:'task is top-level. steer requires message or guidance={observation,hypothesis,experiment,reconsider_if,evidence_refs}. handoff is optional; recorded goal and constraints are automatic. Solvers use native continuable children. Default timeout_ms/task_ms/max_steps/max_wakeups are null; no 4096 output override. followup continues the same child. Effective Solver tools include skill and dsh_solver_feedback; execution tools remain explicit. resolve uses the current status decision_review.signature and resolution={decision:continue|waiting|blocked|deferred|complete,goal_status:fulfilled|unfulfilled|uncertain,summary,unresolved:[{work?,issue,disposition:continue|waiting|blocked|deferred|out_of_scope,reason,next_step?,evidence_refs?}],evidence_refs?,completion_scope?,recheck_at?}. Complete requires fulfilled goal, explicit completion_scope, existing same-task evidence refs (record:ID or work:ID@RESULT_REVISION), and no in-scope unresolved work. Resolve records an assessment, never launches work. finish/disable/cancel do not require completion. Claims and feedback are not independently verified.'});
      const allowed=actions[args.action],o=args.options??{};if(!allowed||!o||typeof o!=='object'||Array.isArray(o)||Object.keys(o).some(k=>!allowed.includes(k)))throw Error('Invalid action options; use schema');
      const value=await engine.command(args,exec);save();return JSON.stringify(value);
    }};
  ctx.effect(()=>ctx.tools.register(tool),'orchestration: control');
  const feedback={name:'dsh_solver_feedback',description:'仅当前受监督 Solver 的中途反馈，不执行命令、不修改总任务或记忆。progress 使用 report={summary,outcome,evidence_refs,blockers,next_step,...}；context 读取自身交接与指导；await_guidance 在既有期限内等待新指导（默认60秒），不要循环context；ack 使用 guidance_id,status=understood/applied/evaluated/disagreed/blocked,reason,evidence_refs。关键证据变化、阻塞、长等待及收尾前报告即可，无需每步汇报。',
    parameters:{type:'object',properties:{action:{enum:['context','progress','ack','await_guidance']},report:reportSchema,guidance_id:scalar,status:{enum:['understood','applied','evaluated','disagreed','blocked']},reason:scalar,evidence_refs:strings,after_id:scalar,timeout_ms:{type:'integer',minimum:1,maximum:60000}},required:['action'],additionalProperties:false},
    output:{schema:{type:'string'},render(_a,v){return [{type:'text',text:v}];}},
    async execute(args,exec){const keys={context:['action'],progress:['action','report'],ack:['action','guidance_id','status','reason','evidence_refs'],await_guidance:['action','after_id','timeout_ms']}[args.action];if(!keys||Object.keys(args).some(k=>!keys.includes(k)))throw Error('Invalid Solver feedback fields');return JSON.stringify(await engine.feedback(args,exec));}};
  ctx.effect(()=>ctx.tools.register(feedback),'orchestration: Solver feedback');
  ctx.systemPrompt.section({name:'analysis-orchestration:usage',order:878,text:'[DSH optional solving orchestration] For substantial multi-stage work with independent execution branches, read analysis-orchestration skill and consider dsh_orchestration enable after task binding and memory open. This creates a dedicated strategic coordinator role backed by runtime supervision. Simple work need not enable it. Explicit user preferences take precedence. enable is per task, not a global role switch. Existing analysis_collaboration remains a separate read-only helper for ordinary sessions. Never claim this plugin enforces network quotas or target acceptance.'});
  const timer=setInterval(()=>void engine.tick().then(()=>{if(!engine.closed&&!engine.closing)save();}).catch(()=>{if(!engine.closed)engine.fault='Health persistence failed';}),config.tickMs??1000);timer.unref();
  ctx.effect(()=>async()=>{clearInterval(timer);await engine.close();save();},'orchestration: drain');
}
