import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {processIdentity} from '../analysis-memory/store.mjs';

const pack=JSON.stringify,id=()=>crypto.randomUUID(),digest=v=>crypto.createHash('sha256').update(v).digest('hex');
const integer=(v,min,max,name)=>{if(!Number.isInteger(v)||v<min||v>max)throw Error('Invalid '+name);return v;};
const word=(v,name)=>{if(typeof v!=='string'||!/^[a-zA-Z0-9_.:-]{1,160}$/.test(v))throw Error('Invalid '+name);return v;};
export function origin(value){const u=new URL(value);if(!['http:','https:'].includes(u.protocol)||u.username||u.password)throw Error('Only HTTP(S) without URL credentials supported');return u.origin;}
export class ControlStore{
  constructor(state){
    this.root=fs.realpathSync(state);this.pinPath=path.join(this.root,'control-pins.json');
    this.db=new DatabaseSync(path.join(this.root,'state.sqlite3'));this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000');
    for(const t of ['tasks','sessions','targets','events'])if(!this.q("SELECT name FROM sqlite_master WHERE type='table' AND name=?",t))throw Error('Existing analysis-state required');
    this.db.exec(`CREATE TABLE IF NOT EXISTS control_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS control_grants(task TEXT PRIMARY KEY,revision INTEGER NOT NULL,data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS control_pins(actor TEXT PRIMARY KEY,task TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS control_environments(id TEXT PRIMARY KEY,data TEXT NOT NULL,spent INTEGER NOT NULL,next_start REAL NOT NULL,failures INTEGER NOT NULL,paused_until REAL NOT NULL);
      CREATE TABLE IF NOT EXISTS control_attempts(id TEXT PRIMARY KEY,task TEXT NOT NULL,operation TEXT NOT NULL,fingerprint TEXT NOT NULL,environment TEXT NOT NULL,revision INTEGER NOT NULL,state TEXT NOT NULL,pid INTEGER NOT NULL,identity TEXT,created REAL NOT NULL,finished REAL,result TEXT,UNIQUE(task,operation));`);
    const version=this.q("SELECT value FROM control_meta WHERE key='schema'");if(version&&version.value!=='1.0')throw Error('Unsupported control schema');this.run("INSERT OR IGNORE INTO control_meta VALUES('schema','1.0')");
  }
  q(sql,...v){return this.db.prepare(sql).get(...v);}all(sql,...v){return this.db.prepare(sql).all(...v);}run(sql,...v){return this.db.prepare(sql).run(...v);}
  tx(fn){this.db.exec('BEGIN IMMEDIATE');try{const r=fn();this.db.exec('COMMIT');return r;}catch(e){this.db.exec('ROLLBACK');throw e;}}
  close(){this.db.close();}
  audit(task,kind,data){this.run('INSERT INTO events(key,ts,session,task,kind,data) VALUES(?,?,?,?,?,?)','control-'+id(),Date.now()/1000,'host-control',task,'control-'+kind,pack(data));}
  pins(){
    const value=readPins(this.pinPath);
    for(const row of this.all('SELECT actor,task FROM control_pins'))if(value[row.actor]!==row.task)throw Error('Control pin journal missing or inconsistent; repair required');
    return value;
  }
  pin(actor,task){
    word(actor,'session');word(task,'task');const pins=this.pins();if(pins[actor]&&pins[actor]!==task)throw Error('Managed session is permanently pinned; use a new session for another task');
    pins[actor]=task;const tmp=this.pinPath+'.'+id()+'.tmp';fs.writeFileSync(tmp,pack(pins),{mode:0o600});fs.renameSync(tmp,this.pinPath);
    this.run('INSERT INTO control_pins VALUES(?,?) ON CONFLICT(actor) DO UPDATE SET task=excluded.task',actor,task);
  }
  task(task){const r=this.q('SELECT data FROM tasks WHERE id=?',task);if(!r)throw Error('Task unavailable');return JSON.parse(r.data);}
  policy(task){const r=this.q('SELECT * FROM control_grants WHERE task=?',task);if(!r)throw Error('No host-issued network grant for task');return {...JSON.parse(r.data),revision:r.revision};}
  issue(input){
    if(!input||Object.getPrototypeOf(input)!==Object.prototype)throw Error('Policy object required');
    const expected=['task','target_id','generation','environment','origins','denied_hosts','methods','max_requests','environment_max_requests','max_inflight','min_interval_ms','expires_at','request_timeout_ms','failure_threshold','cooldown_ms','expected_revision'];
    for(const k of Object.keys(input))if(!expected.includes(k))throw Error('Unsupported policy field '+k);
    const p={...input,mode:'managed',revoked:false};word(p.task,'task');word(p.environment,'environment');word(p.target_id,'target');integer(p.generation,1,1e9,'generation');
    integer(p.max_requests,1,1000000,'task request limit');integer(p.environment_max_requests,1,1000000,'environment request limit');integer(p.max_inflight,1,16,'inflight limit');integer(p.min_interval_ms,0,3600000,'request interval');
    p.request_timeout_ms??=10000;p.failure_threshold??=3;p.cooldown_ms??=30000;
    integer(p.request_timeout_ms,100,60000,'request timeout');integer(p.failure_threshold,1,100,'failure threshold');integer(p.cooldown_ms,100,3600000,'cooldown');
    if(!Number.isFinite(Date.parse(p.expires_at))||Date.parse(p.expires_at)<=Date.now()||Date.parse(p.expires_at)>Date.now()+7*86400000)throw Error('Grant expiry must be within seven days');
    if(!Array.isArray(p.origins)||!p.origins.length||p.origins.length>40)throw Error('Explicit origins required');p.origins=[...new Set(p.origins.map(value=>{const u=new URL(value);if(u.href!==u.origin+'/'&&u.href!==u.origin)throw Error('Origin must not contain path/query');return origin(value);}))];
    p.denied_hosts??=[];if(!Array.isArray(p.denied_hosts)||p.denied_hosts.length>100)throw Error('Invalid denied hosts');p.denied_hosts=p.denied_hosts.map(h=>{if(typeof h!=='string'||/[:/\s]/.test(h))throw Error('Invalid denied host');return new URL('https://'+h).hostname.toLowerCase().replace(/\.$/,'');});
    if(!Array.isArray(p.methods)||!p.methods.length||p.methods.some(m=>!['GET','HEAD','POST','PUT','PATCH','DELETE','OPTIONS'].includes(m)))throw Error('Explicit HTTP methods required');
    return this.tx(()=>{
      const task=this.task(p.task);if(task.status!=='running')throw Error('Task is not running');this.generation(p);
      const creator=this.q("SELECT session FROM events WHERE task=? AND kind='task-created' ORDER BY id LIMIT 1",p.task)?.session;if(!creator)throw Error('Task creator unavailable');
      const old=this.q('SELECT revision,data FROM control_grants WHERE task=?',p.task);if((input.expected_revision??0)!==(old?.revision??0))throw Error('Policy revision conflict');
      if(old&&JSON.parse(old.data).environment!==p.environment)throw Error('Environment reassignment forbidden; create a new task');
      const envData={max_requests:p.environment_max_requests,max_inflight:p.max_inflight,min_interval_ms:p.min_interval_ms,failure_threshold:p.failure_threshold,cooldown_ms:p.cooldown_ms};
      const env=this.q('SELECT data FROM control_environments WHERE id=?',p.environment);
      if(env&&pack(JSON.parse(env.data))!==pack(envData))throw Error('Shared environment limits differ; no implicit budget reset or expansion');
      if(!env)this.run('INSERT INTO control_environments VALUES(?,?,0,0,0,0)',p.environment,pack(envData));
      delete p.expected_revision;const revision=(old?.revision??0)+1;this.pin(creator,p.task);
      this.run('INSERT INTO control_grants VALUES(?,?,?) ON CONFLICT(task) DO UPDATE SET revision=excluded.revision,data=excluded.data',p.task,revision,pack(p));
      this.audit(p.task,'grant',{revision,environment:p.environment,origins:p.origins,max_requests:p.max_requests});return {task:p.task,revision,owner:creator,mode:p.mode};
    });
  }
  generation(p){if(this.q('SELECT MAX(generation) AS g FROM targets WHERE task=? AND id=?',p.task,p.target_id)?.g!==p.generation)throw Error('Target generation stale');}
  validate(p){if(p.revoked)throw Error('Host revoked task policy');if(Date.parse(p.expires_at)<=Date.now())throw Error('Task policy expired');if(this.task(p.task).status!=='running')throw Error('Task is not running');this.generation(p);}
  require(actor,task){if(this.pins()[actor]!==task)throw Error('Session lacks host grant');if(this.q('SELECT task FROM sessions WHERE id=?',actor)?.task!==task)throw Error('Managed session binding changed');const p=this.policy(task);this.validate(p);return p;}
  allowed(p,url,method){const u=new URL(url),o=origin(url);if(u.hash)throw Error('Fragment not supported');const host=u.hostname.toLowerCase().replace(/\.$/,'');if(!p.origins.includes(o)||p.denied_hosts.some(h=>host===h||host.endsWith('.'+h)))throw Error('Origin forbidden by task source/scope policy');if(!p.methods.includes(method))throw Error('HTTP method not granted');if(u.href.length>8192)throw Error('URL too long');return u;}
  reserve(actor,task,operation,fingerprint,url,method,expectedRevision){
    word(operation,'operation');return this.tx(()=>{
      const p=this.require(actor,task);if(p.revision!==expectedRevision)throw Error('Task policy revision changed');this.allowed(p,url,method);
      const previous=this.q('SELECT * FROM control_attempts WHERE task=? AND operation=?',task,operation);
      if(previous){if(previous.fingerprint!==fingerprint)throw Error('Operation ID conflict');return {duplicate:true,attempt:previous.id,state:previous.state,result:previous.result?JSON.parse(previous.result):null,replay:false};}
      const env=this.q('SELECT * FROM control_environments WHERE id=?',p.environment),limits=JSON.parse(env.data),now=Date.now();
      const spent=this.q('SELECT COUNT(*) AS n FROM control_attempts WHERE task=?',task).n;if(spent>=p.max_requests||env.spent>=limits.max_requests)throw Error('Request budget exhausted');
      if(env.paused_until>now)throw Error('Environment paused after transport/service failures');
      if(env.next_start>now)return {wait_ms:env.next_start-now};
      if(this.q("SELECT COUNT(*) AS n FROM control_attempts WHERE environment=? AND state IN ('reserved','sending')",p.environment).n>=limits.max_inflight)return {wait_ms:25};
      const attempt=id();this.run("INSERT INTO control_attempts VALUES(?,?,?,?,?,?,'reserved',?,?,?,NULL,NULL)",attempt,task,operation,fingerprint,p.environment,p.revision,process.pid,processIdentity(),now);
      this.run('UPDATE control_environments SET spent=spent+1,next_start=? WHERE id=?',now+limits.min_interval_ms,p.environment);this.audit(task,'reserved',{attempt,operation,environment:p.environment,revision:p.revision});return {attempt,policy:p};
    });
  }
  sending(attempt){this.run("UPDATE control_attempts SET state='sending' WHERE id=? AND state='reserved'",attempt);}
  finish(attempt,state,result,bad=false){return this.tx(()=>{
    const row=this.q('SELECT * FROM control_attempts WHERE id=?',attempt);if(!row||!['reserved','sending'].includes(row.state))return;
    this.run('UPDATE control_attempts SET state=?,finished=?,result=? WHERE id=?',state,Date.now(),pack(result),attempt);
    const env=this.q('SELECT * FROM control_environments WHERE id=?',row.environment),limits=JSON.parse(env.data);const failures=bad?env.failures+1:0;
    this.run('UPDATE control_environments SET failures=?,paused_until=? WHERE id=?',failures,failures>=limits.failure_threshold?Date.now()+limits.cooldown_ms:env.paused_until,row.environment);
    this.audit(row.task,'finished',{attempt,state,...result});
  });}
  revoke(task,revision){return this.tx(()=>{const p=this.policy(task);if(p.revision!==revision)throw Error('Policy revision conflict');delete p.revision;p.revoked=true;this.run('UPDATE control_grants SET revision=revision+1,data=? WHERE task=?',pack(p),task);this.audit(task,'revoked',{});return {revoked:true,task};});}
  recover(task){return this.tx(()=>{let n=0;for(const row of this.all("SELECT * FROM control_attempts WHERE task=? AND state IN ('reserved','sending')",task)){if(processIdentity(row.pid)===row.identity)throw Error('Execution host still alive; cannot recover');this.run("UPDATE control_attempts SET state='unknown',finished=?,result=? WHERE id=?",Date.now(),pack({outcome:'unknown',charged:true,replay:false}),row.id);n++;}this.audit(task,'recover',{unknown:n});return {unknown:n,charged:true,replay:false};});}
  status(actor){const task=this.pins()[actor];if(!task)return {managed:false,network_grant:false,coverage:'No global restriction for ordinary sessions'};const p=this.policy(task),env=this.q('SELECT * FROM control_environments WHERE id=?',p.environment);return {managed:true,task,policy:p,task_spent:this.q('SELECT COUNT(*) AS n FROM control_attempts WHERE task=?',task).n,environment_spent:env.spent,active:this.q("SELECT COUNT(*) AS n FROM control_attempts WHERE environment=? AND state IN ('reserved','sending')",p.environment).n,paused_until:env.paused_until,coverage:'Native tool guard for pinned sessions + controlled HTTP(S); no OS-wide or other-process egress claim'};}
}
export function readPins(file){
  if(!fs.existsSync(file))return {};
  if(fs.statSync(file).size>4*1024*1024)throw Error('Control pin journal exceeds limit');
  const value=JSON.parse(fs.readFileSync(file,'utf8'));if(!value||typeof value!=='object'||Array.isArray(value))throw Error('Invalid control pin journal');
  for(const [actor,task] of Object.entries(value)){word(actor,'session');word(task,'task');}return value;
}
export {digest,word};
