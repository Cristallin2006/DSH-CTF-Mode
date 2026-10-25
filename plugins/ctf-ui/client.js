window.__ModuleLoader__.load({id:'dsh-ctf-ui',factory:require=>{
  const React=require('react'),h=React.createElement;
  const labels={auto:'自动判断',solo:'优先单兵',orchestrated:'优先编排'};
  const routes={solo:'单兵解题',orchestrated:'编排协作',selection_required:'待判断',not_live:'待恢复'};
  const style=`.ctf-controls{position:relative;font-size:12px}.ctf-controls summary{cursor:pointer;list-style:none;border:1px solid var(--dsw-alias-border-l3,rgba(128,128,128,.3));border-radius:6px;padding:5px 9px}.ctf-controls summary::-webkit-details-marker{display:none}.ctf-panel{box-sizing:border-box;position:absolute;right:0;top:calc(100% + 8px);z-index:50;width:min(374px,calc(100vw - 32px));padding:16px;border:1px solid var(--dsw-alias-border-l3,#555);border-radius:10px;background:var(--dsw-alias-bg-layer-1,#242426);color:inherit;box-shadow:0 8px 24px #0004}.ctf-panel p,.ctf-settings p{line-height:1.6;margin:8px 0;opacity:.8}.ctf-controls button,.ctf-settings button,.ctf-settings select{font:inherit;color:inherit;background:transparent;border:1px solid var(--dsw-alias-border-l3,#666);border-radius:6px;padding:7px 10px;cursor:pointer}.ctf-controls button:disabled,.ctf-settings button:disabled{opacity:.4;cursor:default}.ctf-controls :focus-visible,.ctf-settings :focus-visible{outline:2px solid var(--dsw-alias-brand-primary-new-colorprimary-new-color,#8aafff);outline-offset:3px}.ctf-choices{display:flex;gap:5px;flex-wrap:wrap;margin:8px 0}.ctf-choices label{display:flex;gap:4px;align-items:center;min-height:32px}.ctf-panel hr{border:0;border-top:1px solid var(--dsw-alias-border-l3,#555);margin:12px 0}.ctf-error{color:var(--text-danger,#ffb1b1);overflow-wrap:anywhere}.ctf-settings{max-width:640px}.ctf-settings h2{font-size:18px;font-weight:600;margin-bottom:12px}.ctf-settings select{display:block;margin:12px 0;background:var(--dsw-alias-bg-layer-1,#242426)}.ctf-settings option{background:var(--dsw-alias-bg-layer-1,#242426)}.ctf-receipts{display:flex;gap:12px;flex-wrap:wrap;margin-top:10px}`;
  async function call(remote,method,request){const r=await remote.ctfUi[method](request);if(!r.ok)throw Error(r.error?.message??'操作失败');return r.value;}
  function Header({sessionId,useSessions,remote}){
    const preset=useSessions(s=>s.byId[sessionId]?.projectionValues?.agentPreset);
    const [state,setState]=React.useState(null),[error,setError]=React.useState(''),[busy,setBusy]=React.useState(false);
    const generation=React.useRef(0),mutating=React.useRef(false),details=React.useRef(null);
    const load=React.useCallback(async()=>{
      if(mutating.current)return;
      const n=++generation.current;
      try{const value=await call(remote,'status',{session_id:sessionId});if(n===generation.current){setState(value);setError('');}}
      catch(e){if(n===generation.current)setError(e.message);}
    },[sessionId,remote]);
    React.useEffect(()=>{
      mutating.current=false;setBusy(false);setState(null);setError('');if(preset!=='ctf')return;
      load();const timer=setInterval(()=>{if(document.visibilityState==='visible')load();},10000);
      return ()=>{clearInterval(timer);generation.current++;};
    },[preset,load]);
    async function change(action,value){
      setBusy(true);setError('');mutating.current=true;const ticket=++generation.current;
      try{const result=await call(remote,'change',{session_id:sessionId,action,value,expected_revision:state.revision});if(ticket===generation.current)setState(result);}
      catch(e){if(ticket===generation.current)setError(e.message);}finally{if(ticket===generation.current){mutating.current=false;setBusy(false);}}
    }
    if(preset!=='ctf')return null;
    const disabled=busy||!state?.live||!state.idle;
    return h('details',{className:'ctf-controls',ref:details,onKeyDown:e=>{if(e.key==='Escape'){details.current.open=false;details.current.querySelector('summary')?.focus();}},onToggle:e=>{if(e.currentTarget.open)load();}},
      h('summary',{title:'CTF 执行偏好、实际模式与就绪状态'},'CTF · '+(routes[state?.mode]??'读取中')),
      h('div',{className:'ctf-panel'},
        h('strong',null,'CTF 会话'),
        h('p',null,'实际模式：'+(routes[state?.mode]??'读取中')),
        h('fieldset',{disabled,style:{border:0,padding:0,margin:0}},h('legend',null,'本会话偏好'),
          h('div',{className:'ctf-choices'},...Object.entries(labels).map(([value,label])=>h('label',{key:value},h('input',{type:'radio',name:'ctf-pref-'+sessionId,value,checked:state?.preference===value,disabled:!!state?.locked_mode&&state.locked_mode!==value,onChange:()=>change('preference',value)}),label)))),
        h('p',null,'偏好交给 Agent 判断，不会立即改变实际模式。'),
        h('div',{className:'ctf-receipts','aria-live':'polite'},h('span',null,'Hook：'+(state?.hook_ready?'已就绪':'待回执')),h('span',null,'知识材料：'+(state?.verified?'已送达':'待送达'))),
        state?.locked_mode&&h('p',null,'当前配置锁定了执行模式。'),
        state?.live&&!state.idle&&h('p',null,'会话正在运行，结束当前轮后可调整。'),
        state&&!state.live&&h('p',null,'恢复会话后可调整。查看此面板不会启动 Agent。'),
        h('hr'),h('div',{className:'ctf-choices'},
          h('button',{type:'button',disabled:disabled||state?.mode==='solo'||state?.locked_mode==='orchestrated',onClick:()=>change('route','solo')},'切换单兵'),
          h('button',{type:'button',disabled:disabled||state?.mode==='orchestrated'||state?.locked_mode==='solo',onClick:()=>change('route','orchestrated')},'切换编排')),
        h('p',null,'切换不会自动派发或终止任务。已有编排须先收尾并停用，才能切回单兵。'),
        (error||state?.error)&&h('p',{role:'alert',className:'ctf-error'},error||state.error),
        h('button',{type:'button',disabled:busy,onClick:load},'刷新状态')));
  }
  function Settings({remote}){
    const [saved,setSaved]=React.useState(null),[value,setValue]=React.useState('auto'),[busy,setBusy]=React.useState(false),[message,setMessage]=React.useState('');
    React.useEffect(()=>{let mounted=true;call(remote,'defaults',{}).then(v=>{if(mounted){setSaved(v.defaultPreference);setValue(v.defaultPreference);}}).catch(e=>{if(mounted)setMessage(e.message);});return ()=>{mounted=false;};},[remote]);
    async function save(){setBusy(true);setMessage('');try{const v=await call(remote,'saveDefaults',{defaultPreference:value,expected_preference:saved});setSaved(v.defaultPreference);setMessage('已保存，将用于之后启动的 CTF 会话。');}catch(e){setMessage(e.message);}finally{setBusy(false);}}
    return h('section',{className:'ctf-settings'},h('h2',null,'CTF 模式'),
      h('p',null,'在「Agent 预设 → 自定义」选择 CTF 模式，或在新会话的预设菜单选择。已有会话保留原预设。'),
      h('label',null,'新 CTF 会话的默认偏好',h('select',{value,disabled:saved===null||busy,onChange:e=>setValue(e.target.value)},...Object.entries(labels).map(([key,label])=>h('option',{key,value:key},label)))),
      h('p',null,'自动判断由 Agent 按任务选择单兵或编排。优先选项表达偏好，Agent 可根据任务说明调整；显式锁定的启动配置仍生效。'),
      h('button',{type:'button',disabled:busy||saved===null||value===saved,onClick:save},busy?'保存中…':'保存默认偏好'),
      h('p',{'aria-live':'polite'},message),
      h('p',null,'会话标题旁的 CTF 入口显示实际模式、Hook 与知识材料状态。只有空闲时才能切换；修改默认偏好不改变已有会话。'));
  }
  const fields={status:['session_id'],change:['session_id','action','value','expected_revision'],defaults:[],saveDefaults:['defaultPreference','expected_preference']};
  const codec=(method,result=false)=>({mode:'strict',typeSymbol:'ctfUi/'+method+(result?'/result':'/request'),schema:{parse(value){
    if(!value||typeof value!=='object'||Array.isArray(value))throw Error('Invalid CTF response or request');
    if(result){if(['status','change'].includes(method)?typeof value.live!=='boolean':!Object.hasOwn(labels,value.defaultPreference))throw Error('Invalid CTF response');}
    else{
      if(Object.keys(value).some(k=>!fields[method].includes(k))||fields[method].some(k=>!Object.hasOwn(value,k)))throw Error('Invalid CTF request fields');
      if(['status','change'].includes(method)&&(typeof value.session_id!=='string'||!value.session_id||value.session_id.length>200))throw Error('Invalid CTF session');
      if(method==='change'&&(!['preference','route'].includes(value.action)||!Object.hasOwn(labels,value.value)||value.action==='route'&&value.value==='auto'||!Number.isSafeInteger(value.expected_revision)||value.expected_revision<0))throw Error('Invalid CTF change');
      if(method==='saveDefaults'&&(!Object.hasOwn(labels,value.defaultPreference)||!Object.hasOwn(labels,value.expected_preference)))throw Error('Invalid CTF defaults');
    }
    return value;
  }}});
  const contribution={package:'dsh-ctf-ui',descriptors:Object.keys(fields).map(method=>({id:'dsh-ctf-ui#ctfUi/'+method,service:'ctfUi',namespace:'ctfUi',method,invocation:{kind:'direct'},parameters:[{name:'request',wire:'request',source:'json',codec:codec(method)}],result:codec(method,true)}))};
  async function apply(ctx){
    const dispose=await ctx.remote.$mount(contribution);ctx.effect(()=>dispose,'ctf-ui: native Remote descriptors');
    ctx.effect(()=>{const el=document.createElement('style');el.textContent=style;document.head.append(el);return ()=>el.remove();},'ctf-ui: scoped styles');
    ctx.inject(['remote.ctfUi'],scope=>{
      scope.slots.inject('conversation.session.header.actions',()=>scope.slots.register({name:'conversation.session.header.actions',id:'ctf-mode',order:-5,inject:()=>({remote:scope.remote})},Header));
      scope.slots.inject('settings.section',()=>scope.slots.register({name:'settings.section',id:'ctf-mode',order:21,label:()=> 'CTF 模式',inject:()=>({remote:scope.remote})},Settings));
    });
  }
  return {inject:['slots','remote'],apply};
}});
