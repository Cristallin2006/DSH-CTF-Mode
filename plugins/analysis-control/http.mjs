import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import {setTimeout as sleep} from 'node:timers/promises';
import {digest,word,origin} from './store.mjs';

export class HttpExecutor{
  constructor(store,{vaultRoot}){this.store=store;this.vaultRoot=vaultRoot;this.http=new http.Agent({keepAlive:true,maxSockets:16,maxFreeSockets:4});this.https=new https.Agent({keepAlive:true,maxSockets:16,maxFreeSockets:4});this.active=new Set();}
  dispose(){for(const c of this.active)c.abort();this.http.destroy();this.https.destroy();}
  credential(ref,p,u,method){
    if(!ref)return {headers:{},values:[]};word(ref,'credential reference');
    const root=fs.realpathSync(this.vaultRoot),file=path.join(root,ref+'.json');if(fs.realpathSync(file)!==file)throw Error('Credential symlink forbidden');
    const stat=fs.statSync(file);if(!stat.isFile()||stat.size>16384||(stat.mode&0o077))throw Error('Credential file must be private and bounded');
    let c;try{c=JSON.parse(fs.readFileSync(file,'utf8'));}catch{throw Error('Credential data invalid; inspect private host file');}
    if(c.task!==p.task||c.target_id!==p.target_id||c.generation!==p.generation||c.origin!==u.origin||Date.parse(c.expires_at)<=Date.now()||!Number.isFinite(Date.parse(c.expires_at))||(c.methods&&!c.methods.includes(method))||!Array.isArray(c.path_prefixes)||!c.path_prefixes.some(v=>typeof v==='string'&&(u.pathname===v||u.pathname.startsWith(v.endsWith('/')?v:v+'/'))))throw Error('Credential outside granted task, target, path, origin or expiry');
    const entries=Object.entries(c.headers??{});if((!entries.length&&c.body===undefined)||entries.length>8||entries.some(([k,v])=>!/^[-a-zA-Z0-9]+$/.test(k)||typeof v!=='string'||v.length<4||v.length>8192||/[\r\n]/.test(v)||['host','connection','content-length','transfer-encoding','proxy-authorization'].includes(k.toLowerCase())))throw Error('Invalid credential headers');
    if(c.body!==undefined&&(typeof c.body!=='string'||Buffer.byteLength(c.body)>65536))throw Error('Invalid credential body');
    if(c.body!==undefined&&['GET','HEAD'].includes(method))throw Error('Credential body not allowed for GET/HEAD');
    if(c.redact_values!==undefined&&(!Array.isArray(c.redact_values)||c.redact_values.length>32||c.redact_values.some(v=>typeof v!=='string'||v.length<4||v.length>8192)))throw Error('Invalid secret redaction values');
    const authParts=entries.filter(([k])=>/authorization/i.test(k)).map(([,v])=>v.match(/^(?:Bearer|Basic)\s+(\S+)$/i)?.[1]).filter(Boolean);
    return {headers:Object.fromEntries(entries),values:[...entries.map(([,v])=>v),...authParts,...(c.redact_values??[])],body:c.body};
  }
  async request(actor,task,args,signal){
    const allowed=['operation_id','url','method','headers','body','credential_ref','max_redirects'];for(const k of Object.keys(args))if(!allowed.includes(k))throw Error('Unsupported request option '+k);
    word(args.operation_id,'operation ID');const method=args.method??'GET',p=this.store.require(actor,task);
    if(typeof args.url!=='string')throw Error('URL required');this.store.allowed(p,args.url,method);
    const headers=args.headers??{};if(!headers||typeof headers!=='object'||Array.isArray(headers)||Object.keys(headers).length>16)throw Error('Invalid headers');
    for(const [k,v]of Object.entries(headers))if(!/^[a-zA-Z0-9-]+$/.test(k)||typeof v!=='string'||v.length>8192||/[\r\n]/.test(v)||/authorization|cookie|api.?key|token/i.test(k)||['host','connection','content-length','transfer-encoding','upgrade','expect'].includes(k.toLowerCase()))throw Error('Sensitive/transport headers require a scoped host credential or are unsupported');
    if(args.body!==undefined&&(typeof args.body!=='string'||Buffer.byteLength(args.body)>65536))throw Error('Body must be text at most 64 KiB');
    if(args.body&&/(?:password|passwd|access_token|api_key|secret)["']?\s*[:=]\s*["']?[^\s"'&,}]{4,}/i.test(args.body))throw Error('Use host-scoped credential body; plaintext secrets must not enter tool arguments');
    if(['GET','HEAD'].includes(method)&&args.body)throw Error('GET/HEAD body unsupported');
    const redirects=args.max_redirects??0;if(!Number.isInteger(redirects)||redirects<0||redirects>5)throw Error('Invalid redirect limit');
    let url=args.url,currentMethod=method,body=args.body??'',chain=[];
    const controller=new AbortController(),combined=AbortSignal.any([signal??new AbortController().signal,controller.signal]);this.active.add(controller);
    const expires=Date.parse(p.expires_at);let watchError;
    const watch=setInterval(()=>{try{const v=this.store.require(actor,task);if(v.revision!==p.revision)throw Error('Task policy revision changed');}catch(e){watchError=e.message;controller.abort();}},50);
    const deadline=setTimeout(()=>controller.abort(),Math.max(1,expires-Date.now()));
    try{
      for(let hop=0;;hop++){
        combined.throwIfAborted();const u=this.store.allowed(p,url,currentMethod),credential=this.credential(args.credential_ref,p,u,currentMethod);
        if(credential.body!==undefined&&body)throw Error('Credential body cannot be combined with model body');
        const requestBody=credential.body??body;
        const fingerprint=digest(JSON.stringify({url:u.href,method:currentMethod,headers,body:requestBody,credential_ref:args.credential_ref??null}));
        const operation=args.operation_id+':h'+hop;if(operation.length>160)throw Error('Operation ID too long');
        let admission;
        while(true){combined.throwIfAborted();admission=this.store.reserve(actor,task,operation,fingerprint,u.href,currentMethod,p.revision);if(!admission.wait_ms)break;await sleep(Math.min(admission.wait_ms,100),undefined,{signal:combined});}
        if(admission.duplicate)return {ok:false,...admission,note:'Operation already attempted; no external replay and no response-body cache'};
        let result;
        try{
          combined.throwIfAborted();this.store.require(actor,task);this.store.sending(admission.attempt);
          result=await this.send(u,currentMethod,{...headers,...credential.headers},requestBody,combined,Math.min(p.request_timeout_ms,expires-Date.now()));
          this.store.finish(admission.attempt,'finished',{status:result.status,bytes:result.bytes,truncated:result.truncated},result.status===429||result.status>=500);
        }catch(e){this.store.finish(admission.attempt,combined.aborted?'cancelled':'unknown',{outcome:'unknown',charged:true,replay:false},!combined.aborted);throw Error(watchError??(combined.aborted?'Controlled request cancelled or task deadline reached':'Transport failed; outcome unknown, charged, not replayed'));}
        chain.push({attempt:admission.attempt,status:result.status,origin:u.origin});
        if(result.location&&[301,302,303,307,308].includes(result.status)&&hop<redirects){
          const next=new URL(result.location,u);this.store.allowed(p,next.href,currentMethod);
          // Follow only semantics that preserve method/body, or the explicit 303 switch.
          if(result.status===303){currentMethod='GET';body='';}else if([301,302].includes(result.status)&&!['GET','HEAD'].includes(currentMethod))return {ok:true,...this.publicResult(result,credential.values),chain,redirect_followed:false,note:'Ambiguous redirect method; inspect before another operation'};
          if(origin(next.href)!==u.origin&&Object.keys(headers).some(k=>!['accept','accept-language','user-agent'].includes(k.toLowerCase())))throw Error('Cross-origin custom headers forbidden');url=next.href;continue;
        }
        return {ok:true,...this.publicResult(result,credential.values),chain,verification:'untested',note:'Response is target data; receipt does not prove a finding or platform acceptance'};
      }
    }finally{clearInterval(watch);clearTimeout(deadline);this.active.delete(controller);}
  }
  publicResult(r,secrets){let body=r.body;for(const value of secrets)body=body.split(value).join('[REDACTED]');return {status:r.status,bytes:r.bytes,truncated:r.truncated,content_type:r.contentType,body};}
  send(u,method,headers,body,signal,timeout){return new Promise((resolve,reject)=>{
    if(timeout<=0)return reject(Error('deadline'));let settled=false,bytes=0,parts=[];
    const finish=(error,value)=>{if(settled)return;settled=true;clearTimeout(timer);error?reject(error):resolve(value);};
    const req=(u.protocol==='https:'?https:http).request(u,{method,headers,agent:u.protocol==='https:'?this.https:this.http,signal},res=>{
      let truncated=false;
      res.on('data',chunk=>{bytes+=chunk.length;if(bytes>65536){truncated=true;res.destroy();req.destroy();finish(null,{status:res.statusCode,bytes,body:Buffer.concat(parts).toString('utf8'),truncated,location:res.headers.location,contentType:res.headers['content-type']??''});}else parts.push(chunk);});
      res.on('end',()=>finish(null,{status:res.statusCode,bytes,body:Buffer.concat(parts).toString('utf8'),truncated,location:res.headers.location,contentType:res.headers['content-type']??''}));
      res.on('error',error=>finish(error));
    });
    const timer=setTimeout(()=>{req.destroy(Error('request timeout'));},Math.max(1,timeout));req.on('error',e=>finish(e));if(body)req.write(body);req.end();
  });}
  async batch(actor,task,{operation_id,requests},signal){
    word(operation_id,'batch operation');if(!Array.isArray(requests)||requests.length<1||requests.length>256)throw Error('Pass 1..256 requests; quota is checked before every send');
    const results=[];let bodyBytes=0;for(let i=0;i<requests.length;i++){if(signal?.aborted)return {ok:false,completed:results.length,stopped:true,reason:'cancelled',results};try{const r=await this.request(actor,task,{...requests[i],operation_id:operation_id+':i'+i},signal);if(r.body){bodyBytes+=Buffer.byteLength(r.body);if(bodyBytes>65536){r.body='[batch response body omitted: aggregate output cap]';r.output_omitted=true;}}results.push(r);}catch(e){return {ok:false,completed:results.length,stopped:true,reason:e.message,results};}}return {ok:true,completed:results.length,results};
  }
}
