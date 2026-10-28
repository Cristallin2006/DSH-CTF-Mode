import {randomUUID} from 'node:crypto';
import {live,text} from './store.mjs?revision=0.8.0';
import {trace,taskContext} from './contract.mjs?revision=0.8.0';

const short=e=>String(e?.message??e).slice(0,500);
export class Continuable {
  constructor(engine){this.e=engine;}
  item(r,w,parent){
    const e=this.e,id=w.child??randomUUID(),item={id:w.id,task:r.task,parent:r.owner,parentAgent:parent,child:id,controller:new AbortController(),run:{id,localAgent:null},completion:null,timer:null,closing:null};
    item.controller.signal.addEventListener('abort',()=>{item.run.localAgent?.cancel({kind:'parent'});e.guidanceWaiters.get(w.id)?.();},{once:true});
    e.active.set(w.id,item);e.children.set(id,item);return item;
  }
  arm(r,w,item){
    clearTimeout(item.timer);const until=Math.min(w.timeout_ms==null?Infinity:w.started+w.timeout_ms,r.expires??Infinity);
    if(Number.isFinite(until))item.timer=setTimeout(()=>void this.release(r,w.id,'Explicit execution deadline reached').catch(e=>{this.e.fault=short(e);}),Math.max(1,until-Date.now()));
  }
  async start(r,w,parent,item){
    const e=this.e;this.arm(r,w,item);
    try{
      const prompt={task:r.task,work:w.id,...e.packets.prepare(r,w,e.assignment(r,w)),observed_work:w.role==='observer'?e.detail(r,w.observe_work):null};
      if(w.role==='observer'&&Buffer.byteLength(JSON.stringify(prompt))>65536)throw Error('Zero-tool Observer input exceeds 64 KiB; provide a narrower original-source brief or use a scoped read-only Solver');
      const accepted=await e.ctx.subagents.startContinuable({provider:'spawn',childId:item.child,label:'dsh-'+w.role+':'+w.key,signal:item.controller.signal,
        request:{parent,prompt:[{type:'text',text:JSON.stringify(prompt)}],toolFilter:{allow:w.effective_tools},maxDepth:(parent.options.subagentDepth??0)+1,persona:e.persona(w)}});
      if(accepted.childId!==item.child)throw Error('Native continuable identity mismatch');
      item.run.localAgent=e.ctx.agents.get(item.child)??item.run.localAgent;
      const q=e.store.work(r.task,w.id);q.initial_message_id=accepted.messageId;if(q.state==='launching')q.state='running';e.store.saveWork(q);e.store.event(r,w.id,'started',{child:item.child,mode:'continuable'});
    }catch(error){
      clearTimeout(item.timer);let state=item.controller.signal.aborted?'cancelled':'failed';
      try{await e.ctx.subagents.drainContinuableChildren(parent,[item.child]);}catch{state='cleanup_unknown';}
      const q=e.store.work(r.task,w.id);q.state=state;q.diagnostic=short(error);q.finished=Date.now();e.store.saveWork(q);e.store.event(r,q.id,'settled',{state});
      if(state!=='cleanup_unknown'){e.materials.forget(item.child);e.children.delete(item.child);e.active.delete(item.id);}e.notify(r,'Solver creation '+state+': '+w.key);
    }
  }
  end(info){
    const e=this.e,item=e.children.get(info.id);if(!item||item.closing)return;
    const r=e.store.run(item.task),w=e.store.work(item.task,item.id);if(!['running','launching'].includes(w.state))return;
    clearTimeout(item.timer);
    if(item.run.localAgent)try{e.traceCache.delete(w.id);e.traceCache.set(w.id,trace(item.run.localAgent.session));while(e.traceCache.size>16)e.traceCache.delete(e.traceCache.keys().next().value);}catch{}
    const raw=(info.lastAssistantMessage??[]).filter(x=>x.type==='text').map(x=>x.text).join('\n');
    e.store.tx(()=>{e.store.saveResult(w,raw);w.state=item.controller.signal.aborted?'cancelled':info.stopReason==='completed'?'returned':'failed';w.diagnostic=item.controller.signal.aborted?String(item.controller.signal.reason).slice(0,500):w.skill_delivery?.state==='blocked'?'Required skill delivery blocked: '+w.skill_delivery.error:info.stopReason==='completed'?null:'Native turn stopped: '+info.stopReason;if(w.state==='returned'&&e.packets.pending(w,item.child).length){w.state='failed';w.diagnostic='Required assignment material was not fully read';w.material_delivery={state:'blocked',authority:'Incomplete required text delivery; no successful conclusion accepted'};}w.finished=Date.now();w.native_stop=info.stopReason;w.guidance_waiting_until=null;
    w.turn_history??=[];w.turn_history.push({revision:w.result_revision,at:w.finished,state:w.state,stop_reason:info.stopReason,summary:raw.slice(0,1000),native_session:item.child});w.turn_history=w.turn_history.slice(-16);
    e.store.saveWork(w);e.store.event(r,w.id,'settled',{state:w.state,result_revision:w.result_revision,child:item.child,resumable:true});});e.notify(r,'Solver '+w.key+' '+w.state+'; child remains continuable');
  }
  async wake(r,id,parent){
    const e=this.e;let w=e.store.work(r.task,id),item=e.active.get(id);
    if(e.quarantines.has(w.child))throw Error('An unauthorized native activation is draining; inspect status before retrying');
    e.checkExecution(r,id,parent);
    if(w.mode!=='continuable'||!w.child)throw Error('Legacy one-shot work cannot be resumed; add new work');
    if(live.has(w.state)){if(!item||item.closing)throw Error('Native lifecycle is not ready');return item;}
    if(e.store.hasDependents(r,id))throw Error('Retire dependent work before revising its adopted input; or create new work');
    if(!['returned','adopted','rejected','needs_more_evidence','failed','interrupted','cancelled'].includes(w.state))throw Error('Work cannot accept follow-up');
    w=e.store.claim(r,id,e.host,e.maxGlobal,true);w.review=null;w.result=null;w.diagnostic=null;w.finished=null;w.turn_serial=(w.turn_serial??1)+1;w.checkpoint_hash=null;w.turn_started=Date.now();e.store.saveWork(w);
    item??=this.item(r,w,parent);if(item.controller.signal.aborted){e.materials.forget(item.child);e.children.delete(item.child);e.active.delete(id);item=this.item(r,w,parent);}
    this.arm(r,w,item);return item;
  }
  async deliver(r,id,content,plan){
    const e=this.e,parent=e.parents.get(r.owner);if(!parent)throw Error('Owning parent is unavailable');const restoreAssignment=e.store.work(r.task,id).skill_delivery?.state==='blocked'||e.store.work(r.task,id).material_delivery?.state==='blocked';if(plan!==undefined){const current=e.store.work(r.task,id);if(current.role==='observer'||live.has(current.state))throw Error('Change skill_plan only on an idle Solver followup');}const item=await this.wake(r,id,parent);if(plan!==undefined){const changed=e.store.work(r.task,id);changed.skill_plan=plan;changed.skill_delivery={state:'pending',authority:'selected for followup; not yet delivered'};e.store.saveWork(changed);}
    try{
      const assignment=restoreAssignment?[{type:'text',text:JSON.stringify({task:r.task,work:id,...e.packets.prepare(r,e.store.work(r.task,id),e.assignment(r,e.store.work(r.task,id))),restored_after_material_block:true})}]:[];
      const fresh=e.store.work(r.task,id),envelope=e.packets.prepare(r,fresh,e.assignment(r,fresh));content=e.packets.message(r,fresh,content);
      const messageId=await e.ctx.subagents.sendMessage(parent,item.child,[...assignment,{type:'text',text:content},...(envelope.assignment_materials?.length?[{type:'text',text:'[DSH assignment material index] '+JSON.stringify(envelope.assignment_materials)}]:[]),{type:'text',text:'[DSH current recorded context] '+JSON.stringify({recorded_task:envelope.recorded_task,targets:envelope.targets,...(envelope.targets_material?{targets_material:envelope.targets_material}:{}),skill_plan:e.store.work(r.task,id).skill_plan??null,skill_plan_note:'This is the current coordinator selection; earlier assignment selections may have been replaced. It grants no additional tools.'})}],{signal:item.controller.signal});
      item.run.localAgent=e.ctx.agents.get(item.child)??item.run.localAgent;
      const q=e.store.work(r.task,id);if(q.state==='launching')q.state='running';e.store.saveWork(q);return messageId;
    }catch(error){
      // Delivery rejection may race an already running turn. Stop and confirm
      // quiescence rather than reporting a harmless idle failure.
      await this.release(r,id,'Native continuation delivery failed');throw error;
    }
  }
  async release(r,id,reason,preserve=false){
    const e=this.e;let w=e.store.work(r.task,id),item=e.active.get(id);
    if(!item){if(live.has(w.state))throw Error('Cleanup belongs to a previous host; inspect and recover first');const before=w.state;w.state='stopping';e.store.saveWork(w);try{await e.ctx.get?.('reExperiments')?.drain(r.task,null,r.owner,id);}catch(error){w.state='cleanup_unknown';e.store.saveWork(w);throw error;}w.state=preserve?before:before==='pending'?'retired':'cancelled';if(!preserve){w.diagnostic=reason;e.store.event(r,id,'retired',{reason});}e.store.saveWork(w);return;}
    if(item.closing)return item.closing;
    const previous=w.state,wasLive=live.has(previous);w.state='stopping';e.store.saveWork(w);clearTimeout(item.timer);item.controller.abort(reason);
    item.closing=(async()=>{
      try{
        await item.completion;await e.ctx.subagents.drainContinuableChildren(item.parentAgent,[item.child]);
        await e.ctx.get?.('reExperiments')?.drain(r.task,null,r.owner,id);
        w=e.store.work(r.task,id);w.state=preserve&&!wasLive?previous:'cancelled';w.diagnostic=preserve&&!wasLive?w.diagnostic:reason;w.guidance_waiting_until=null;w.finished??=Date.now();e.store.saveWork(w);e.store.event(r,id,'child_released',{state:w.state,reason});e.materials.forget(item.child);e.children.delete(item.child);e.active.delete(id);
      }catch(error){w=e.store.work(r.task,id);w.state='cleanup_unknown';w.diagnostic=short(error);e.store.saveWork(w);throw error;}
    })();
    let timer;try{await Promise.race([item.closing,new Promise((_r,reject)=>{timer=setTimeout(()=>reject(Error('Native child cleanup unconfirmed')),e.drainMs);})]);}
    catch(error){w=e.store.work(r.task,id);w.state='cleanup_unknown';w.diagnostic=short(error);e.store.saveWork(w);throw error;}finally{clearTimeout(timer);}
  }
  async releaseTask(r,reason,preserve=true){
    const result=await Promise.allSettled([...this.e.active.values()].filter(i=>i.task===r.task).map(i=>this.release(r,i.id,reason,preserve)));
    if(result.some(x=>x.status==='rejected'))throw Error('One or more native child cleanups are unconfirmed');
  }
}
