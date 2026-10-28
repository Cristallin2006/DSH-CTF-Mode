/** Dedicated state capability for analysis hooks; ordinary tools keep their policy. */
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {actions as ACTIONS,parameters,validate,contract} from './session-contract.mjs?revision=1.1.2';
import {NativeJobs} from './native-jobs.mjs?revision=1.1.1';
import {HookReadiness} from './hook-readiness.mjs?revision=1.1.3';

const nativeRoot=process.env.DSH_NATIVE_PACKAGE_ROOT || '/opt/node24/lib/node_modules/@deepseek-ai/dsh';
const nativeRequire=createRequire(path.join(nativeRoot,'package.json'));
const bridge=await import(pathToFileURL(nativeRequire.resolve('@deepseek-ai/dsh-hooks-claude-code')).href);
const {createUserMessage}=await import(pathToFileURL(nativeRequire.resolve('@deepseek-ai/dsh-llm')).href);
export const name='analysis-hooks-sandbox';
export const inject=['shell','sessionProjections','tools'];
const quote=value=>"'"+String(value).replaceAll("'","'\\''")+"'";

export async function apply(ctx,config){
  const root=fs.realpathSync(config.dshHome || process.env.DSH_HOME || '/root/.dsh');
  const state=path.join(root,'analysis-state');
  fs.mkdirSync(state,{recursive:true,mode:0o700});
  if(fs.realpathSync(state)!==state)throw new Error('analysis-state must be a real directory inside DSH_HOME');
  const pluginRoot=fs.realpathSync(config.pluginRoot);
  const python='/usr/bin/python3';
  const runtime=path.join(root,'runtime/analysis-v1/session.py');
  const lifecycle=new NativeJobs(state,ctx.get('jobs'),{external:()=>ctx.get('reExperiments')});
  ctx.on('tools/execute',(exec,next)=>lifecycle.around(exec,next));
  if(lifecycle.jobs)ctx.effect(()=>lifecycle.jobs.onJobsChanged(owner=>{if(owner)lifecycle.adopt(owner);}), 'analysis: native job registration');
  const timer=setInterval(()=>void lifecycle.tick().catch(()=>{health.jobLifecycleError=true;}),250);
  ctx.effect(()=>async()=>{clearInterval(timer);await lifecycle.close();},'analysis: drain owned native jobs');
  const expected=`python3 "${pluginRoot}/analysis_hook.py"`;
  const prefix=`DSH_HOME=${quote(root)} DSH_ANALYSIS_STATE=${quote(state)} `;
  const agents=new Map(),hookReadiness=new HookReadiness();
  const health={status:'starting',version:'1.1.3',pid:process.pid,state,startedAt:new Date().toISOString(),calls:0,failures:0,lastFailure:null,lastSuccess:null,points:{}};
  const healthDir=path.join(state,'health');
  fs.mkdirSync(healthDir,{recursive:true,mode:0o700});
  const healthFile=path.join(healthDir,`host-${process.pid}.json`);
  function saveHealth(){
    const tmp=healthFile+'.tmp';
    fs.writeFileSync(tmp,JSON.stringify(health,null,2),{mode:0o600});
    fs.renameSync(tmp,healthFile);
  }
  saveHealth();
  const shell=ctx.shell;
  function request(command,options={}){
    return shell.resolve({...options,command:prefix+command,
      sandboxPolicy:{mode:'workspace-write',workspaceRoot:state},stdoutMaxBytes:512*1024});
  }
  async function runState(argv,options={}){
    const command=[python,runtime,...argv].map(quote).join(' ');
    return shell.run(request(command,{timeoutMs:10000,workdir:options.workdir || state,signal:options.signal}));
  }
  const children=new Map();
  function captureAgent(event,first){
    const agent=first?.agent || (event.startsWith('subagent/') ? children.get(first?.runId) || ctx.get('agents')?.get(first?.id) : undefined);
    if(agent?.session?.header?.id)agents.set(agent.session.header.id,agent);
    if(event==='subagent/start' && agent)children.set(first.runId,agent);
    if(event==='subagent/end')children.delete(first?.runId);
  }
  const proxy=new Proxy(ctx,{
    get(target,key){
      if(key==='shell')return {
        resolve(req){
          if(req.command!==expected)throw new Error('analysis adapter accepts only its fixed hook entrypoint');
          return request(req.command,req);
        },
        async run(spec){
          let payload={},parsed={};
          try{payload=JSON.parse(spec.stdin || '{}')}catch{}
          let result;
          try{result=await shell.run(spec)}catch(error){
            hookReadiness.record(payload,false,error);
            const point=String(payload.hook_event_name || 'unknown');
            health.calls++;health.failures++;health.status='degraded';
            (health.points[point] ||= {ok:0,failed:0}).failed++;
            health.lastFailure={at:new Date().toISOString(),event:point,error:String(error)};
            saveHealth();ctx.logger.warn('analysis shell infrastructure failed: '+String(error));
            agents.get(payload.session_id)?.inject(createUserMessage({content:[{type:'text',text:'[DSH 分析状态故障] 钩子未能执行，事件未持久化；请调用 analysis_session 的 health 检查。'}],source:{kind:'plugin',plugin:name}}));
            throw error;
          }
          try{parsed=JSON.parse(result.stdout.text)}catch{}
          const ok=result.exitCode===0 && parsed.analysisHealth?.status==='ok';
          hookReadiness.record(payload,ok,parsed.analysisHealth?.error || result.stderr.text.slice(-1200));
          health.calls++;
          const point=String(payload.hook_event_name || 'unknown');
          const count=health.points[point] ||= {ok:0,failed:0};
          if(ok){health.status='ok';health.lastSuccess=new Date().toISOString();count.ok++}
          else{
            health.status='degraded';health.failures++;count.failed++;
            health.lastFailure={at:new Date().toISOString(),event:point,exitCode:result.exitCode,
                                error:parsed.analysisHealth?.error || result.stderr.text.slice(-1200)};
            ctx.logger.warn('analysis persistence degraded: '+health.lastFailure.error);
            // Official CC bridge ignores structured stdout on exit 1. Deliver
            // the already-produced fallback context directly, preserving rc=1.
            const agent=agents.get(payload.session_id);
            const text=parsed.hookSpecificOutput?.additionalContext || '[DSH 分析状态故障] 钩子执行失败，事件未可靠持久化；请调用 analysis_session 的 health。';
            if(agent){
              const signature=point+':'+health.lastFailure.error;
              const last=agentWarnings.get(payload.session_id);
              if(!last || last.signature!==signature || Date.now()-last.at>=60000){
                agent.inject(createUserMessage({content:[{type:'text',text}],source:{kind:'plugin',plugin:name}}));
                agentWarnings.set(payload.session_id,{signature,at:Date.now()});
              }
            }
          }
          health.lastSandbox=result.sandbox || null;
          saveHealth();
          return result;
        }
      };
      if(key==='on')return (event,handler)=>ctx.on(event,(...args)=>{captureAgent(event,args[0]);return handler(...args)});
      const value=Reflect.get(target,key,target);
      return typeof value==='function'?value.bind(target):value;
    }
  });
  const agentWarnings=new Map();
  ctx.on('agent/disposed',({agent})=>{const id=agent?.session?.header?.id;agents.delete(id);agentWarnings.delete(id);hookReadiness.forget(id)});
  // Reuse the installed bridge, including pairing, lifecycle and cancellation.
  bridge.apply(proxy,{configPath:config.configPath,pluginRoot});

  const tool={
    name:'analysis_session',
    description:'管理分析任务、目标代次、证据、检查点及原生后台任务。init options={goal,data:{}} 自动绑定；checkpoint options={data:{summary,...}}；transition options={status,data:{summary,unresolved:[]}}。schema options={action} 返回该动作参数与例子。job_scope 为未来原生后台 bash 绑定目标代次和期限，不提供 SSH/FTP 请求配额。status 返回真实绑定/覆盖。',
    parameters,
    output:{schema:{type:'string'},render(_args,value){return [{type:'text',text:value}]}},
    async execute(args,exec){
      const agent=exec?.agent;
      if(!agent?.session?.header?.id)throw new Error('analysis_session requires a calling session');
      const action=args.action;
      const opts=validate(args),owner=agent.session.header.id;
      if(action==='schema')return JSON.stringify({ok:true,result:opts.action?contract(opts.action):{actions:ACTIONS,hint:'Pass options={action} for an action-specific example.'}});
      if(action==='job_scope')return JSON.stringify({ok:true,result:await lifecycle.command(owner,args.task,opts,agent)});
      const argv=[action];
      if(!['health','init','list'].includes(action)){
        if(typeof args.task!=='string' || !args.task || args.task.startsWith('-'))throw new Error('valid task ID required');
        argv.push(args.task);
      }
      for(const [key,value] of Object.entries(opts)){
        if(key!=='data' && !['string','number'].includes(typeof value))throw new Error('invalid option type: '+key);
        argv.push('--'+key.replaceAll('_','-'),key==='data'?JSON.stringify(value):String(value));
      }
      // Host caller identity is authoritative, never an arbitrary model field.
      if(action==='init' || action==='bind')argv.push('--session',agent.session.header.id);
      if(action==='lease')argv.push('--owner',agent.session.header.id);
      const evidence=action==='artifact'?opts.path:action==='record' && opts.kind==='evidence'?opts.data?.path:null;
      if(evidence){
        const workspace=fs.realpathSync(agent.session.header.cwd);
        const actual=fs.realpathSync(path.resolve(workspace,evidence));
        const relative=path.relative(workspace,actual);
        if(relative.startsWith('..'+path.sep) || relative==='..' || path.isAbsolute(relative))throw new Error('evidence file must be inside the calling workspace');
        if(action==='artifact')argv[argv.indexOf('--path')+1]=actual;
        else argv[argv.indexOf('--data')+1]=JSON.stringify({...opts.data,path:actual});
      }
      const operation=()=>runState(argv,{workdir:agent.session.header.cwd,signal:exec.signal});
      const oldTask=lifecycle.binding(owner);
      const needsDrain=action==='target'||action==='transition'&&opts.status!=='running'||action==='bind'&&oldTask&&oldTask!==args.task;
      const result=needsDrain?await lifecycle.change(owner,action==='bind'?oldTask:args.task,action==='target'?opts.id:null,operation):await operation();
      let parsed;
      try{parsed=JSON.parse(result.stdout.text)}catch{}
      if(action==='health' && (result.exitCode!==0 || !parsed?.ok))return JSON.stringify({ok:false,result:{status:'degraded',error:parsed?.error || result.stderr.text.slice(-1000),state},hook:health});
      if(!parsed)throw new Error('analysis state command failed: '+result.stderr.text.slice(-1000));
      if(result.exitCode!==0 || !parsed.ok)throw new Error((parsed.error || result.stderr.text.slice(-1000))+'; contract: '+JSON.stringify(contract(action)));
      if(['health','init','bind','status','target'].includes(action)){
        const readiness=lifecycle.readiness(owner);
        const control=ctx.tools.get('dsh_control',agent);
        try{readiness.request_control=control?JSON.parse(await control.execute({action:'status'},{...exec,agent})): {available:false,coverage:'no controlled HTTP tool registered'};}
        catch{readiness.request_control={available:false,status:'unavailable',coverage:'unknown; no protection claim'};}
        parsed.readiness=readiness;
      }
      return JSON.stringify(action==='health'?{...parsed,hook:health,hook_session:hookReadiness.get(owner)}:parsed);
    }
  };
  ctx.effect(()=>ctx.tools.register(tool),'analysis: constrained state tool');

  if(config.selfTest){
    const result=await selfTest({ctx,shell,request,runState,root,state,expected,prefix,python,config});
    health.selfTest=result;
    if(result.ok && health.status==='starting')health.status='ready';
    saveHealth();
    if(!result.ok)throw new Error('analysis real-shell self-test failed: '+JSON.stringify(result));
  }
  // No background tool or root service is replaced; a row reload disposes
  // only its own bridge listeners, detached hooks and state tool.
}

async function selfTest({ctx,shell,request,runState,root,state,expected,prefix,python,config}){
  const sid='analysis-selftest-'+process.pid;
  const payload={hook_event_name:'SessionStart',session_id:sid,cwd:'/root/src',source:'repair-selftest'};
  const old=await shell.run(shell.resolve({command:prefix+expected,stdin:JSON.stringify(payload),workdir:'/root/src',timeoutMs:10000}));
  const fixed=await shell.run(request(expected,{stdin:JSON.stringify(payload),workdir:'/root/src',timeoutMs:10000}));
  let decoded={};try{decoded=JSON.parse(fixed.stdout.text)}catch{}
  const db=await runState(['health']);
  let dbDecoded={};try{dbDecoded=JSON.parse(db.stdout.text)}catch{}
  const broken=await shell.run(request(`DSH_ANALYSIS_STATE='/proc/dsh-analysis-fault-probe' ${expected}`,{stdin:JSON.stringify(payload),workdir:'/root/src',timeoutMs:10000}));
  let brokenDecoded={};try{brokenDecoded=JSON.parse(broken.stdout.text)}catch{}
  const failureVisible=broken.exitCode===1 && brokenDecoded.analysisHealth?.status==='degraded' && brokenDecoded.hookSpecificOutput?.additionalContext?.includes('[DSH 分析会话 v1]') && brokenDecoded.hookSpecificOutput.additionalContext.includes('[DSH 分析状态故障]');
  // An explicit state-only grant must still deny unrelated DSH files.
  const outside=path.join(root,'runtime','.analysis-deny-probe-'+process.pid);
  const probe=`${quote(python)} -c ${quote('from pathlib import Path; Path('+JSON.stringify(outside)+').write_text("unexpected")')}`;
  const denied=await shell.run(request(probe,{workdir:'/root/src',timeoutMs:10000}));
  const accidentallyWritten=fs.existsSync(outside);
  if(accidentallyWritten)fs.unlinkSync(outside);
  const report={ok:fixed.exitCode===0 && decoded.analysisHealth?.status==='ok' && dbDecoded.result?.status==='ok' && failureVisible===true && denied.exitCode!==0 && !accidentallyWritten,
                defaultHookExit:old.exitCode,defaultPersistenceDenied:old.stderr.text.includes('analysis persistence degraded'),scopedHookExit:fixed.exitCode,scope:fixed.sandbox,
                startupCard:decoded.hookSpecificOutput?.additionalContext?.includes('[DSH 分析会话 v1]')===true,
                failureVisible,database:dbDecoded.result,unrelatedWriteDenied:denied.exitCode!==0 && !accidentallyWritten};
  if(!report.startupCard)report.ok=false;
  return report;
}
