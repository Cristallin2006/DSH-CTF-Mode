import {referencePolicy,readMaterial,referencePath} from './reference-policy.mjs?revision=0.7.1';
import {createHash} from 'node:crypto';

const digest=value=>createHash('sha256').update(value).digest('hex');
const section='analysis-orchestration:required-skills';
const owner='@deepseek-ai/dsh-system-prompt';
const clean=(value,max)=>typeof value==='string'&&value.trim()&&value.length<=max;
const fields=(value,allowed)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).every(key=>allowed.includes(key));
export function skillPlan(value){
  if(!fields(value,['required','none_reason'])||!Array.isArray(value.required)||value.required.length>8)throw Error('Declare skill_plan={required:[{name,reason,references:[]}]} or {required:[],none_reason:"why no specialist method is needed"}');
  const names=new Set();
  const required=value.required.map(item=>{
    if(!fields(item,['name','reason','references'])||!clean(item.name,100)||!(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).test(item.name)||names.has(item.name)||!clean(item.reason,1000))throw Error('Invalid or duplicate required skill; include its relevance reason');
    names.add(item.name);const refs=item.references??[];
    if(!Array.isArray(refs)||refs.length>8||new Set(refs).size!==refs.length||refs.some(ref=>!clean(ref,500)||!referencePath(ref)))throw Error('References must be distinct relative references/*.md paths inside the resolved skill');
    return {name:item.name,reason:item.reason,references:[...refs]};
  });
  if(required.length){if(value.none_reason!==undefined)throw Error('none_reason is only for an empty required list');return {required};}
  if(!clean(value.none_reason,2000))throw Error('An empty required list needs none_reason; do not silently omit skill selection');
  return {required,none_reason:value.none_reason};
}

const messageText=message=>(message?.content??[]).filter(block=>block.type==='text').map(block=>block.text).join('\n');
const runtime=message=>message?.source?.kind==='plugin'&&message.source.plugin===owner&&messageText(message).startsWith('Current runtime context');
export class Materials {
  constructor(engine,render){this.e=engine;this.render=render;this.prepared=new Map();}
  save(r,w,receipt){
    const fresh=this.e.store.work(w.task,w.id);
    if(fresh.child!==w.child||!['launching','running'].includes(fresh.state))return false;
    const old=fresh.skill_delivery;fresh.skill_delivery=receipt;this.e.store.saveWork(fresh);
    if(old?.state!==receipt.state||old?.digest!==receipt.digest||old?.error!==receipt.error)this.e.store.event(r,w.id,'skill_delivery',{...receipt,materials:receipt.materials??[]});
    return true;
  }
  async assemble(assembly,context){
    const e=this.e,agent=context.agent,item=e.child(agent);
    if(!item||item.orphan||e.closed||e.closing)return assembly;
    const r=e.store.run(item.task),w=e.store.work(item.task,item.id);
    // Never load provider content on unauthorized cold activation or after cancellation.
    if(!r||r.host!==e.host||r.state!=='enabled'||item.controller.signal.aborted||!['launching','running'].includes(w.state))return assembly;
    if(w.role==='observer')return assembly;
    try{
      e.store.scope(r);const plan=skillPlan(w.skill_plan);context.signal?.throwIfAborted();
      const plan_digest=digest(JSON.stringify(plan));
      if(!plan.required.length){this.prepared.set(item.child,{agent,none:true,plan_digest});this.save(r,w,{state:'not_required',digest:plan_digest,reason:plan.none_reason,authority:'coordinator selection; no content loaded'});return assembly;}
      if(typeof this.render!=='function'||!e.ctx.skills||!e.ctx.tools.get('skill',agent))throw Error('Native scoped skill loader unavailable');
      const lookup={cwd:agent.session.header.cwd,scope:agent,signal:context.signal};
      const catalog=await e.ctx.skills.list(lookup),blocks=[],materials=[];let bytes=0;
      for(const request of plan.required){
        context.signal?.throwIfAborted();
        const summary=catalog.find(skill=>skill.name===request.name);
        if(!summary?.invocation?.modelInvocable)throw Error('Required skill unavailable for model invocation: '+request.name);
        const skill=await e.ctx.skills.get(request.name,lookup);
        if(!skill?.invocation?.modelInvocable||skill.name!==request.name)throw Error('Required skill unavailable for model invocation: '+request.name);
        if(typeof skill.content!=='string')throw Error('Invalid native skill body');
        const body=this.render(skill);blocks.push(body);bytes+=Buffer.byteLength(body);if(bytes>65536)throw Error('Required skill bundle exceeds 64 KiB; narrow the selection or split the work');
        const resolved=await referencePolicy(skill,request.references);
        const metadata={reference_policy:resolved.policy,declared_references:request.references,name:skill.name,provider:skill.provider,source:skill.source,resource_base:skill.resourceBase??null,body_sha256:digest(skill.content),rendered_sha256:digest(body),references:[]};
        for(const ref of resolved.references){
          const data=await readMaterial(skill.resourceBase.path,ref);bytes+=data.bytes;
          blocks.push('[Required reference '+skill.name+'/'+ref+']\n'+data.content);
          metadata.references.push({path:ref,sha256:data.sha256,required_by:[...resolved.required.includes(ref)?['skill']:[],...request.references.includes(ref)?['assignment']:[]]});
        }
        materials.push(metadata);if(bytes>65536)throw Error('Required skill bundle exceeds 64 KiB; narrow the selection or split the work');
      }
      context.signal?.throwIfAborted();
      if(e.closed||e.closing||item.controller.signal.aborted)return assembly;
      e.store.scope(r);const current=e.store.run(item.task),fresh=e.store.work(item.task,item.id);
      if(current?.host!==e.host||current.state!=='enabled'||fresh.child!==item.child||!['launching','running'].includes(fresh.state)||digest(JSON.stringify(skillPlan(fresh.skill_plan)))!==plan_digest)return assembly;
      const hash=digest(JSON.stringify({plan,materials}));
      const text='[DSH required skill material '+w.id+' '+hash+']\nThese are host-loaded methods for this assignment; follow applicable instructions within existing user constraints and tool permissions. This bundle supersedes earlier versions. This receipt covers complete skill bodies and the listed references, including the skill-owned required-reference policy. A coordinator brief is routing/assignment context, not replacement source material. Further unlisted references remain on demand. No duplicate skill call is needed for already delivered full material. Delivery does not prove understanding or correct application.\n\n'+blocks.join('\n\n');
      bytes=Buffer.byteLength(text);if(bytes>65536)throw Error('Required skill bundle exceeds 64 KiB; narrow the selection or split the work');
      const coverage={skills:materials.length,references:materials.reduce((n,m)=>n+m.references.length,0),policy_references:materials.reduce((n,m)=>n+(m.reference_policy.required_references?.length??0),0)};
      this.prepared.set(item.child,{agent,text,digest:hash,materials,plan_digest});
      if(w.skill_delivery?.digest!==hash||w.skill_delivery?.state!=='delivered')this.save(r,w,{state:'prepared',digest:hash,materials,coverage,bytes,authority:'assembled for native runtime context; visibility checked before model step'});
      return {...assembly,contexts:[...assembly.contexts.filter(entry=>entry.name!==section),{name:section,text}]};
    }catch(error){
      if(e.closed||e.closing)return assembly;
      this.prepared.delete(item.child);
      if(context.signal?.aborted||item.controller.signal.aborted)return assembly;
      const fresh=e.store.work(item.task,item.id);
      this.save(r,fresh,{state:'blocked',error:String(error.message).slice(0,400),authority:'required material unavailable; no model execution permitted'});
      return assembly;
    }
  }
  verify(agent,decision){
    const e=this.e,item=e.child(agent);if(!item||item.orphan)return decision;
    const r=e.store.run(item.task),w=e.store.work(item.task,item.id);if(w.role==='observer')return decision;
    const prepared=this.prepared.get(item.child);
    let visible=false;
    let currentPlan;try{currentPlan=digest(JSON.stringify(skillPlan(w.skill_plan)));}catch{}
    if(prepared?.agent===agent&&prepared.plan_digest===currentPlan){
      if(prepared.none)visible=true;
      else{
        let message=(decision.messages??[]).filter(runtime).at(-1);
        if(!message){
          const nodes=agent.session.surface?.nodes??[];
          for(let index=nodes.length-1;index>=0;index--){const event=agent.session.eventAt(nodes[index]);if(event?.type==='user/message'&&runtime(event.data)){message=event.data;break;}}
        }
        visible=!!message&&messageText(message).includes(prepared.text);
      }
    }
    if(!visible){
      if(w.skill_delivery?.state!=='blocked')this.save(r,w,{state:'blocked',error:'Required skill material is not visible in the current native context',authority:'visibility guard; no model execution permitted'});
      return {kind:'reject'};
    }
    if(!prepared.none&&w.skill_delivery?.state!=='delivered')this.save(r,w,{...w.skill_delivery,state:'delivered',authority:'full bundle visible at native model-step admission; not proof of understanding or application'});
    return decision;
  }
  forget(child){this.prepared.delete(child);}
  close(){this.prepared.clear();}
}
