/** Optional offline RE workbench delivery in native DSH; no HTTP or external model calls. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {execFileSync} from 'node:child_process';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {expandWork} from './native-client.mjs';
const base=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),source=process.env.DSH_RE_LAB_SKILL_ROOT??base,native=process.env.DSH_NATIVE_PACKAGE_ROOT,req=createRequire(native+'/package.json');
const fixture=fs.mkdtempSync(path.join(os.tmpdir(),'dsh-re-lab-materials-')),home=fixture+'/home',state=home+'/analysis-state',workspace=fixture+'/work';
for(const p of [workspace,home+'/skills'])fs.mkdirSync(p,{recursive:true});for(const name of ['re-dynamic','ctf-misc'])fs.cpSync(source+'/skills/'+name,home+'/skills/'+name,{recursive:true});fs.cpSync(base+'/runtime',home+'/runtime',{recursive:true});fs.writeFileSync(fixture+'/cordis.yml','[]');fs.writeFileSync(fixture+'/hooks.json','{"hooks":{}}');
const env={PATH:process.env.PATH,HOME:os.homedir(),LANG:'C.UTF-8',DSH_HOME:home,DSH_ANALYSIS_STATE:state};execFileSync('python3',[home+'/runtime/analysis-v1/session.py','health'],{env});
for(const key of Object.keys(process.env))if(!['PATH','HOME','LANG','SYSTEMROOT','TMPDIR','TMP','TEMP','DSH_NATIVE_PACKAGE_ROOT'].includes(key))delete process.env[key];Object.assign(process.env,env);
const {boot,loadOverlayPatches}=await import(pathToFileURL(req.resolve('@deepseek-ai/dsh-app-boot'))),{LlmAdapter}=await import(pathToFileURL(req.resolve('@deepseek-ai/dsh-llm')));
const groups=[[{name:'re-dynamic',references:[]}],[{name:'re-dynamic',references:['references/re-workbench.md']}]];
let ctx,handle,localError,childCalls=0;const receipts=[];
function* emit(text){yield {type:'block-start',index:0,blockType:'text'};yield {type:'text-delta',index:0,text};yield {type:'block-end',index:0,block:{type:'text',text}};yield {type:'finish',reason:{kind:'stop'}};}
class Local extends LlmAdapter{
 async *stream(o){try{
  const blocks=o.messages.flatMap(m=>m.content),assignment=blocks.find(b=>b.type==='text'&&b.text.startsWith('{"task"'));
  if(assignment){childCalls++;const d=JSON.parse(assignment.text),group=groups[Number(d.question)],texts=blocks.filter(b=>b.type==='text').map(b=>b.text),current=texts.filter(t=>t.startsWith('Current runtime context')).at(-1);assert(group&&current);
   assert(texts.some(t=>t.includes('<available_skills>')&&t.includes('ctf-misc')));assert(!(o.tools??[]).some(t=>['bash','dsh_knowledge','windows_debug'].includes(t.name)));
   for(const skill of group){const directory=home+'/skills/'+skill.name,body=fs.readFileSync(directory+'/SKILL.md','utf8').replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/,'').trim();assert(current.includes(body));const policy=fs.existsSync(directory+'/skill-materials.json')?JSON.parse(fs.readFileSync(directory+'/skill-materials.json','utf8')).required_references:[];for(const ref of new Set([...policy,...skill.references]))assert(current.includes(fs.readFileSync(directory+'/'+ref,'utf8')));}
   if(d.question==='0')assert(!current.includes(fs.readFileSync(home+'/skills/re-dynamic/references/re-workbench.md','utf8')),'Workbench reference must remain optional');
  }
  yield* emit('Synthetic full material and permissions check, not solving quality');
 }catch(e){localError=e;throw e;}}
}
try{
 const patches=[...loadOverlayPatches('re-lab-materials',native+'/node_modules/@deepseek-ai/dsh-base/cordis.patch.yml'),{id:'session-title-llm',disabled:true},{id:'session-telemetry-otel',disabled:true},{insert:[{id:'state',name:pathToFileURL(base+'/plugins/analysis-hooks-sandbox/index.mjs').href,config:{dshHome:home,pluginRoot:base+'/dsh-hooks',configPath:fixture+'/hooks.json',selfTest:false}},{id:'memory',name:pathToFileURL(source+'/plugins/analysis-memory/index.mjs').href,config:{enabled:true,stateRoot:state}},{id:'orchestration',name:pathToFileURL(base+'/plugins/analysis-orchestration/index.mjs').href,config:{enabled:true,stateRoot:state,tickMs:30}}]}];
 ctx=await boot('re-lab-materials',fixture+'/cordis.yml',patches,undefined,pathToFileURL(native+'/').href);ctx.llm.registerAdapter(['re-lab-local'],new Local());handle=await ctx.agents.create({sessionId:'re-lab-materials-'+randomUUID(),meta:{cwd:workspace},agentOptions:{provider:'re-lab-local',model:'local'}});await handle.agent.whenIdle();
 const call=async(name,args)=>{const result=await ctx.tools.execute({name,callId:randomUUID(),agent:handle.agent,arguments:args,signal:new AbortController().signal});assert(!result.isError,JSON.stringify(result));return expandWork(call,args.task,JSON.parse(result.content.filter(b=>b.type==='text').map(b=>b.text).join('')));};
 const task=(await call('analysis_session',{action:'init',options:{goal:'Synthetic RE workbench knowledge delivery'}})).result.id;await call('dsh_memory_write',{action:'open',task});const orch=(action,options={})=>call('dsh_orchestration',{action,task,options});await orch('enable');
 const nav=await call('dsh_knowledge',{action:'search',task,options:{query:'passive reverse workbench',kind:'reference'}});assert(nav.items.some(v=>v.id==='re-workbench'));
 for(let i=0;i<groups.length;i++){
  const w=await orch('add',{key:'web-'+i,question:String(i),success:'Verify delivery only',execution_plan:{kind:'materials',requirements:[]},skill_plan:{required:groups[i].map(s=>({...s,reason:'Synthetic selected material check'}))}});await orch('dispatch',{work:[w.id]});let r;
  for(let j=0;j<300;j++){r=await orch('result',{work:w.id,view:'detail'});if(['returned','failed'].includes(r.state))break;await new Promise(done=>setTimeout(done,20));}
  if(localError)throw localError;assert.equal(r.state,'returned',JSON.stringify(r));assert.equal(r.skill_delivery.state,'delivered');assert(r.skill_delivery.bytes<=65536);receipts.push({group:i,bytes:r.skill_delivery.bytes,coverage:r.skill_delivery.coverage});await orch('review',{work:w.id,decision:'adopted',reason:'Visibility and boundaries only'});
 }
 await orch('disable',{reason:'Synthetic material acceptance complete'});assert.equal(childCalls,2);
}finally{if(handle)await handle.dispose();if(ctx)await ctx.fiber.dispose();}
const report={ok:true,source,receipts,fixture,externalModelCalls:0,externalTargetRequests:0,fullTeardownCompleted:true,limitation:'Optional reference delivery and permissions only; no device/backend execution or solving-quality claim'};fs.mkdirSync(base+'/.test-results',{recursive:true});fs.writeFileSync(base+'/.test-results/re-lab-materials-native.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
