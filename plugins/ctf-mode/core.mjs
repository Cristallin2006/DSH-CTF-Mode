/** Opt-in main-session CTF admission. Routes are model decisions, not keyword guesses. */
import {createHash} from 'node:crypto';
import {skillPlan} from '../analysis-orchestration/materials.mjs';
import {referencePolicy,readMaterial} from '../analysis-orchestration/reference-policy.mjs';

const hash=value=>createHash('sha256').update(value).digest('hex');
const section='ctf-mode:required-skills';
const text=m=>(m?.content??[]).filter(b=>b.type==='text').map(b=>b.text).join('\n');
const runtime=m=>m?.source?.kind==='plugin'&&m.source.plugin==='@deepseek-ai/dsh-system-prompt'&&text(m).startsWith('Current runtime context');
export const isMain=agent=>!!agent?.session?.header?.id&&!agent.session.header.parentSession&&agent.session.header.origin!=='subagent';
const coordination=new Set(['dsh_ctf','skill','analysis_session','dsh_memory_read','dsh_memory_write','dsh_handoff','dsh_knowledge','dsh_orchestration','read_file','Read','read','glob','Glob','grep','Grep','ls','LS','list_directory']);
const dispatch=/^(?:subagent|agent_|task$|workflow$|ralph$)/i;

export class CtfMode {
  constructor(ctx,{renderSkillContent,health,orchestrationHealth,mode='auto',policy=referencePolicy,read=readMaterial}={}){
    if(!['auto','solo','orchestrated'].includes(mode))throw Error('CTF mode must be auto, solo or orchestrated');
    this.ctx=ctx;this.render=renderSkillContent;this.health=health;this.orchestrationHealth=orchestrationHealth;
    this.mode=mode;this.policy=policy;this.read=read;this.sessions=new Map();
  }
  state(agent){
    if(!isMain(agent))throw Error('CTF route selection belongs to the main session');
    const id=agent.session.header.id;
    if(!this.sessions.has(id))this.sessions.set(id,{mode:null,reason:null,plan:null,revision:0,verified:null,prepared:null,error:null});
    return this.sessions.get(id);
  }
  status(agent){
    const s=this.state(agent);
    return {preset:'ctf',preference:this.mode,mode:s.mode??'selection_required',reason:s.reason,revision:s.revision,
      delivery:s.prepared?.state??'pending',verified:s.verified===s.revision&&s.prepared?.state==='delivered',
      skills:s.prepared?.materials??[],error:s.error,authority:'delivery is not understanding, tool permission or target acceptance'};
  }
  async checkHooks(agent){
    const health=await this.health(agent);
    if(health?.ok!==true||health.hook_session?.session_id!==agent.session.header.id||health.hook_session?.ready!==true)
      throw Error('This session has no successful startup/current hook receipt; check analysis_session health and the CTF profile');
    return health;
  }
  async select(agent,input){
    const s=this.state(agent);
    if(!input||!['solo','orchestrated'].includes(input.mode)||typeof input.reason!=='string'||!input.reason.trim()||input.reason.length>2000)
      throw Error('Select solo or orchestrated and give a task-specific reason');
    if(this.mode!=='auto'&&input.mode!==this.mode)throw Error('This profile pins '+this.mode+'; use an auto preset or change the explicit profile preference');
    const plan=skillPlan(input.skill_plan);
    await this.checkHooks(agent);
    const orchestration=await this.orchestrationHealth(agent);
    if(input.mode==='orchestrated'&&orchestration?.ok!==true)throw Error('Orchestration runtime unavailable; no dispatch was started');
    if(input.mode==='solo'&&orchestration?.current_run)throw Error('Disable/drain the existing orchestration run before selecting solo; CTF mode never cancels work implicitly');
    s.mode=input.mode;s.reason=input.reason;s.plan=plan;s.revision++;s.verified=null;s.prepared=null;s.error=null;
    return this.status(agent);
  }
  async assemble(assembly,context){
    const agent=context.agent;if(!isMain(agent))return assembly;
    const s=this.state(agent),revision=s.revision;
    s.verified=null;
    try{
      await this.checkHooks(agent);context.signal?.throwIfAborted();
      if(!this.ctx.skills||typeof this.render!=='function'||!this.ctx.tools.get('skill',agent)||!this.ctx.tools.get('dsh_ctf',agent))
        throw Error('CTF preset needs the native scoped skill loader and route tool');
      const required=[{name:'ctf-mode',reason:'CTF routing and evidence boundaries',references:[]},
                      {name:'analysis-session',reason:'Hook/state interface and evidence continuity',references:[]}];
      if(s.mode==='orchestrated')required.push({name:'analysis-orchestration',reason:'Selected coordinator role',references:[]});
      for(const item of s.plan?.required??[]){
        const prior=required.find(p=>p.name===item.name);
        if(prior)prior.references=[...new Set([...prior.references,...item.references])];else required.push(item);
      }
      const lookup={cwd:agent.session.header.cwd,scope:agent,signal:context.signal};
      const catalog=await this.ctx.skills.list(lookup),blocks=[],materials=[];let bytes=0;
      for(const request of required){
        context.signal?.throwIfAborted();
        if(!catalog.find(v=>v.name===request.name)?.invocation?.modelInvocable)throw Error('Required CTF skill unavailable: '+request.name);
        const skill=await this.ctx.skills.get(request.name,lookup);
        if(skill?.name!==request.name||!skill.invocation?.modelInvocable||typeof skill.content!=='string')throw Error('Required CTF skill unavailable: '+request.name);
        const body=this.render(skill);blocks.push(body);bytes+=Buffer.byteLength(body);
        const resolved=await this.policy(skill,request.references),metadata={name:request.name,body_sha256:hash(skill.content),references:[]};
        for(const reference of resolved.references){
          const data=await this.read(skill.resourceBase.path,reference);
          blocks.push('[Required reference '+request.name+'/'+reference+']\n'+data.content);bytes+=data.bytes;
          metadata.references.push({path:reference,sha256:data.sha256});
        }
        materials.push(metadata);
        if(bytes>65536)throw Error('CTF material bundle exceeds 64 KiB; narrow specialist selection');
      }
      const routing={preference:this.mode,mode:s.mode??'selection_required',reason:s.reason,revision,none_reason:s.plan?.none_reason??null};
      const bundle='[DSH CTF preset '+hash(JSON.stringify({routing,materials}))+']\n'+
        'Host-loaded complete skill bodies and required references; current user constraints and native tool permissions remain authoritative. Delivery does not prove understanding. Select a route with dsh_ctf before execution.\n'+JSON.stringify(routing)+'\n\n'+blocks.join('\n\n');
      if(Buffer.byteLength(bundle)>65536)throw Error('CTF material bundle exceeds 64 KiB');
      context.signal?.throwIfAborted();
      if(s.revision!==revision)throw Error('CTF selection changed during assembly; assemble the current revision');
      s.prepared={state:'prepared',text:bundle,materials,revision};s.error=null;
      return {...assembly,contexts:[...(assembly.contexts??[]).filter(v=>v.name!==section),{name:section,text:bundle}]};
    }catch(error){
      s.prepared={state:'blocked',revision};s.error=String(error.message).slice(0,500);
      this.ctx.logger?.warn?.('[CTF preset blocked] '+s.error);
      return assembly;
    }
  }
  verify(agent,decision){
    if(!isMain(agent)||decision.kind==='reject')return decision;
    const s=this.state(agent),p=s.prepared;
    let message=(decision.messages??[]).filter(runtime).at(-1);
    if(!message){
      const nodes=agent.session.surface?.nodes??[];
      for(let i=nodes.length-1;i>=0;i--){const event=agent.session.eventAt(nodes[i]);if(event?.type==='user/message'&&runtime(event.data)){message=event.data;break;}}
    }
    if(!p?.text||p.revision!==s.revision||!message||!text(message).includes(p.text)){
      s.verified=null;s.error=s.error??'Complete CTF materials are not visible in current runtime context';
      this.ctx.logger?.warn?.('[CTF preset blocked] '+s.error);return {kind:'reject'};
    }
    p.state='delivered';s.verified=s.revision;return decision;
  }
  async preTool(exec){
    if(!isMain(exec.agent))return null;
    if(exec.name==='dsh_ctf'||exec.name==='skill')return null;
    if(['analysis_session','dsh_orchestration'].includes(exec.name)&&['health','schema'].includes(exec.arguments?.action))return null;
    try{await this.checkHooks(exec.agent);}catch(error){return {kind:'deny',reason:String(error.message)};}
    const s=this.state(exec.agent);
    if(!s.mode)return {kind:'deny',reason:'CTF route selection required: call dsh_ctf select with a mode, reason and skill_plan'};
    if(s.verified!==s.revision||s.prepared?.state!=='delivered')return {kind:'deny',reason:'Current CTF skill selection must be host-delivered before execution; wait for the next model step'};
    if(s.mode==='orchestrated'&&!coordination.has(exec.name))return {kind:'deny',reason:'CTF coordinator delegates execution through dsh_orchestration; it does not run execution tools directly'};
    if(s.mode==='solo'&&(dispatch.test(exec.name)||exec.name==='dsh_orchestration'&&['enable','resume','dispatch','followup'].includes(exec.arguments?.action)))
      return {kind:'deny',reason:'Select orchestrated mode before dispatching children'};
    return null;
  }
  forget(agent){this.sessions.delete(agent?.session?.header?.id);}
  close(){this.sessions.clear();}
}
