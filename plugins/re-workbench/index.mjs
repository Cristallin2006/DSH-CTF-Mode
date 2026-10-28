import {ReOwner} from './client.mjs';
export const name='re-workbench';
export const inject=['tools','systemPrompt'];
export function apply(ctx,config={}){
  if(config.enabled!==true)return;
  if(process.platform!=='linux')throw Error('Managed RE experiments require Linux; offline RE helpers remain portable');
  const owner=new ReOwner(config);
  const remove=ctx.provide('reExperiments',{drain:owner.drain.bind(owner),coverage:'configured local process groups under one shared owner root'});
  const tool={name:'dsh_re_experiment',description:'Optional managed local experiment. Submit only an operator-configured backend with stable operation_id. No default job lifetime limit. Status/outputs are not target acceptance. Read re-dynamic/references/re-owner.md when using this capability.',
    parameters:{type:'object',properties:{action:{enum:['submit','list','status','events','cancel','reconcile','read_artifact']},options:{type:'object',properties:{operation_id:{type:'string'},backend:{type:'string'},arguments:{type:'array',items:{type:'string'}},job:{type:'string'},after:{anyOf:[{type:'string'},{type:'integer'}]},limit:{type:'integer'},name:{enum:['stdout','stderr']},offset:{type:'integer'},max_bytes:{type:'integer'},sha256:{type:'string'}},additionalProperties:false}},required:['action','options'],additionalProperties:false},
    output:{schema:{type:'string'},render(_a,v){return [{type:'text',text:v}];}},
    async execute(a,exec){return JSON.stringify(await owner.command(exec.agent,a.action,a.options));}};
  ctx.effect(()=>ctx.tools.register(tool),'re-workbench: optional managed experiments');
  ctx.systemPrompt.section({name:'re-workbench:usage',order:878,text:'[Optional managed RE experiment] dsh_re_experiment uses explicitly configured local backends and shared resource declarations; it is not a universal process/device sandbox. Use ordinary foreground tools for ordinary analysis. For managed long experiments, keep one operation_id and query after lost replies. Model idle, disconnected transport and tool wait timeout do not prove cleanup. Read re-dynamic/references/re-owner.md as needed. Dedicated coordinators inspect/cancel; explicitly granted Solvers submit. No default job deadline, fixed route or mandatory experiment.'});
  ctx.effect(()=>async()=>{await remove();owner.close();},'re-workbench: close client only');
}
