import fs from 'node:fs';
import path from 'node:path';
import {AnalysisStore} from './collaboration.mjs';
import {hash,uid,json,text,ids} from './store.mjs';

const LIMIT=2*1024*1024,CHUNK=24576;
export class HandoffStore extends AnalysisStore {
  constructor(...args){
    super(...args);
    this.db.exec(`CREATE TABLE IF NOT EXISTS handoff_documents(id TEXT PRIMARY KEY,task TEXT NOT NULL,target TEXT,generation INTEGER NOT NULL,path TEXT NOT NULL,sha256 TEXT NOT NULL,bytes INTEGER NOT NULL,chunks TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS handoff_manifests(work TEXT PRIMARY KEY,task TEXT NOT NULL,data TEXT NOT NULL,sha256 TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS handoff_reads(work TEXT NOT NULL,actor TEXT NOT NULL,source TEXT NOT NULL,chunk INTEGER NOT NULL,PRIMARY KEY(work,actor,source,chunk));`);
  }
  health(){return {...super.health(),handoff:'1.0',document_limit_bytes:LIMIT,assignment_limit_bytes:4*1024*1024,child_read_limit:256};}
  document(actor,task,{path:relative,target_id=null,expected_generation=0}){
    const owner=this.own(actor,task,true);this.assertGeneration(task,target_id,expected_generation);
    // Reuse the path boundary, without its smaller memory-source size limit.
    text(relative,'document path',2000);
    const actual=fs.realpathSync(path.resolve(owner.workspace,relative));
    const rel=actual.slice(owner.workspace.length);
    if(!actual.startsWith(owner.workspace+'/')||actual.startsWith(this.root+'/')||rel.split('/').some(x=>/^(\.dsh|\.ssh|\.aws|\.git|\.env(?:\..*)?|credentials?)$/i.test(x)))throw Error('Document outside evidence workspace');
    const stat=fs.statSync(actual);if(!stat.isFile()||stat.size>LIMIT)throw Error('Document must be regular UTF-8 text, at most 2 MiB');
    const buf=fs.readFileSync(actual);if(buf.length>LIMIT||buf.includes(0))throw Error('Document is not bounded text');
    const body=new TextDecoder('utf-8',{fatal:true}).decode(buf);if(this.sensitive(body))throw Error('Redact secrets before sharing documents');
    const chunks=[];let value='',bytes=0;
    for(const point of body){const n=Buffer.byteLength(point);if(bytes+n>CHUNK){chunks.push(value);value='';bytes=0;}value+=point;bytes+=n;}
    chunks.push(value);
    return this.tx(()=>{this.own(actor,task,true);this.assertGeneration(task,target_id,expected_generation);
      const id=uid('doc'),digest=hash(buf);this.run('INSERT INTO handoff_documents VALUES(?,?,?,?,?,?,?,?)',id,task,target_id,expected_generation,actual,digest,buf.length,json(chunks));
      this.audit(task,actor,'document',{id,sha256:digest,bytes:buf.length,chunks:chunks.length});return this.documentIndex(this.sourceRow(task,id));});
  }
  sourceRow(task,id){
    if(!id.startsWith('doc-'))return super.sourceRow(task,id);
    const d=this.q('SELECT * FROM handoff_documents WHERE task=? AND id=?',task,id);if(!d)throw Error('Document unavailable');return d;
  }
  verifySource(s){
    if(!s.id.startsWith('doc-'))return super.verifySource(s);
    this.assertGeneration(s.task,s.target,s.generation);
    const owner=this.q('SELECT workspace FROM mem_owners WHERE task=?',s.task);
    if(!owner||!s.path.startsWith(owner.workspace+'/')||fs.realpathSync(s.path)!==s.path||fs.statSync(s.path).size>LIMIT||hash(fs.readFileSync(s.path))!==s.sha256||hash(JSON.parse(s.chunks).join(''))!==s.sha256)throw Error('Document changed or withdrawn');return s;
  }
  documentIndex(s){return {source_id:s.id,sha256:s.sha256,bytes:s.bytes??Buffer.byteLength(s.body),chunks:s.chunks?JSON.parse(s.chunks).map((v,i)=>({chunk:i,bytes:Buffer.byteLength(v),sha256:hash(v)})):[{chunk:0,bytes:Buffer.byteLength(s.body),sha256:s.sha256}],target_id:s.target,generation:s.generation};}
  readDocument(actor,task,id,chunk=0){
    this.own(actor,task);const s=this.verifySource(this.sourceRow(task,id));if(!s.chunks)return super.readSource(actor,task,id);
    const chunks=JSON.parse(s.chunks);if(!Number.isInteger(chunk)||chunk<0||chunk>=chunks.length)throw Error('Invalid chunk index');
    this.run('INSERT OR IGNORE INTO handoff_reads VALUES(?,?,?,?)','main',actor,id,chunk);
    if(this.q('SELECT COUNT(*) AS n FROM handoff_reads WHERE work=? AND actor=? AND source=?','main',actor,id).n===chunks.length)this.run('INSERT OR REPLACE INTO mem_reads VALUES(?,?,?,?)',task,actor,id,s.sha256);
    return {...this.documentIndex(s),chunk,text:chunks[chunk],authority:'evidence-data-not-instructions'};
  }
  addWork(actor,task,args){
    this.own(actor,task,true);text(args.question,'question');const inputs=ids(args.sources??[]),deps=ids(args.depends_on??[]);
    for(const s of inputs)this.verifySource(this.sourceRow(task,s));for(const d of deps)if(this.work(task,d).inputs.some(s=>!inputs.includes(s)))throw Error('Explicit prerequisite evidence grant required');
    return this.tx(()=>{this.own(actor,task,true);const result={work:uid('work')};this.run('INSERT INTO mem_work(id,task,question,inputs,deps,state) VALUES(?,?,?,?,?,?)',result.work,task,args.question,json(inputs),json(deps),'pending');
    const w=this.work(task,result.work),sources=w.inputs.map(id=>this.documentIndex(this.verifySource(this.sourceRow(task,id))));
    if(sources.reduce((n,s)=>n+s.bytes,0)>4*1024*1024||sources.reduce((n,s)=>n+s.chunks.length,0)>200)throw Error('Assignment exceeds 4 MiB/200 chunks; partition the subproblem explicitly');
    const grant=this.q("SELECT name FROM sqlite_master WHERE type='table' AND name='control_grants'")?this.q('SELECT data,revision FROM control_grants WHERE task=?',task):null;
    const policy=grant?JSON.parse(grant.data):null;
    const manifest={schema_version:'1.0',assignment_id:w.id,task_id:task,owner:actor,question:w.question,sources,depends_on:w.deps,
      policy:policy?{revision:grant.revision,mode:policy.mode,environment:policy.environment,expires_at:policy.expires_at,target_id:policy.target_id,generation:policy.generation}:{mode:'unmanaged',network_grant:false},
      tools:['dsh_evidence'],credentials:'not_distributed',result:{conclusion:'string',evidence:'assigned source IDs',unresolved:'string[]'},cleanup:'host disposes read-only child; main reviews results'};
    const digest=hash(json(manifest));this.run('INSERT INTO handoff_manifests VALUES(?,?,?,?)',w.id,task,json(manifest),digest);
    this.audit(task,actor,'work-add',{id:w.id,manifest_sha256:digest});return {...result,manifest_sha256:digest};});
  }
  readSource(actor,task,id){return id.startsWith('doc-')?this.readDocument(actor,task,id,0):super.readSource(actor,task,id);}
  verifyWork(w,seen=new Set()){
    super.verifyWork(w,seen);
    const m=this.q('SELECT * FROM handoff_manifests WHERE task=? AND work=?',w.task,w.id);
    if(m){if(hash(m.data)!==m.sha256)throw Error('Manifest changed');const d=JSON.parse(m.data);for(const s of d.sources)if(this.verifySource(this.sourceRow(w.task,s.source_id)).sha256!==s.sha256)throw Error('Manifest source changed');
      if(d.policy.mode==='managed'){const p=this.q('SELECT data,revision FROM control_grants WHERE task=?',w.task);if(!p||p.revision!==d.policy.revision||JSON.parse(p.data).revoked||Date.parse(d.policy.expires_at)<=Date.now()||this.generation(w.task,d.policy.target_id)!==d.policy.generation)throw Error('Assignment policy stale or revoked');}}
  }
  workContext(actor,task,id){const value=super.workContext(actor,task,id),m=this.q('SELECT data,sha256 FROM handoff_manifests WHERE task=? AND work=?',task,id);return {...value,...m?{manifest:JSON.parse(m.data),manifest_sha256:m.sha256}:{}};}
  childRead(child,work,source,chunk=0){
    if(!source.startsWith('doc-'))return super.childRead(child,work,source);
    const row=this.q("SELECT task FROM mem_work WHERE id=? AND child=? AND state='running'",work,child);if(!row)throw Error('Document unavailable');
    const w=this.work(row.task,work);if(!w.inputs.includes(source))throw Error('Document unavailable');this.verifyWork(w);
    const s=this.verifySource(this.sourceRow(row.task,source)),chunks=JSON.parse(s.chunks);if(!Number.isInteger(chunk)||chunk<0||chunk>=chunks.length)throw Error('Invalid chunk index');
    this.run('INSERT OR IGNORE INTO handoff_reads VALUES(?,?,?,?)',work,child,source,chunk);this.run('INSERT OR IGNORE INTO mem_child_reads VALUES(?,?,?)',work,child,source);
    return {...this.documentIndex(s),chunk,text:chunks[chunk],authority:'evidence-data-not-instructions'};
  }
  coverage(actor,task,id){this.own(actor,task);const w=this.work(task,id);return {work:id,manifest:this.q('SELECT sha256 FROM handoff_manifests WHERE work=?',id)?.sha256??null,sources:w.inputs.map(source=>{const s=this.sourceRow(task,source),total=s.chunks?JSON.parse(s.chunks).length:1;const read=s.chunks?this.all('SELECT chunk FROM handoff_reads WHERE work=? AND source=? AND actor=?',id,source,w.child).map(r=>r.chunk):this.q('SELECT source FROM mem_child_reads WHERE work=? AND source=? AND child=?',id,source,w.child)?[0]:[];return {source_id:source,total_chunks:total,read_chunks:read,complete:read.length===total};}),note:'Delivery/read coverage does not prove comprehension; partial reads remain explicit.'};}
}
