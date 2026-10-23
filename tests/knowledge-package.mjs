/** Validate actual professional cards; --native measures real assembled delivery. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {execFileSync} from 'node:child_process';
import {referencePolicy,readMaterial} from '../plugins/analysis-orchestration/reference-policy.mjs';
import {expandWork} from './native-client.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const skillRoot=process.env.DSH_KNOWLEDGE_SKILL_ROOT??root+'/skills';
const names=['ghidra-static','ctf-crypto','ctf-web','pwn-exploit'];
const hash=data=>createHash('sha256').update(data).digest('hex');
const manifest=JSON.parse(fs.readFileSync(root+'/tools/install-manifest.json','utf8'));
const staticChecks=[];
for(const name of names){
  const directory=skillRoot+'/'+name,policy=await referencePolicy({name,resourceBase:{kind:'directory',path:directory}},[]);
  assert.equal(policy.policy.state,'declared');assert.equal(policy.required.length,1);
  const body=fs.readFileSync(directory+'/SKILL.md','utf8');
  for(const ref of policy.required){
    const material=await readMaterial(directory,ref);
    assert(body.includes(ref),'Core reference must be discoverable in the main skill');
    assert(manifest.includes('skills/'+name+'/'+ref));assert(manifest.includes('skills/'+name+'/skill-materials.json'));
    for(const match of material.content.matchAll(/\]\(([^\s)]+)\)/g)){
      const target=match[1].split('#')[0];if(!target||target.includes(':'))continue;
      assert(fs.statSync(path.resolve(directory,path.dirname(ref),target)).isFile(),'Missing local route: '+target);
    }
    staticChecks.push({name,reference:ref,bytes:material.bytes,sha256:material.sha256});
  }
}
if(!process.argv.includes('--native')){
  console.log(JSON.stringify({ok:true,staticChecks,native:false,limitation:'File/policy checks only; native assembly bytes are not measured',externalModelCalls:0}));
}else{
  const native=process.env.DSH_NATIVE_PACKAGE_ROOT;assert(native,'Set DSH_NATIVE_PACKAGE_ROOT');
  const req=createRequire(native+'/package.json');
  const fixture=fs.mkdtempSync(path.join(os.tmpdir(),'dsh-knowledge-native-')),home=fixture+'/home',state=home+'/analysis-state',workspace=fixture+'/work';
  fs.mkdirSync(workspace);
  fs.mkdirSync(home+'/skills',{recursive:true});
  for(const name of [...names,'ctf-misc'])fs.cpSync(skillRoot+'/'+name,home+'/skills/'+name,{recursive:true});
  fs.cpSync(root+'/runtime',home+'/runtime',{recursive:true});
  fs.writeFileSync(fixture+'/cordis.yml','[]');fs.writeFileSync(fixture+'/hooks.json','{"hooks":{}}');
  // Whitelist test environment: no personal provider/profile or model credentials copied.
  const env={PATH:process.env.PATH,HOME:os.homedir(),LANG:'C.UTF-8',DSH_HOME:home,DSH_ANALYSIS_STATE:state,DSH_NATIVE_PACKAGE_ROOT:native};
  execFileSync('python3',[home+'/runtime/analysis-v1/session.py','health'],{env});
  for(const key of Object.keys(process.env))if(!['PATH','HOME','LANG','SYSTEMROOT','TMPDIR','TMP','TEMP','DSH_NATIVE_PACKAGE_ROOT'].includes(key))delete process.env[key];
  process.env.DSH_HOME=home;process.env.DSH_ANALYSIS_STATE=state;
  const {boot,loadOverlayPatches}=await import(pathToFileURL(req.resolve('@deepseek-ai/dsh-app-boot')));
  const {LlmAdapter}=await import(pathToFileURL(req.resolve('@deepseek-ai/dsh-llm')));
  const specs=new Map(),phases=new Map(),measurements=[];let ctx,handle,skillCalls=0,localError;
  function* emit(block,kind='stop'){yield {type:'block-start',index:0,blockType:block.type};if(block.type==='text')yield {type:'text-delta',index:0,text:block.text};else yield {type:'tool-call-delta',index:0,id:block.id,name:block.name,argumentsDelta:block.arguments};yield {type:'block-end',index:0,block};yield {type:'finish',reason:{kind}};}
  class Local extends LlmAdapter{
    async *stream(o){try{
      const blocks=o.messages.flatMap(m=>m.content),assignment=blocks.find(b=>b.type==='text'&&b.text.startsWith('{"task"'));
      if(!assignment){yield* emit({type:'text',text:'Synthetic coordinator event'});return;}
      const d=JSON.parse(assignment.text),spec=specs.get(d.question);assert(spec,'Unknown fixture assignment');
      const texts=blocks.filter(b=>b.type==='text').map(b=>b.text),current=texts.filter(t=>t.startsWith('Current runtime context')).at(-1)??'';
      const tools=(o.tools??[]).map(t=>t.name);assert(!tools.includes('bash')&&!tools.includes('dsh_memory_write'));
      for(const item of spec){
        const body=fs.readFileSync(home+'/skills/'+item.name+'/SKILL.md','utf8').replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/,'').trim();
        assert(current.includes(body),'Complete professional body missing: '+item.name);
        const policy=JSON.parse(fs.readFileSync(home+'/skills/'+item.name+'/skill-materials.json','utf8'));
        for(const ref of new Set([...policy.required_references,...item.references]))assert(current.includes(fs.readFileSync(home+'/skills/'+item.name+'/'+ref,'utf8')));
      }
      const optional=fs.readFileSync(home+'/skills/ghidra-static/references/data-driven-recovery.md','utf8');
      if(!spec.some(s=>s.references.includes('references/data-driven-recovery.md')))assert(!current.includes(optional));
      assert(texts.filter(t=>t.includes('<available_skills>')).join('\n').includes('ctf-misc'));
      if(d.question==='ondemand'){
        const phase=phases.get(d.work)??0;phases.set(d.work,phase+1);
        if(phase===0){yield* emit({type:'tool-call',id:randomUUID(),name:'skill',arguments:JSON.stringify({name:'ctf-misc'})},'tool-calls');return;}
        const last=blocks.filter(b=>b.type==='tool-result').at(-1);assert(last&&!last.isError);
        assert(JSON.stringify(last).includes('ctf-misc'));
      }
      yield* emit({type:'text',text:'Synthetic admission check; understanding and application are not evaluated'});
    }catch(error){localError=error;throw error;}}
  }
  try{
    const patches=[...loadOverlayPatches('knowledge',native+'/node_modules/@deepseek-ai/dsh-base/cordis.patch.yml'),{id:'session-title-llm',disabled:true},{id:'session-telemetry-otel',disabled:true},{insert:[
      {id:'state',name:pathToFileURL(root+'/plugins/analysis-hooks-sandbox/index.mjs').href,config:{dshHome:home,pluginRoot:root+'/dsh-hooks',configPath:fixture+'/hooks.json',selfTest:false}},
      {id:'memory',name:pathToFileURL(root+'/plugins/analysis-memory/index.mjs').href,config:{enabled:true,stateRoot:state}},
      {id:'orchestration',name:pathToFileURL(root+'/plugins/analysis-orchestration/index.mjs').href,config:{enabled:true,stateRoot:state,tickMs:30}}
    ]}];
    ctx=await boot('knowledge',fixture+'/cordis.yml',patches,undefined,pathToFileURL(native+'/').href);ctx.llm.registerAdapter(['knowledge-local'],new Local());
    ctx.on('tools/execute',(exec,next)=>{if(exec.name==='skill')skillCalls++;return next();});
    handle=await ctx.agents.create({sessionId:'knowledge-'+randomUUID(),meta:{cwd:workspace},agentOptions:{provider:'knowledge-local',model:'local'}});await handle.agent.whenIdle();
    const call=async(name,args)=>{const v=await ctx.tools.execute({name,callId:randomUUID(),agent:handle.agent,arguments:args,signal:new AbortController().signal});assert(!v.isError,JSON.stringify(v));return expandWork(call,args.task,JSON.parse(v.content.filter(b=>b.type==='text').map(b=>b.text).join('')));};
    const task=(await call('analysis_session',{action:'init',options:{goal:'Verify real professional material delivery only'}})).result.id;
    await call('dsh_memory_write',{action:'open',task});const orch=(action,options={})=>call('dsh_orchestration',{action,task,options});await orch('enable');
    const wait=async(id,rev=1)=>{for(let i=0;i<300;i++){const w=await orch('result',{work:id,view:'detail'});if(w.state==='failed')throw localError??Error(JSON.stringify(w));if(w.state==='returned'&&w.result_revision>=rev)return w;await new Promise(r=>setTimeout(r,20));}throw localError??Error('Fixture did not settle');};
    const select=name=>({name,references:[]});
    const groups=[...names.map(name=>[select(name)]),[{name:'ghidra-static',references:['references/data-driven-recovery.md']},select('ctf-crypto')],[select('ctf-web'),select('pwn-exploit')],names.map(select)];
    let first;
    for(let i=0;i<groups.length;i++){
      const spec=groups[i],question='bundle-'+i;specs.set(question,spec);
      const w=await orch('add',{key:question,question,success:'Verify visible materials; no solving claim',execution_plan:{kind:'materials',requirements:[]},skill_plan:{required:spec.map(s=>({...s,reason:'Synthetic professional package check'}))}});
      await orch('dispatch',{work:[w.id]});const result=await wait(w.id);assert.equal(result.skill_delivery.state,'delivered');
      assert(result.skill_delivery.bytes<=65536);assert.equal(result.skill_delivery.coverage.policy_references,spec.length);
      measurements.push({question,skills:spec.map(s=>s.name),bytes:result.skill_delivery.bytes,coverage:result.skill_delivery.coverage});
      await orch('review',{work:w.id,decision:'adopted',reason:'Material visibility only'});if(i===0)first=result;
    }
    assert.equal(skillCalls,0,'Required material must not depend on a skill call');
    const core=home+'/skills/ghidra-static/references/core-evidence.md';fs.appendFileSync(core,'\nSynthetic changed-version receipt probe.\n');
    await orch('followup',{work:first.id,message:'Continue in the same child using current material versions'});const refreshed=await wait(first.id,2);
    assert.equal(refreshed.child,first.child);assert.notEqual(refreshed.skill_delivery.digest,first.skill_delivery.digest);
    const receipt=refreshed.skill_delivery.materials[0].references.find(r=>r.path==='references/core-evidence.md');assert.equal(receipt.sha256,hash(fs.readFileSync(core)));
    await orch('review',{work:first.id,decision:'adopted',reason:'Same-child refreshed material visible'});
    specs.set('ondemand',[select('ctf-web')]);const extra=await orch('add',{key:'ondemand',question:'ondemand',success:'Other skill remains callable',execution_plan:{kind:'materials',requirements:[]},skill_plan:{required:[{...select('ctf-web'),reason:'Synthetic selected method'}]}});
    await orch('dispatch',{work:[extra.id]});await wait(extra.id);assert.equal(skillCalls,1);await orch('disable',{reason:'Synthetic package acceptance finished'});
  }finally{if(handle)await handle.dispose();if(ctx)await ctx.fiber.dispose();}
  const report={ok:true,staticChecks,native:true,measurements,skillCalls,fixture,externalModelCalls:0,externalTargetRequests:0,fullTeardownCompleted:true,limitation:'Native admission and material costs only; not model understanding or solving quality'};
  fs.mkdirSync(root+'/.test-results',{recursive:true});fs.writeFileSync(root+'/.test-results/knowledge-package.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}
