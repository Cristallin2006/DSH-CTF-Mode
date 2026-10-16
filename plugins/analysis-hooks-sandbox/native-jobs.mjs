import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import path from 'node:path';

// Lifecycle metadata lives in the existing analysis database; ctx.jobs owns execution.
export class NativeJobs {
  constructor(state,jobs,{drainMs=5000}={}){
    this.db=new DatabaseSync(path.join(state,'state.sqlite3'));this.db.exec('PRAGMA busy_timeout=8000');
    this.db.exec(`CREATE TABLE IF NOT EXISTS analysis_job_scopes(owner TEXT PRIMARY KEY,task TEXT NOT NULL,data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS analysis_native_jobs(id TEXT PRIMARY KEY,task TEXT NOT NULL,owner TEXT NOT NULL,data TEXT NOT NULL);`);
    this.jobs=jobs;this.host=randomUUID();this.active=new Map();this.pending=new Map();this.changing=new Set();this.drainMs=drainMs;this.closed=false;
  }
  q(sql,...args){return this.db.prepare(sql).get(...args);}
  all(sql,...args){return this.db.prepare(sql).all(...args);}
  binding(owner){return this.q('SELECT task FROM sessions WHERE id=?',owner)?.task??null;}
  task(task){const row=this.q('SELECT data FROM tasks WHERE id=?',task);if(!row)throw Error('Unknown task');return JSON.parse(row.data);}
  target(task,id){return this.q('SELECT MAX(generation) AS generation FROM targets WHERE task=? AND id=?',task,id)?.generation;}
  scope(owner){const row=this.q('SELECT task,data FROM analysis_job_scopes WHERE owner=?',owner);return row?{task:row.task,...JSON.parse(row.data)}:null;}
  assertScope(owner,s,launch=true){
    if(this.binding(owner)!==s.task||this.task(s.task).status!=='running')throw Error('Native job task is unbound or not running');
    if(this.target(s.task,s.target_id)!==s.generation)throw Error('Native job target generation is stale');
    if(launch&&this.changing.has(s.task))throw Error('Task lifecycle change is draining jobs');
    if(launch&&this.all('SELECT data FROM analysis_native_jobs WHERE task=?',s.task).map(r=>JSON.parse(r.data)).some(d=>d.host!==this.host&&d.target_id===s.target_id&&['launching','running','stopping','cleanup_unknown'].includes(d.status)))throw Error('Previous or foreign host has unconfirmed work for this target');
    if(!this.jobs)throw Error('Native job registry unavailable; no lifecycle protection');
  }
  readiness(owner){
    const task=this.binding(owner),s=this.scope(owner);
    return {bound:!!task,task,task_status:task?this.task(task).status:null,
      targets:task?this.all('SELECT id,MAX(generation) AS generation FROM targets WHERE task=? GROUP BY id',task):[],
      job_scope:s,native_job_registry:!!this.jobs,lifecycle_coverage:'opt-in future native background bash jobs for the owning session; no request counting, detached or foreign-host coverage',
      jobs:this.all('SELECT id,data FROM analysis_native_jobs WHERE owner=? ORDER BY rowid DESC LIMIT 50',owner).map(r=>({id:r.id,...JSON.parse(r.data)})),jobs_view:'latest 50; existing native job registry owns output and execution'};
  }
  async command(owner,task,o,agent){
    if(this.binding(owner)!==task)throw Error('Bind this session to the requested task before job_scope');
    if(o.action==='status')return this.readiness(owner);
    if(this.changing.has(task)||this.pending.has(owner))throw Error('Wait for pending launch/lifecycle change before changing job scope');
    if(o.action==='clear'){
      this.changing.add(task);
      try{await this.drain(task,null,owner);this.db.prepare('DELETE FROM analysis_job_scopes WHERE owner=?').run(owner);return this.readiness(owner);}
      finally{this.changing.delete(task);}
    }
    const s={task,target_id:o.target_id,generation:o.generation,environment:o.environment,ttl_seconds:o.ttl_seconds,budget_ref:o.budget_ref??null};
    this.assertScope(owner,s);
    const previous=this.scope(owner);
    this.changing.add(task);
    try{if(previous&&JSON.stringify(previous)!==JSON.stringify(s))await this.drain(task,null,owner);
      this.db.prepare('INSERT OR REPLACE INTO analysis_job_scopes VALUES(?,?,?)').run(owner,task,JSON.stringify({...s,task:undefined}));}
    finally{this.changing.delete(task);}
    return {...this.readiness(owner),budget_enforcement:'none for native bash; budget_ref does not grant or enforce requests'};
  }
  save(id,data){this.db.prepare('UPDATE analysis_native_jobs SET data=? WHERE id=?').run(JSON.stringify(data),id);}
  adopt(agent){
    const owner=agent?.session?.header?.id,pending=this.pending.get(owner);if(!pending||!this.jobs)return;
    for(const job of this.jobs.list(agent)){
      if(job.ownerSession!==owner||job.kind!=='bash'||pending.before.has(job.id)||this.active.has(job.id))continue;
      const id=this.host+':'+owner+':'+job.id,data={host:this.host,job_id:job.id,status:job.status,...pending.scope,expires_at:job.startedAt+pending.scope.ttl_seconds*1000};
      const item={id,data,agent,jobId:job.id};this.active.set(job.id,item);
      try{this.db.prepare('INSERT INTO analysis_native_jobs VALUES(?,?,?,?)').run(id,pending.scope.task,owner,JSON.stringify(data));}
      catch(error){
        item.fault=error;item.reservation=pending.reservation;
        try{this.jobs.kill(job.id,agent,'Lifecycle registration failed');}catch{}
        try{this.save(item.reservation,{...data,status:'cleanup_unknown',registration_failed:true});}catch{}
        throw error;
      }
    }
  }
  async around(exec,next){
    if(exec.name!=='bash'||exec.arguments?.run_in_background!==true)return next();
    const owner=exec.agent?.session?.header?.id;if(!owner)return next();const s=this.scope(owner);if(!s)return next();
    this.assertScope(owner,s);if(this.pending.has(owner))throw Error('Concurrent background launch for same owner is not supported');
    const reservation=this.host+':launch:'+randomUUID();
    const pending={scope:s,reservation,before:new Set(this.jobs.list(exec.agent).map(j=>j.id))};this.pending.set(owner,pending);
    try{this.db.exec('BEGIN IMMEDIATE');this.assertScope(owner,s);this.db.prepare('INSERT INTO analysis_native_jobs VALUES(?,?,?,?)').run(reservation,s.task,owner,JSON.stringify({...s,host:this.host,status:'launching'}));this.db.exec('COMMIT');}
    catch(error){try{this.db.exec('ROLLBACK');}catch{}this.pending.delete(owner);throw error;}
    try{
      const result=await next();this.adopt(exec.agent);
      const fault=[...this.active.values()].find(x=>x.agent===exec.agent&&x.fault);if(fault)throw Error('Native lifecycle registration failed; cancellation requested');
      return result;
    }finally{this.pending.delete(owner);if(![...this.active.values()].some(i=>i.reservation===reservation))this.db.prepare('DELETE FROM analysis_native_jobs WHERE id=?').run(reservation);}
  }
  async tick(){
    for(const [key,item] of this.active){
      try{
        const j=this.jobs.get(item.jobId,item.agent);
        if(!['running','stopping'].includes(j.status)){item.data.status=j.status;this.save(item.id,item.data);if(item.reservation)this.db.prepare('DELETE FROM analysis_native_jobs WHERE id=?').run(item.reservation);this.active.delete(key);continue;}
        let reason;
        try{this.assertScope(item.agent.session.header.id,item.data,false);}catch{reason='task or target scope no longer valid';}
        if(Date.now()>=item.data.expires_at)reason='native job TTL expired';
        if(reason&&j.status==='running'){this.jobs.kill(item.jobId,item.agent,reason);item.data.status='stopping';item.data.stop_reason=reason;this.save(item.id,item.data);}
      }catch(error){item.data.status='cleanup_unknown';item.data.error='Native job cancellation or lookup failed';try{this.save(item.id,item.data);}catch{};}
    }
  }
  async drain(task,target=null,owner=null){
    if([...this.pending.entries()].some(([o,p])=>p.scope.task===task&&(!owner||owner===o)&&(!target||target===p.scope.target_id)))throw Error('Pending background launch; retry lifecycle change after launch settles');
    const rows=this.all('SELECT id,owner,data FROM analysis_native_jobs WHERE task=?',task).map(r=>({...r,data:JSON.parse(r.data)})).filter(r=>(!target||r.data.target_id===target)&&(!owner||r.owner===owner)&&['launching','running','stopping','cleanup_unknown'].includes(r.data.status));
    for(const r of rows){
      const item=[...this.active.values()].find(i=>i.id===r.id);
      if(!item)throw Error('Cleanup unconfirmed: job belongs to another or previous host; inspect its original job registry before releasing target');
      try{this.jobs.kill(item.jobId,item.agent,'task/target lifecycle change');}
      catch{item.data.status='cleanup_unknown';this.save(item.id,item.data);throw Error('Native cancellation failed; lifecycle change refused');}
    }
    await Promise.all(rows.map(async r=>{
      const item=[...this.active.values()].find(i=>i.id===r.id);
      const settled=await this.jobs.wait(item.jobId,this.drainMs,item.agent);
      if(['running','stopping'].includes(settled.status)){item.data.status='cleanup_unknown';this.save(item.id,item.data);throw Error('Cleanup not confirmed before deadline; lifecycle change refused');}
      item.data.status=settled.status;this.save(item.id,item.data);this.active.delete(item.jobId);
    }));
  }
  async change(owner,task,target,operation){
    if(this.changing.has(task))throw Error('Task lifecycle change already in progress');
    this.changing.add(task);
    try{await this.drain(task,target);const result=await operation();
      if(result?.exitCode!==undefined&&result.exitCode!==0)return result;
      this.db.prepare('DELETE FROM analysis_job_scopes WHERE task=?'+(target?' AND json_extract(data,\'$.target_id\')=?':'')).run(...(target?[task,target]:[task]));return result;
    }finally{this.changing.delete(task);}
  }
  async close(){
    if(this.closed)return;this.closed=true;
    // Reload cancels only jobs this adapter actually owns, never global daemons.
    for(const item of this.active.values())try{this.jobs.kill(item.jobId,item.agent,'lifecycle adapter disposing');}catch{}
    await Promise.allSettled([...this.active.values()].map(async item=>{try{const j=await this.jobs.wait(item.jobId,this.drainMs,item.agent);item.data.status=['running','stopping'].includes(j.status)?'cleanup_unknown':j.status;}catch{item.data.status='cleanup_unknown';}this.save(item.id,item.data);if(item.reservation&&item.data.status!=='cleanup_unknown')this.db.prepare('DELETE FROM analysis_native_jobs WHERE id=?').run(item.reservation);}));
    this.db.close();
  }
}
