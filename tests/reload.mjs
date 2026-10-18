import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
fs.mkdirSync(new URL('../.test-results/',import.meta.url),{recursive:true});
const base=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),installed=process.argv.includes('--installed'),native=process.env.DSH_NATIVE_PACKAGE_ROOT,req=createRequire(native+'/package.json');
const fixture=fs.mkdtempSync(path.join(os.tmpdir(),'dsh-reload-regression-')),home=fixture+'/home',state=home+'/analysis-state';fs.mkdirSync(state,{recursive:true,mode:0o700});fs.writeFileSync(fixture+'/cordis.yml','[]\n');process.env.DSH_HOME=home;
const db=new DatabaseSync(state+'/state.sqlite3');db.exec('CREATE TABLE tasks(id TEXT,data TEXT);CREATE TABLE sessions(id TEXT,task TEXT);CREATE TABLE targets(task TEXT,id TEXT,generation INTEGER,data TEXT);CREATE TABLE mem_owners(task TEXT,actor TEXT);');db.close();
const {boot,loadOverlayPatches}=await import(pathToFileURL(req.resolve('@deepseek-ai/dsh-app-boot')).href),{LlmAdapter,createUserMessage}=await import(pathToFileURL(req.resolve('@deepseek-ai/dsh-llm')).href);
let calls=0;
class Local extends LlmAdapter{async *stream(o){calls++;await new Promise((resolve,reject)=>{if(o.signal.aborted)return reject(Error('cancelled'));o.signal.addEventListener('abort',()=>reject(Error('cancelled')),{once:true});});}}
const plugin=await import(pathToFileURL(base+'/plugins/analysis-orchestration/index.mjs').href);let ctx,handle,fiber;
try{
 ctx=await boot('reload-regression',fixture+'/cordis.yml',[...loadOverlayPatches('reload-regression',native+'/node_modules/@deepseek-ai/dsh-base/cordis.patch.yml'),{id:'session-title-llm',disabled:true},{id:'session-telemetry-otel',disabled:true}],undefined,pathToFileURL(native+'/').href);ctx.llm.registerAdapter(['reload-local'],new Local());
 handle=await ctx.agents.create({sessionId:'reload-main-'+randomUUID(),meta:{cwd:fixture},agentOptions:{provider:'reload-local',model:'local'}});await handle.agent.whenIdle();
 for(let round=0;round<3;round++){
  fiber=ctx.plugin(plugin,{enabled:true,stateRoot:state,tickMs:20});
  handle.agent.followup(createUserMessage({content:[{type:'text',text:'Local synthetic cancellation during plugin reload'}],source:{kind:'user'}}));
  for(let i=0;i<100&&calls<=round;i++)await new Promise(r=>setTimeout(r,10));assert.equal(calls,round+1);
  await fiber.dispose();fiber=null;handle.agent.cancel({kind:'user'});await handle.agent.whenIdle();await new Promise(r=>setTimeout(r,25));
 }
 const result={ok:true,installed,rounds:3,externalModelCalls:0,externalTargetRequests:0,checks:['real native parent turn stays alive across plugin unload, then cancels without closed-database access','three actual Cordis unload/reload cycles do not leave fatal AbortSignal callbacks'],fixture};fs.writeFileSync(base+'/.test-results/'+(installed?'installed-reload':'reload')+'.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}finally{if(fiber)await fiber.dispose();if(handle)await handle.dispose();if(ctx)await ctx.fiber.dispose();}
