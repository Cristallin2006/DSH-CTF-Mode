/** Per-session host observations, never model-reported readiness. */
export class HookReadiness {
  constructor(){this.sessions=new Map();}
  record(payload,ok,error=null){
    const id=payload?.session_id;if(typeof id!=='string'||!id)return;
    const old=this.sessions.get(id),startup=['SessionStart','SubagentStart'].includes(payload.hook_event_name);
    this.sessions.set(id,{session_id:id,startup_seen:old?.startup_seen===true||startup&&ok,
      status:ok?'ok':'degraded',last_event:payload.hook_event_name,error:ok?null:String(error??'hook failed').slice(0,400)});
  }
  get(id){const value=this.sessions.get(id);return value?{...value,ready:value.startup_seen&&value.status==='ok'}:
    {session_id:id,ready:false,startup_seen:false,status:'not_observed'};}
  forget(id){this.sessions.delete(id);}
}
