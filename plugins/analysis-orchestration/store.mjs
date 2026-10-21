import {skillPlan} from './materials.mjs?revision=0.7.1';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID,createHash} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {executionPlan,lineage,route} from './planning.mjs?revision=0.7.1';
import {handoff} from './contract.mjs?revision=0.7.1';

export const hash=v=>createHash('sha256').update(v).digest('hex');
export const identity=(pid=process.pid)=>{try{return fs.readFileSync('/proc/sys/kernel/random/boot_id','utf8').trim()+':'+fs.readFileSync('/proc/'+pid+'/stat','utf8').split(') ').at(-1).split(' ')[19];}catch{return null;}};
export const text=(v,n,max=12000)=>{if(typeof v!=='string'||!v.trim()||v.length>max)throw Error('Invalid '+n);return v;};
export const integer=(v,min,max,n)=>{if(!Number.isInteger(v)||v<min||v>max)throw Error('Invalid '+n);return v;};
export const live=new Set(['launching','running','stopping','cleanup_unknown']);
export class Store {
  constructor(root){
    this.root=fs.realpathSync(root);this.closed=false;this.db=new DatabaseSync(path.join(fs.realpathSync(root),'state.sqlite3'));
    this.db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL');
    for(const name of ['tasks','sessions','targets','mem_owners'])if(!this.q("SELECT name FROM sqlite_master WHERE name=?",name))throw Error('Existing task and memory store required');
    this.db.exec(`CREATE TABLE IF NOT EXISTS orch_runs(task TEXT PRIMARY KEY,owner TEXT NOT NULL,host TEXT NOT NULL,pid INTEGER NOT NULL,identity TEXT NOT NULL,data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS orch_work(id TEXT PRIMARY KEY,task TEXT NOT NULL,epoch TEXT NOT NULL,work_key TEXT NOT NULL,data TEXT NOT NULL,UNIQUE(task,epoch,work_key));
      CREATE TABLE IF NOT EXISTS orch_events(seq INTEGER PRIMARY KEY AUTOINCREMENT,task TEXT NOT NULL,epoch TEXT NOT NULL,work TEXT,kind TEXT NOT NULL,data TEXT NOT NULL,at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS orch_objectives(task TEXT NOT NULL,scope TEXT NOT NULL,objective TEXT NOT NULL,work TEXT NOT NULL,PRIMARY KEY(task,scope,objective));`);
  }
  q(sql,...v){return this.db.prepare(sql).get(...v);} all(sql,...v){return this.db.prepare(sql).all(...v);} sql(sql,...v){return this.db.prepare(sql).run(...v);}
  tx(fn){this.db.exec('BEGIN IMMEDIATE');try{const v=fn();this.db.exec('COMMIT');return v;}catch(e){this.db.exec('ROLLBACK');throw e;}}
  own(owner,task,running=false){
    if(this.q('SELECT task FROM sessions WHERE id=?',owner)?.task!==task||!this.q('SELECT task FROM mem_owners WHERE task=? AND actor=?',task,owner))throw Error('Bind the task and open its memory in this main session first');
    const d=JSON.parse(this.q('SELECT data FROM tasks WHERE id=?',task)?.data??'null');
    if(!d||running&&d.status!=='running')throw Error('Task is not running');return d;
  }
  targets(task){return this.all('SELECT id,MAX(generation) AS generation FROM targets WHERE task=? GROUP BY id ORDER BY id',task);}
  run(task){const r=this.q('SELECT * FROM orch_runs WHERE task=?',task);return r?{...JSON.parse(r.data),task,owner:r.owner,host:r.host,pid:r.pid,identity:r.identity}:null;}
  save(r){const {task,owner,host,pid,identity,...data}=r;this.sql('INSERT INTO orch_runs VALUES(?,?,?,?,?,?) ON CONFLICT(task) DO UPDATE SET owner=excluded.owner,host=excluded.host,pid=excluded.pid,identity=excluded.identity,data=excluded.data',task,owner,host,pid,identity,JSON.stringify(data));}
  work(task,id){const r=this.q('SELECT data FROM orch_work WHERE task=? AND id=?',task,id);if(!r)throw Error('Work unavailable');return JSON.parse(r.data);}
  works(r){return this.all('SELECT data FROM orch_work WHERE task=? AND epoch=? ORDER BY rowid',r.task,r.epoch).map(x=>JSON.parse(x.data));}
  saveWork(w){this.sql('INSERT INTO orch_work VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data',w.id,w.task,w.epoch,w.key,JSON.stringify(w));}
  event(r,work,kind,data={}){this.sql('INSERT INTO orch_events(task,epoch,work,kind,data,at) VALUES(?,?,?,?,?,?)',r.task,r.epoch,work,kind,JSON.stringify(data),Date.now());}
  events(r,work=null,after=0){return this.all('SELECT * FROM orch_events WHERE task=? AND epoch=? AND seq>? AND (? IS NULL OR work=?) ORDER BY seq DESC LIMIT 40',r.task,r.epoch,after,work,work).reverse().map(x=>({...x,data:JSON.parse(x.data)}));}
  latestSeq(r){return this.q('SELECT COALESCE(MAX(seq),0) AS n FROM orch_events WHERE task=? AND epoch=?',r.task,r.epoch).n;}
  objectiveScope(r){return hash(JSON.stringify({epoch:r.epoch,targets:r.targets}));}
  objective(r,ref){const row=this.q('SELECT work FROM orch_objectives WHERE task=? AND scope=? AND objective=?',r.task,this.objectiveScope(r),text(ref,'objective_ref',200));return row?this.work(r.task,row.work):null;}
  bindObjective(r,id,ref){return this.tx(()=>{this.scope(r);const w=this.work(r.task,id);text(ref,'objective_ref',200);if(w.epoch!==r.epoch||w.role==='observer'||w.assignment_kind&&w.assignment_kind!=='primary')throw Error('Only a current primary Solver can bind an objective');if(w.objective_ref&&w.objective_ref!==ref)throw Error('Objective identity cannot be silently changed');const old=this.objective(r,ref);if(old&&old.id!==id)throw Error('Objective is already bound to '+old.id);this.sql('INSERT OR IGNORE INTO orch_objectives VALUES(?,?,?,?)',r.task,this.objectiveScope(r),ref,id);w.objective_ref=ref;w.assignment_kind='primary';w.fingerprint=this.fingerprint(w);this.saveWork(w);this.event(r,id,'objective_bound',{objective_ref:ref});return route(w);});}
  fingerprint(w){const input={};for(const k of ['key','question','success','depends_on','tools','role','observe_work','timeout_ms','max_steps','assignment_kind','objective_ref','source_work','branch_reason','execution_plan','skill_plan','handoff','memory_plan','contrast_plan'])if(w[k]!==undefined)input[k]=w[k];return hash(JSON.stringify(input));}
  scope(r){this.own(r.owner,r.task,true);if(JSON.stringify(this.targets(r.task))!==JSON.stringify(r.targets))throw Error('Target generation changed');}
  enabled(owner,task,host){this.own(owner,task,true);const r=this.run(task);if(!r||r.owner!==owner||r.host!==host||r.state!=='enabled')throw Error('Enable or explicitly resume orchestration in this host first');this.scope(r);return r;}
  create(owner,task,host,opts){
    return this.tx(()=>{this.own(owner,task,true);const old=this.run(task);
      if(old&&this.works(old).some(w=>live.has(w.state)))throw Error('Previous Solver cleanup must be confirmed first');
      if(old&&['enabled','paused'].includes(old.state))throw Error('Existing orchestration: use status/resume/disable, not enable again');
      if(this.q("SELECT name FROM sqlite_master WHERE name='control_pins'")&&this.q('SELECT task FROM control_pins WHERE actor=?',owner))throw Error('Strict HTTP control does not yet support executable Solvers; keep existing controller protection');
      if(this.q("SELECT name FROM sqlite_master WHERE name='mem_work'")&&this.q("SELECT id FROM mem_work WHERE task=? AND state='running'",task))throw Error('Wait for existing read-only collaboration to settle');
      const r={task,owner,host,pid:process.pid,identity:identity(),epoch:randomUUID(),state:'enabled',targets:this.targets(task),started:Date.now(),expires:opts.task_ms==null?null:Date.now()+opts.task_ms,wakeups:0,...opts};
      this.save(r);this.event(r,null,'enabled');return r;
    });
  }
  add(r,o){return this.tx(()=>{
    text(o.key,'key',160);text(o.question,'question');text(o.success,'success criteria',4000);
    const previous=this.q('SELECT data FROM orch_work WHERE task=? AND epoch=? AND work_key=?',r.task,r.epoch,o.key);
    const input={key:o.key,question:o.question,success:o.success,depends_on:o.depends_on??[],tools:o.tools??[],role:o.role??'solver',observe_work:o.observe_work??null,timeout_ms:o.timeout_ms??null,max_steps:o.max_steps??null};
    Object.assign(input,lineage(o));
    if(input.role==='observer'){if(o.skill_plan?.required?.length)throw Error('Observer cannot load required skills');}else {input.execution_plan=executionPlan(o.execution_plan);input.skill_plan=skillPlan(o.skill_plan);}
    if(input.source_work){const source=this.work(r.task,input.source_work);if(source.epoch!==r.epoch)throw Error('Branch source belongs to old epoch');}
    for(const key of ['memory_plan','contrast_plan'])if(o[key]!==undefined)input[key]=structuredClone(o[key]);
    if(o.handoff!==undefined)input.handoff=handoff(o.handoff);
    if(previous){const w=JSON.parse(previous.data);if(w.fingerprint!==this.fingerprint(input))throw Error('Work key reused with different content');return w;}
    if(input.assignment_kind==='primary'&&input.objective_ref){const existing=this.objective(r,input.objective_ref);if(existing)return {...existing,route:route(existing),deduplicated:true};}
    if(this.works(r).length>=64)throw Error('Work limit reached; review scope before adding more');
    if(!Array.isArray(input.depends_on)||input.depends_on.length>16||new Set(input.depends_on).size!==input.depends_on.length)throw Error('Invalid dependencies');
    for(const id of input.depends_on){const d=this.work(r.task,id);if(d.epoch!==r.epoch)throw Error('Dependency belongs to old epoch');}
    if(!Array.isArray(input.tools)||input.tools.length>24||input.tools.some(x=>typeof x!=='string'))throw Error('Explicit tool list required');
    if(input.timeout_ms!=null)integer(input.timeout_ms,1000,1800000,'timeout_ms');if(input.max_steps!=null)integer(input.max_steps,1,100000,'max_steps');
    if(!['solver','observer'].includes(input.role))throw Error('Invalid role');
    if(input.role==='observer'){if(input.tools.length)throw Error('Observer has no execution tools');const seen=this.work(r.task,input.observe_work);if(seen.epoch!==r.epoch)throw Error('Observed work belongs to old epoch');}
    const w={...input,id:'solver-'+randomUUID(),task:r.task,epoch:r.epoch,fingerprint:this.fingerprint(input),state:'pending',created:Date.now(),steps:0,calls:0,errors:0,last_activity:null,result:null,verification:'untested',skill_delivery:{state:input.role==='observer'?'not_applicable':'pending',authority:'selection only; no content delivered'}};
    this.saveWork(w);if(w.assignment_kind==='primary'&&w.objective_ref)this.sql('INSERT INTO orch_objectives VALUES(?,?,?,?)',r.task,this.objectiveScope(r),w.objective_ref,w.id);this.event(r,w.id,'added',{role:w.role});return {...w,route:route(w)};
  });}
  setSkills(w,plan){
    w.skill_plan=plan;w.skill_delivery={state:'pending',authority:'selected; not yet delivered'};w.fingerprint=this.fingerprint(w);this.saveWork(w);return w;
  }
  setExecution(w,plan){w.execution_plan=plan;w.preflight=null;w.fingerprint=this.fingerprint(w);this.saveWork(w);return w;}

  claim(r,id,host,maxGlobal,continuation=false){return this.tx(()=>{
    this.scope(r);const fresh=this.run(r.task);if(fresh.state!=='enabled'||fresh.host!==host)throw Error('Orchestration paused or changed');
    const w=this.work(r.task,id);if(w.epoch!==r.epoch||(!continuation&&w.state!=='pending')||(continuation&&(w.mode!=='continuable'||live.has(w.state))))throw Error('Work is not pending in this epoch');
    if(this.works(r).filter(x=>live.has(x.state)).length>=r.max_parallel)throw Error('Task concurrency reached');
    const n=this.all('SELECT data FROM orch_work').map(x=>JSON.parse(x.data)).filter(x=>live.has(x.state)).length;if(n>=maxGlobal)throw Error('Host concurrency reached or previous cleanup unconfirmed');
    for(const id of w.depends_on)if(this.work(r.task,id).state!=='adopted')throw Error('Dependency must be reviewed and adopted first');
    w.state='launching';w.started=Date.now();w.host=host;w.last_activity=Date.now();this.saveWork(w);this.event(r,w.id,'launching');return w;
  });}
  close(){if(this.closed)return;this.db.close();this.closed=true;}
}
