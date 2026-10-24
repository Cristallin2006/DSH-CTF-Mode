import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {validate} from './schema.mjs';

export const hash=v=>crypto.createHash('sha256').update(v).digest('hex');
export const uid=p=>p+'-'+crypto.randomUUID();
export const now=()=>new Date().toISOString();
export const json=v=>JSON.stringify(v);
export const text=(v,n,max=12000)=>{if(typeof v!=='string'||!v.trim()||v.length>max)throw Error('Invalid '+n);return v;};
export const ids=(v=[])=>{if(!Array.isArray(v)||v.length>40||v.some(x=>typeof x!=='string'||!x||x.length>200))throw Error('Invalid ID list');return [...new Set(v)];};
const refs=d=>[...d.evidence_refs,...(d.details.input_refs??[])];
const inside=(root,p)=>{const r=path.relative(root,p);return r!=='..'&&!r.startsWith('..'+path.sep)&&!path.isAbsolute(r);};
export function processIdentity(pid=process.pid){
  try{return fs.readFileSync('/proc/sys/kernel/random/boot_id','utf8').trim()+':'+fs.readFileSync('/proc/'+pid+'/stat','utf8').split(') ').at(-1).split(' ')[19];}catch{return null;}
}
export class MemoryStore {
  constructor(state,schema){
    this.root=fs.realpathSync(state);this.schema=schema;
    this.db=new DatabaseSync(path.join(this.root,'state.sqlite3'));
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON');
    for(const table of ['tasks','sessions','targets','artifacts','records','events'])if(!this.q("SELECT name FROM sqlite_master WHERE type='table' AND name=?",table))throw Error('Existing analysis-v1 database required');
    this.db.exec([
      'CREATE TABLE IF NOT EXISTS mem_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL)',
      'CREATE TABLE IF NOT EXISTS mem_owners(task TEXT PRIMARY KEY,actor TEXT NOT NULL,workspace TEXT NOT NULL,resume_hash TEXT NOT NULL)',
      'CREATE TABLE IF NOT EXISTS mem_sources(id TEXT PRIMARY KEY,task TEXT NOT NULL,target TEXT,generation INTEGER NOT NULL,path TEXT NOT NULL,sha256 TEXT NOT NULL,body TEXT NOT NULL,created TEXT NOT NULL)',
      'CREATE TABLE IF NOT EXISTS mem_objects(id TEXT PRIMARY KEY,task TEXT NOT NULL,head INTEGER NOT NULL)',
      'CREATE TABLE IF NOT EXISTS mem_revisions(id TEXT NOT NULL,rev INTEGER NOT NULL,task TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(id,rev))',
      'CREATE TABLE IF NOT EXISTS mem_audit(seq INTEGER PRIMARY KEY AUTOINCREMENT,task TEXT NOT NULL,actor TEXT NOT NULL,action TEXT NOT NULL,data TEXT NOT NULL,created TEXT NOT NULL)',
      'CREATE TABLE IF NOT EXISTS mem_ops(task TEXT NOT NULL,operation TEXT NOT NULL,fingerprint TEXT NOT NULL,result TEXT NOT NULL,PRIMARY KEY(task,operation))',
      'CREATE TABLE IF NOT EXISTS mem_relations(id TEXT PRIMARY KEY,task TEXT NOT NULL,left_id TEXT NOT NULL,right_id TEXT NOT NULL,kind TEXT NOT NULL,reason TEXT NOT NULL)',
      'CREATE TABLE IF NOT EXISTS mem_reads(task TEXT NOT NULL,actor TEXT NOT NULL,source TEXT NOT NULL,sha256 TEXT NOT NULL,PRIMARY KEY(task,actor,source))',
      'CREATE TABLE IF NOT EXISTS mem_contexts(id TEXT PRIMARY KEY,task TEXT NOT NULL,actor TEXT NOT NULL,refs TEXT NOT NULL,bytes INTEGER NOT NULL,created TEXT NOT NULL)',
      'CREATE TABLE IF NOT EXISTS mem_work(id TEXT PRIMARY KEY,task TEXT NOT NULL,question TEXT NOT NULL,inputs TEXT NOT NULL,deps TEXT NOT NULL,state TEXT NOT NULL,child TEXT,host TEXT,pid INTEGER,identity TEXT,result TEXT,diagnostic TEXT)',
      'CREATE TABLE IF NOT EXISTS mem_child_reads(work TEXT NOT NULL,child TEXT NOT NULL,source TEXT NOT NULL,PRIMARY KEY(work,child,source))'
    ].join(';'));
    const version=this.q("SELECT value FROM mem_meta WHERE key='schema'");
    if(version&&version.value!=='0.2.0')throw Error('Unsupported memory schema version');
    this.run("INSERT OR IGNORE INTO mem_meta VALUES('schema','0.2.0')");
    this.fts='none';
    try{this.db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS mem_fts USING fts5(id UNINDEXED,task UNINDEXED,body,tokenize='trigram')");this.fts='fts5-trigram';}catch{}
  }
  q(sql,...v){return this.db.prepare(sql).get(...v);}
  all(sql,...v){return this.db.prepare(sql).all(...v);}
  run(sql,...v){return this.db.prepare(sql).run(...v);}
  tx(fn){this.db.exec('BEGIN IMMEDIATE');try{const r=fn();this.db.exec('COMMIT');return r;}catch(e){this.db.exec('ROLLBACK');throw e;}}
  close(){this.db.close();}
  audit(task,actor,action,data={}){
    this.run('INSERT INTO mem_audit(task,actor,action,data,created) VALUES(?,?,?,?,?)',task,actor,action,json(data),now());
    this.run('INSERT INTO events(key,ts,session,task,kind,data) VALUES(?,?,?,?,?,?)',uid('memory-event'),Date.now()/1000,actor,task,'memory-'+action,json(data));
  }
  baseTask(task){const r=this.q('SELECT data FROM tasks WHERE id=?',task);if(!r)throw Error('Task unavailable');return JSON.parse(r.data);}
  bound(actor,task){if(this.q('SELECT task FROM sessions WHERE id=?',actor)?.task!==task)throw Error('Task unavailable for calling session');return this.baseTask(task);}
  own(actor,task,write=false){
    const base=this.bound(actor,task),owner=this.q('SELECT * FROM mem_owners WHERE task=? AND actor=?',task,actor);
    if(!owner)throw Error('Task unavailable for calling session');
    if(write&&base.status!=='running')throw Object.assign(Error('Task is not running'),{code:'MEMORY_TASK_NOT_RUNNING',taskStatus:base.status});return owner;
  }
  open(actor,task,cwd,token){
    this.bound(actor,task);const workspace=fs.realpathSync(cwd);
    if(inside(this.root,workspace)||inside(workspace,this.root))throw Error('Workspace must not overlap analysis-state');
    return this.tx(()=>{
      const old=this.q('SELECT * FROM mem_owners WHERE task=?',task);
      if(old){
        if(old.actor===actor)return {task,owner:actor,already_open:true};
        if(typeof token!=='string'||!crypto.timingSafeEqual(Buffer.from(hash(token)),Buffer.from(old.resume_hash)))throw Error('Task unavailable for calling session');
        const running=this.all("SELECT * FROM mem_work WHERE task=? AND state='running'",task);
        if(running.some(w=>processIdentity(w.pid)===w.identity))throw Error('Execution host still alive; handoff refused');
        if(workspace!==old.workspace)throw Error('Resume workspace mismatch');
        for(const w of running)this.run("UPDATE mem_work SET state='interrupted',diagnostic='Host exited; no replay' WHERE id=?",w.id);
        this.run('UPDATE mem_owners SET actor=? WHERE task=?',actor,task);this.audit(task,actor,'resume',{interrupted:running.length});return {task,owner:actor,interrupted:running.length};
      }
      if(this.q("SELECT session FROM events WHERE task=? AND kind='task-created' ORDER BY id LIMIT 1",task)?.session!==actor)throw Error('Only original task creator can first open its memory');
      const freshToken=crypto.randomBytes(32).toString('hex');this.run('INSERT INTO mem_owners VALUES(?,?,?,?)',task,actor,workspace,hash(freshToken));this.audit(task,actor,'open');return {task,owner:actor,resume_token:freshToken,note:'Keep token private; never store it in memory.'};
    });
  }
  handoff(actor,task){return this.tx(()=>{this.own(actor,task);if(this.q("SELECT id FROM mem_work WHERE task=? AND state='running'",task))throw Error('Active work must settle first');const token=crypto.randomBytes(32).toString('hex');this.run('UPDATE mem_owners SET resume_hash=? WHERE task=?',hash(token),task);this.audit(task,actor,'handoff-token');return {resume_token:token};});}
  generation(task,target){if(target===null)return 0;text(target,'target');const g=this.q('SELECT MAX(generation) AS g FROM targets WHERE task=? AND id=?',task,target)?.g;if(!g)throw Error('Target unavailable');return g;}
  assertGeneration(task,target,g){if(!Number.isInteger(g)||this.generation(task,target)!==g)throw Error('Target generation changed');}
  sourceRow(task,id){const s=this.q('SELECT * FROM mem_sources WHERE id=? AND task=?',id,task);if(!s)throw Error('Source unavailable');return s;}
  filePath(owner,relative){
    text(relative,'source path',2000);const p=fs.realpathSync(path.resolve(owner.workspace,relative));
    if(!inside(owner.workspace,p)||inside(this.root,p)||p.split(path.sep).some(x=>/^(\.dsh|\.ssh|\.aws|\.git|\.env(?:\..*)?|credentials?)$/i.test(x)))throw Error('Source path outside permitted evidence area');
    const stat=fs.statSync(p);if(!stat.isFile()||stat.size>128*1024)throw Error('Source must be bounded regular text');return p;
  }
  verifySource(s){
    this.assertGeneration(s.task,s.target,s.generation);const owner=this.q('SELECT * FROM mem_owners WHERE task=?',s.task);
    const p=this.filePath(owner,s.path),buf=fs.readFileSync(p);if(buf.length>128*1024||hash(buf)!==s.sha256)throw Error('Source changed or withdrawn');return s;
  }
  sensitive(body){return /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|(?:api[_-]?key|access[_-]?token|authorization|password|resume_token)\s*[:=]\s*["']?(?!\*{3}|REDACTED|<redacted>)[A-Za-z0-9_+/=.-]{8,}/i.test(body);}
  register(actor,task,{path:relative,target_id=null,expected_generation=0,record_id}){
    const owner=this.own(actor,task,true);this.assertGeneration(task,target_id,expected_generation);
    if(record_id){
      const old=this.q("SELECT data FROM records WHERE id=? AND task=? AND kind='evidence'",record_id,task);if(!old)throw Error('Legacy evidence unavailable');
      const d=JSON.parse(old.data);relative=d.path;if((d.target??null)!==target_id||(d.generation??0)!==expected_generation)throw Error('Legacy evidence target mismatch');
      if(hash(fs.readFileSync(this.filePath(owner,relative)))!==d.sha256)throw Error('Legacy evidence changed');
    }
    const p=this.filePath(owner,relative),buf=fs.readFileSync(p);
    if(buf.length>128*1024||buf.includes(0))throw Error('Only bounded UTF-8 text supported');
    const body=new TextDecoder('utf-8',{fatal:true}).decode(buf);if(this.sensitive(body))throw Error('Sensitive content requires redacted evidence');
    const digest=hash(buf);
    return this.tx(()=>{
      this.own(actor,task,true);this.assertGeneration(task,target_id,expected_generation);
      const old=this.q('SELECT id FROM mem_sources WHERE task=? AND target IS ? AND generation=? AND path=? AND sha256=?',task,target_id,expected_generation,p,digest);if(old)return {source_id:old.id,sha256:digest};
      const id=uid('src');this.run('INSERT INTO mem_sources VALUES(?,?,?,?,?,?,?,?)',id,task,target_id,expected_generation,p,digest,body,now());
      const data={path:p,sha256:digest,size:buf.length};this.run('INSERT OR IGNORE INTO artifacts VALUES(?,?)',digest,json(data));
      this.run('INSERT INTO events(key,ts,session,task,kind,data) VALUES(?,?,?,?,?,?)',uid('artifact-link'),Date.now()/1000,actor,task,'artifact-linked',json(data));
      this.audit(task,actor,'source',{source:id,sha256:digest,target:target_id,generation:expected_generation});return {source_id:id,sha256:digest,target_id,generation:expected_generation};
    });
  }
  readSource(actor,task,id){
    this.own(actor,task);const s=this.verifySource(this.sourceRow(task,id));
    this.run('INSERT OR REPLACE INTO mem_reads VALUES(?,?,?,?)',task,actor,id,s.sha256);return {source_id:id,sha256:s.sha256,text:s.body,target_id:s.target,generation:s.generation,authority:'tool_output',verification:'untested'};
  }
  revision(task,id,rev){const r=this.q('SELECT r.data FROM mem_revisions r JOIN mem_objects o ON o.id=r.id AND o.task=r.task WHERE r.task=? AND r.id=? AND r.rev=?',task,id,rev);if(!r)throw Error('Memory unavailable');return JSON.parse(r.data);}
  head(task,id){const o=this.q('SELECT head FROM mem_objects WHERE task=? AND id=?',task,id);if(!o)throw Error('Memory unavailable');return this.revision(task,id,o.head);}
  checkData(actor,task,d){
    validate(d,this.schema);if(Buffer.byteLength(json(d))>64000)throw Error('Candidate too large');this.assertGeneration(task,d.target_id,d.expected_generation);
    if(d.verification==='accepted')throw Error('Trusted acceptance-receipt adapter not configured; accepted promotion refused');
    for(const r of refs(d)){const s=this.verifySource(this.sourceRow(task,r.source_id));if(s.target!==d.target_id||s.generation!==d.expected_generation)throw Error('Source target/generation mismatch');if(r.content_sha256&&r.content_sha256!==s.sha256)throw Error('Source hash mismatch');}
    for(const r of d.dependency_refs??[]){const v=this.head(task,r.record_id);if(v.revision!==r.revision||v.target_id!==d.target_id||v.expected_generation!==d.expected_generation||this.applicable(task,v)!=='current')throw Error('Stale or differently scoped dependency');}
    if(this.sensitive(json(d)))throw Error('Sensitive candidate refused');
  }
  persist(task,actor,id,rev,data,action){
    this.run('INSERT INTO mem_revisions VALUES(?,?,?,?)',id,rev,task,json(data));this.run('INSERT INTO mem_objects VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET head=excluded.head',id,task,rev);
    if(this.fts!=='none'){this.run('DELETE FROM mem_fts WHERE id=? AND task=?',id,task);this.run('INSERT INTO mem_fts(id,task,body) VALUES(?,?,?)',id,task,data.title+'\n'+data.body);}
    this.audit(task,actor,action,{id,revision:rev});return data;
  }
  propose(actor,task,d,{id,expected_revision}={}){
    this.own(actor,task);
    return this.tx(()=>{
      this.own(actor,task);const fp=hash(json({d,id:id??null,expected_revision:expected_revision??null}));
      const prev=this.q('SELECT * FROM mem_ops WHERE task=? AND operation=?',task,d.operation_id);if(prev){if(prev.fingerprint!==fp)throw Error('Idempotency key reused');return JSON.parse(prev.result);}
      this.own(actor,task,true);this.checkData(actor,task,d);
      let rev=1;if(id){const old=this.head(task,id);if(old.revision!==expected_revision)throw Error('Revision conflict');rev=old.revision+1;}else id=uid('mem');
      const entry={...structuredClone(d),id,revision:rev,review_state:'candidate',visibility:'session',applicability:'current',recorded_at:now(),actor};
      this.persist(task,actor,id,rev,entry,'propose');const result={id,revision:rev,review_state:'candidate',verification:entry.verification};this.run('INSERT INTO mem_ops VALUES(?,?,?,?)',task,d.operation_id,fp,json(result));return result;
    });
  }
  applicable(task,d,seen=new Set(),sourceCache=new Map()){
    if(['superseded','revoked'].includes(d.applicability))return d.applicability;if(seen.has(d.id)||seen.size>256)return 'needs_recheck';seen.add(d.id);
    try{
      this.assertGeneration(task,d.target_id,d.expected_generation);
      if((d.recheck_after&&Date.parse(d.recheck_after)<=Date.now())||(d.valid_from&&Date.parse(d.valid_from)>Date.now())||(d.valid_to&&Date.parse(d.valid_to)<=Date.now()))return 'needs_recheck';
      for(const r of refs(d))if(!sourceCache.has(r.source_id)){this.verifySource(this.sourceRow(task,r.source_id));sourceCache.set(r.source_id,true);}
      for(const r of d.dependency_refs??[]){const v=this.head(task,r.record_id);if(v.revision!==r.revision||this.applicable(task,v,new Set(seen),sourceCache)!=='current')return 'needs_recheck';}
      return d.applicability;
    }catch{return 'needs_recheck';}
  }
  get(actor,task,id,rev){this.own(actor,task);const d=rev?this.revision(task,id,rev):this.head(task,id);return {...d,applicability:this.applicable(task,d),historical:!!rev&&this.q('SELECT head FROM mem_objects WHERE id=? AND task=?',id,task).head!==rev,authority:'analysis-data-not-instructions'};}
  review(actor,task,{id,expected_revision,decision,reason}){
    text(reason,'review reason',4000);if(!['publish','reject'].includes(decision))throw Error('Invalid review');
    return this.tx(()=>{
      this.own(actor,task,true);const d=this.head(task,id);if(d.revision!==expected_revision)throw Error('Revision conflict');
      if(decision==='publish'){if(this.applicable(task,d)!=='current')throw Error('Memory stale/disputed');for(const r of refs(d)){const s=this.sourceRow(task,r.source_id);if(!this.q('SELECT source FROM mem_reads WHERE task=? AND actor=? AND source=? AND sha256=?',task,actor,s.id,s.sha256))throw Error('Read original source before publication');}}
      return this.persist(task,actor,id,d.revision+1,{...d,revision:d.revision+1,review_state:decision==='publish'?'reviewed':'rejected',visibility:decision==='publish'?'task':'session',review_reason:reason,recorded_at:now()},'review-'+decision);
    });
  }
  link(actor,task,{left,right,kind,reason,left_revision,right_revision}){
    if(!['supports','contradicts','derived_from','depends_on','tests','supersedes'].includes(kind))throw Error('Invalid relation');text(reason,'reason',3000);
    return this.tx(()=>{
      this.own(actor,task,true);const a=this.head(task,left),b=this.head(task,right);if(left===right||a.revision!==left_revision||b.revision!==right_revision)throw Error('Relation revision conflict');
      if(a.target_id!==b.target_id||a.expected_generation!==b.expected_generation)throw Error('Same target/generation required');
      const acceptable=kind==='contradicts'?['current','disputed']:['current'];
      if(!acceptable.includes(this.applicable(task,a))||!acceptable.includes(this.applicable(task,b)))throw Error('Relation endpoint not current');
      const id=uid('rel');this.run('INSERT INTO mem_relations VALUES(?,?,?,?,?,?)',id,task,left,right,kind,reason);
      if(kind==='contradicts')for(const d of [a,b])this.persist(task,actor,d.id,d.revision+1,{...d,revision:d.revision+1,applicability:'disputed',recorded_at:now()},'dispute');
      if(kind==='supersedes')this.persist(task,actor,b.id,b.revision+1,{...b,revision:b.revision+1,applicability:'superseded',recorded_at:now()},'supersede');
      if(['derived_from','depends_on'].includes(kind))this.persist(task,actor,a.id,a.revision+1,{...a,revision:a.revision+1,dependency_refs:[...(a.dependency_refs??[]),{record_id:b.id,revision:b.revision}],recorded_at:now()},'dependency');
      this.audit(task,actor,'link',{id,left,right,kind,reason});return {id};
    });
  }
  invalidate(actor,task,{id,expected_revision,reason,state='revoked'}){
    text(reason,'reason',3000);if(!['revoked','superseded','needs_recheck'].includes(state))throw Error('Invalid applicability');
    return this.tx(()=>{this.own(actor,task,true);const d=this.head(task,id);if(d.revision!==expected_revision)throw Error('Revision conflict');return this.persist(task,actor,id,d.revision+1,{...d,revision:d.revision+1,applicability:state,change_reason:reason,recorded_at:now()},'invalidate');});
  }
  query(actor,task,{query='',include_history=false,limit=20,offset=0,target_id}={}){
    this.own(actor,task);if(typeof query!=='string'||query.length>500||!Number.isInteger(limit)||limit<1||limit>50||!Number.isInteger(offset)||offset<0)throw Error('Invalid query');
    let rows,engine='scoped-substring',index_degraded=false;
    const prefix="SELECT r.data FROM mem_revisions r JOIN mem_objects o ON o.id=r.id AND o.task=r.task AND o.head=r.rev WHERE o.task=? AND (?=0 OR json_extract(r.data,'$.target_id') IS ? OR json_extract(r.data,'$.target_id') IS NULL) AND ";
    const scoped=[task,target_id===undefined?0:1,target_id??null];
    if(this.fts!=='none'&&query.length>=3)try{
      const phrase='"'+query.replaceAll('"','""')+'"';
      rows=this.all(prefix+"(instr(lower(r.data),lower(?))>0 OR o.id IN (SELECT id FROM mem_fts WHERE task=? AND body MATCH ?)) ORDER BY o.rowid DESC LIMIT 501",...scoped,query,task,phrase);
      engine='fts5-trigram+scoped-substring';
    }catch{index_degraded=true;}
    if(!rows)rows=this.all(prefix+"(?='' OR instr(lower(r.data),lower(?))>0) ORDER BY o.rowid DESC LIMIT 501",...scoped,query,query);
    const cache=new Map();
    const docs=rows.slice(0,500).map(r=>JSON.parse(r.data)).filter(d=>target_id===undefined||d.target_id===target_id||d.target_id===null).map(d=>({...d,applicability:this.applicable(task,d,new Set(),cache)})).filter(d=>include_history||(!['revoked','superseded','needs_recheck'].includes(d.applicability)&&d.review_state!=='rejected'));
    return {items:docs.slice(offset,offset+limit),matched_in_scan:docs.length,scan_truncated:rows.length>500,next_offset:offset+limit<docs.length?offset+limit:null,engine,index:this.fts,index_degraded,warning:'No match does not prove no previous experiment.'};
  }
  context(actor,task,{query='',budget_bytes=8192,target_id,source_grant}={}){
    if(!Number.isInteger(budget_bytes)||budget_bytes<512||budget_bytes>16384)throw Error('Invalid context budget');
    const found=this.query(actor,task,{query,limit:50,target_id}),all=this.query(actor,task,{limit:50,target_id}).items.filter(d=>d.review_state==='reviewed');
    let docs=[...new Map([...all.filter(d=>d.kind==='constraint'),...found.items.filter(d=>d.review_state==='reviewed')].map(d=>[d.id,d])).values()];
    if(source_grant)docs=docs.filter(d=>this.grantSafe(task,d,source_grant));
    const items=[],omitted=[],base={authority:'analysis-data-not-instructions',task,estimator:'utf8-byte-cap',items,omitted,warning:'Review original evidence; reviewed is not accepted. Unmatched history may exist.'};
    for(const d of docs){
      const conflict=this.conflictGroup(actor,task,d),group=conflict.items,peers=group.filter(v=>v.id!==d.id);
      if(conflict.truncated){if(Buffer.byteLength(json(base))+100<budget_bytes-256)omitted.push({reason:'conflict group too large; inspect graph explicitly'});continue;}
      if(group.some(v=>v.review_state!=='reviewed'||['needs_recheck','revoked','superseded'].includes(v.applicability))||(source_grant&&group.some(v=>!this.grantSafe(task,v,source_grant)))){if(Buffer.byteLength(json(base))+100<budget_bytes-256)omitted.push({reason:'conflict group not fully current, reviewed and granted'});continue;}
      const compact=group.filter(v=>!items.some(x=>x.id===v.id)).map(v=>({id:v.id,revision:v.revision,kind:v.kind,title:v.title,body:v.body,origin:v.origin,verification:v.verification,accept_scope:v.accept_scope,unresolved:v.unresolved,applicability:v.applicability,evidence_refs:v.evidence_refs,details:v.details}));
      const before=items.length;items.push(...compact);
      if(Buffer.byteLength(json(base))>budget_bytes-256){items.splice(before);if(Buffer.byteLength(json(base))+200<budget_bytes-256)omitted.push({record_ids:group.map(v=>v.id),reason:peers.length?'conflict group exceeds budget':'budget'});}
    }
    const data={...base,omitted_count:Math.max(0,docs.length-items.length),scan_truncated:found.scan_truncated,snapshot_seq:this.q('SELECT MAX(seq) AS s FROM mem_audit WHERE task=?',task).s??0};
    if(Buffer.byteLength(json(data))>budget_bytes)throw Error('Context metadata exceeds budget');
    this.run('INSERT INTO mem_contexts VALUES(?,?,?,?,?,?)',uid('context'),task,actor,json(items.map(v=>({id:v.id,revision:v.revision}))),Buffer.byteLength(json(data)),now());return data;
  }
  conflictGroup(actor,task,start){
    const pending=[start.id],seen=new Set(),items=[];
    while(pending.length){
      const id=pending.pop();if(seen.has(id))continue;if(seen.size>=64)return {items:[],truncated:true};seen.add(id);
      items.push(this.get(actor,task,id));
      const rows=this.all("SELECT left_id,right_id FROM mem_relations WHERE task=? AND kind='contradicts' AND (left_id=? OR right_id=?) LIMIT 65",task,id,id);
      if(rows.length>64)return {items:[],truncated:true};
      for(const r of rows)pending.push(r.left_id===id?r.right_id:r.left_id);
    }
    return {items,truncated:false};
  }
  grantSafe(task,d,grant,seen=new Set()){
    if(seen.has(d.id)||seen.size>128||d.review_state!=='reviewed'||!refs(d).length)return false;seen.add(d.id);
    if(refs(d).some(r=>!grant.includes(r.source_id)))return false;
    return (d.dependency_refs??[]).every(r=>{const dep=this.head(task,r.record_id);return dep.revision===r.revision&&this.grantSafe(task,dep,grant,new Set(seen));});
  }
  export(actor,task){this.own(actor,task);const rows=this.all('SELECT id FROM mem_objects WHERE task=?',task);if(rows.length>500)throw Error('Export too large');const data={schema_version:'0.2',authority:'data-only-export',records:rows.map(r=>this.get(actor,task,r.id)),relations:this.all('SELECT * FROM mem_relations WHERE task=?',task)};if(Buffer.byteLength(json(data))>512*1024)throw Error('Export too large; query pages');return data;}
  health(){try{return {ok:this.q('PRAGMA quick_check').quick_check==='ok',version:'0.2.0',schema:'0.2',index:this.fts,search:'scoped-substring; CJK and identifiers',database:'analysis-state/state.sqlite3',acceptedPromotion:false,projectSharing:false};}catch{return {ok:false,error:'memory_unavailable'};}}
}
