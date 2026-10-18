import {randomUUID} from 'node:crypto';
import {live,text} from './store.mjs?revision=0.4.0';
import {trace,taskContext} from './contract.mjs?revision=0.4.0';

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
      const prompt={task:r.task,work:w.id,...e.assignment(r,w),observed_work:w.role==='observer'?e.detail(r,w.observe_work):null};
      const accepted=await e.ctx.subagents.startContinuable({provider:'spawn',childId:item.child,label:'dsh-'+w.role+':'+w.key,signal:item.controller.signal,
        request:{parent,prompt:[{type:'text',text:JSON.stringify(prompt)}],toolFilter:{allow:w.effective_tools},maxDepth:(parent.options.subagentDepth??0)+1,persona:e.persona(w)}});
      if(accepted.childId!==item.child)throw Error('Native continuable identity mismatch');
      item.run.localAgent=e.ctx.agents.get(item.child)??item.run.localAgent;
      const q=e.store.work(r.task,w.id);q.initial_message_id=accepted.messageId;if(q.state==='launching')q.state='running';e.store.saveWork(q);e.store.event(r,w.id,'started',{child:item.child,mode:'continuable'});
    }catch(error){
      clearTimeout(item.timer);let state=item.controller.signal.aborted?'cancelled':'failed';
      try{await e.ctx.subagents.drainContinuableChildren(parent,[item.child]);}catch{state='cleanup_unknown';}
      const q=e.store.work(r.task,w.id);q.state=state;q.diagnostic=short(error);q.finished=Date.now();e.store.saveWork(q);e.store.event(r,q.id,'settled',{state});
      if(state!=='cleanup_unknown'){e.children.delete(item.child);e.active.delete(item.id);}e.notify(r,'Solver creation '+state+': '+w.key);
    }
  }
  end(info){
    const e=this.e,item=e.children.get(info.id);if(!item||item.closing)return;
    const r=e.store.run(item.task),w=e.store.work(item.task,item.id);if(!['running','launching'].includes(w.state))return;
    clearTimeout(item.timer);
    if(item.run.localAgent)try{e.traceCache.delete(w.id);e.traceCache.set(w.id,trace(item.run.localAgent.session));while(e.traceCache.size>16)e.traceCache.delete(e.traceCache.keys().next().value);}catch{}
    const raw=(info.lastAssistantMessage??[]).filter(x=>x.type==='text').map(x=>x.text).join('\n');
    w.result=raw.length>32768?raw.slice(0,32768):raw;w.result_truncated=raw.length>32768;w.result_revision=(w.result_revision??0)+1;w.state=item.controller.signal.aborted?'cancelled':info.stopReason==='completed'?'returned':'failed';w.diagnostic=item.controller.signal.aborted?String(item.controller.signal.reason).slice(0,500):info.stopReason==='completed'?null:'Native turn stopped: '+info.stopReason;w.finished=Date.now();w.native_stop=info.stopReason;w.guidance_waiting_until=null;
    w.turn_history??=[];w.turn_history.push({revision:w.result_revision,at:w.finished,state:w.state,stop_reason:info.stopReason,summary:raw.slice(0,1000),native_session:item.child});w.turn_history=w.turn_history.slice(-16);
    e.store.saveWork(w);e.store.event(r,w.id,'settled',{state:w.state,result_revision:w.result_revision,child:item.child,resumable:true});e.notify(r,'Solver '+w.key+' '+w.state+'; child remains continuable');
  }
  async wake(r,id,parent){
    const e=this.e;let w=e.store.work(r.task,id),item=e.active.get(id);
    if(e.quarantines.has(w.child))throw Error('An unauthorized native activation is draining; inspect status before retrying');
    if(w.mode!=='continuable'||!w.child)throw Error('Legacy one-shot work cannot be resumed; add new work');
    if(live.has(w.state)){if(!item||item.closing)throw Error('Native lifecycle is not ready');return item;}
    if(e.store.works(r).some(d=>d.id!==id&&d.depends_on.includes(id)&&!['retired','cancelled'].includes(d.state)))throw Error('Retire dependent work before revising its adopted input; or create new work');
    if(!['returned','adopted','rejected','needs_more_evidence','failed','interrupted','cancelled'].includes(w.state))throw Error('Work cannot accept follow-up');
    w=e.store.claim(r,id,e.host,e.maxGlobal,true);w.review=null;w.result=null;w.diagnostic=null;w.finished=null;w.turn_serial=(w.turn_serial??1)+1;w.checkpoint_hash=null;w.turn_started=Date.now();e.store.saveWork(w);
    item??=this.item(r,w,parent);if(item.controller.signal.aborted){e.children.delete(item.child);e.active.delete(id);item=this.item(r,w,parent);}
    this.arm(r,w,item);return item;
  }
  async deliver(r,id,content){
    const e=this.e,parent=e.parents.get(r.owner);if(!parent)throw Error('Owning parent is unavailable');const item=await this.wake(r,id,parent);
    try{
      const messageId=await e.ctx.subagents.sendMessage(parent,item.child,[{type:'text',text:content},{type:'text',text:'[DSH current recorded context] '+JSON.stringify(taskContext(e.store,r))}],{signal:item.controller.signal});
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
    if(!item){if(live.has(w.state))throw Error('Cleanup belongs to a previous host; inspect and recover first');if(!preserve){w.state=w.state==='pending'?'retired':'cancelled';w.diagnostic=reason;e.store.saveWork(w);e.store.event(r,id,'retired',{reason});}return;}
    if(item.closing)return item.closing;
    const previous=w.state,wasLive=live.has(previous);w.state='stopping';e.store.saveWork(w);clearTimeout(item.timer);item.controller.abort(reason);
    item.closing=(async()=>{
      try{
        await item.completion;await e.ctx.subagents.drainContinuableChildren(item.parentAgent,[item.child]);
        w=e.store.work(r.task,id);w.state=preserve&&!wasLive?previous:'cancelled';w.diagnostic=preserve&&!wasLive?w.diagnostic:reason;w.guidance_waiting_until=null;w.finished??=Date.now();e.store.saveWork(w);e.store.event(r,id,'child_released',{state:w.state,reason});e.children.delete(item.child);e.active.delete(id);
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
