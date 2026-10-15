#!/usr/bin/env node
// Host/operator entrypoint, never registered as a model tool.
import fs from 'node:fs';
import path from 'node:path';
import {ControlStore,word} from './store.mjs';
const [action,state,fileOrTask,revision]=process.argv.slice(2);let store;
try{
  if(!state)throw Error('Usage: admin.mjs issue STATE POLICY_JSON | revoke STATE TASK REVISION | recover STATE TASK');
  store=new ControlStore(state);let result;
  if(action==='issue')result=store.issue(JSON.parse(fs.readFileSync(fileOrTask,'utf8')));
  else if(action==='revoke')result=store.revoke(fileOrTask,Number(revision));
  else if(action==='recover')result=store.recover(fileOrTask);
  else if(action==='credential'){
    const file=fs.realpathSync(fileOrTask),st=fs.statSync(file);if(!st.isFile()||st.size>16384||(st.mode&0o077))throw Error('Private bounded source file required');
    const c=JSON.parse(fs.readFileSync(file,'utf8'));word(c.id,'credential ID');const p=store.policy(c.task);store.validate(p);
    if(c.target_id!==p.target_id||c.generation!==p.generation||!p.origins.includes(c.origin)||!Number.isFinite(Date.parse(c.expires_at))||Date.parse(c.expires_at)<=Date.now()||Date.parse(c.expires_at)>Date.parse(p.expires_at))throw Error('Credential scope/expiry outside host grant');
    if(!Array.isArray(c.path_prefixes)||!c.path_prefixes.length||c.path_prefixes.some(v=>typeof v!=='string'||!v.startsWith('/')||/[?#]/.test(v)))throw Error('Explicit credential paths required');
    const vault=path.resolve(revision??path.join(state,'..','control-vault'));fs.mkdirSync(vault,{recursive:true,mode:0o700});const dest=path.join(fs.realpathSync(vault),c.id+'.json');fs.writeFileSync(dest,JSON.stringify(c),{mode:0o600,flag:'wx'});result={credential_ref:c.id,stored:true,task:c.task};
  }
  else if(action==='credential-revoke'){word(fileOrTask,'credential ID');const vault=fs.realpathSync(revision??path.join(state,'..','control-vault'));fs.unlinkSync(path.join(vault,fileOrTask+'.json'));result={credential_ref:fileOrTask,revoked:true};}
  else throw Error('Unsupported operator action');
  console.log(JSON.stringify({ok:true,result}));
}catch(e){console.error(JSON.stringify({ok:false,error:action==='credential'?'Credential import failed; check private JSON, scope, expiry, permissions and existing ID':e.message}));process.exitCode=1;}finally{store?.close();}
