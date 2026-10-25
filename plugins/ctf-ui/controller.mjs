/** Compact session controls. All writes claim the native idle-maintenance phase. */
import {isMain} from '../ctf-mode/core.mjs';
const preferences=['auto','solo','orchestrated'];
function record(value,keys){
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!keys.includes(k)))throw Error('Invalid CTF control request');
  return value;
}
function sessionId(value){if(typeof value!=='string'||!value||value.length>200||/[\s/\\\x00-\x1f]/.test(value))throw Error('Invalid session identity');return value;}
export class CtfUiController{
  constructor({getAgent,presetOf,settings}){this.getAgent=getAgent;this.presetOf=presetOf;this.settings=settings;this.controllers=new Map();this.defaultWrites=Promise.resolve();}
  defaultPreference(){return this.settings.get().defaultPreference;}
  register(mode,preset){
    if(this.controllers.has(preset))throw Error('Duplicate CTF preset controller');
    this.controllers.set(preset,mode);return ()=>{if(this.controllers.get(preset)===mode)this.controllers.delete(preset);};
  }
  resolve(id){
    const agent=this.getAgent(sessionId(id));if(!agent)return null;
    if(!isMain(agent))throw Error('CTF controls belong to an ordinary main session');
    const mode=this.controllers.get(this.presetOf(agent));
    if(!mode)throw Error('This session does not run a registered CTF preset');
    return {agent,mode};
  }
  async status(request){
    record(request,['session_id']);const target=this.resolve(request.session_id);
    if(!target)return {live:false,mode:'not_live',verified:false};
    const {agent,mode}=target,s=mode.status(agent);
    let hook=false,orchestration=null;
    try{await mode.checkHooks(agent);hook=true;}catch{}
    try{const h=await mode.orchestrationHealth(agent);orchestration={available:h?.ok===true,run:!!h?.current_run,unsettled:!!h?.current_run?.unsettled};}catch{}
    // Never return tool traces, task briefs, file contents, model routes or credentials.
    return {live:true,preference:s.preference,locked_mode:s.locked_mode,mode:s.mode,revision:s.revision,
      idle:agent.status==='idle',hook_ready:hook,delivery:s.delivery,verified:s.verified,
      skills:s.skills.map(v=>v.name),orchestration,error:s.error};
  }
  async change(request){
    record(request,['session_id','action','value','expected_revision']);
    if(!['preference','route'].includes(request.action)||!preferences.includes(request.value)||request.action==='route'&&request.value==='auto'||!Number.isSafeInteger(request.expected_revision)||request.expected_revision<0)throw Error('Invalid CTF change');
    const target=this.resolve(request.session_id);if(!target)throw Error('Start or resume this CTF session before changing its mode');
    const {agent,mode}=target;
    if(agent.status!=='idle'||typeof agent.runMaintenance!=='function')throw Error('Session is busy; retry after the current turn finishes');
    await agent.runMaintenance(async signal=>{
      signal.throwIfAborted();
      if(this.getAgent(request.session_id)!==agent||this.controllers.get(this.presetOf(agent))!==mode)throw Error('CTF session changed; refresh and retry');
      if(request.action==='preference')return mode.setPreference(agent,request.value,request.expected_revision);
      const s=mode.state(agent);
      await mode.select(agent,{mode:request.value,reason:'User selected the execution route in CTF session controls',expected_revision:request.expected_revision,signal,
        skill_plan:s.plan??{required:[],none_reason:'User selected the route before task analysis; choose task-specific skills before solving'}});
    });
    return this.status({session_id:request.session_id});
  }
  async defaults(request){
    record(request,[]);return {defaultPreference:this.defaultPreference()};
  }
  async saveDefaults(request){
    record(request,['defaultPreference','expected_preference']);
    if(!preferences.includes(request.defaultPreference)||!preferences.includes(request.expected_preference))throw Error('Invalid CTF default preference');
    const write=this.defaultWrites.then(async()=>{
      if(this.defaultPreference()!==request.expected_preference)throw Error('CTF defaults changed; refresh and retry');
      await this.settings.update({defaultPreference:request.defaultPreference});return this.defaults({});
    });
    this.defaultWrites=write.catch(()=>{});return write;
  }
}
