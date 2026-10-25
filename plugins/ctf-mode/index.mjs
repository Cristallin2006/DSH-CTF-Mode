import {createRequire} from 'node:module';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {CtfMode,isMain} from './core.mjs';
export const name='ctf-mode';
export const inject=['tools','skills','systemPrompt'];
export async function apply(ctx,config={}){
  if(config.enabled!==true)return;
  const req=createRequire(path.join(process.env.DSH_NATIVE_PACKAGE_ROOT??'/opt/node24/lib/node_modules/@deepseek-ai/dsh','package.json'));
  const {renderSkillContent}=await import(pathToFileURL(req.resolve('@deepseek-ai/dsh-skill')).href);
  const invoke=async(name,agent)=>{
    const tool=ctx.tools.get(name,agent);if(!tool)throw Error('CTF runtime prerequisite missing: '+name);
    return JSON.parse(await tool.execute({action:'health'},{agent}));
  };
  const mode=new CtfMode(ctx,{renderSkillContent,mode:config.mode??'auto',
    health:agent=>invoke('analysis_session',agent),orchestrationHealth:agent=>invoke('dsh_orchestration',agent)});
  ctx.on('system-prompt/assemble',async(_assembly,context,next)=>mode.assemble(await next(),context));
  ctx.on('agent/pre-step',async({agent},next)=>mode.verify(agent,await next()));
  ctx.on('tools/pre-execute',async(exec,next)=>(await mode.preTool(exec))??next());
  ctx.on('agent/disposed',({agent})=>mode.forget(agent));
  ctx.effect(()=>()=>mode.close(),'ctf-mode: release session-local routes');
  const string={type:'string'},strings={type:'array',items:string};
  const tool={name:'dsh_ctf',description:'CTF preset status and explicit route selection. select mode=solo|orchestrated, task-specific reason, skill_plan={required:[{name,reason,references?:[]}]} or {required:[],none_reason}. Host loads complete selected bodies before the next model step. Does not start workers, change permissions or cancel existing work.',
    parameters:{type:'object',properties:{action:{enum:['status','select']},mode:{enum:['solo','orchestrated']},reason:string,
      skill_plan:{type:'object',properties:{required:{type:'array',maxItems:8,items:{type:'object',properties:{name:string,reason:string,references:strings},required:['name','reason'],additionalProperties:false}},none_reason:string},required:['required'],additionalProperties:false}},required:['action'],additionalProperties:false},
    output:{schema:{type:'string'},render(_args,value){return [{type:'text',text:value}];}},
    async execute(args,exec){
      if(!isMain(exec?.agent))throw Error('CTF route tool is for the main session');
      if(args.action==='status')return JSON.stringify(mode.status(exec.agent));
      if(args.action!=='select')throw Error('Unknown CTF action');
      return JSON.stringify(await mode.select(exec.agent,args));
    }};
  ctx.effect(()=>ctx.tools.register(tool),'ctf-mode: explicit mode selection');
}
