import {createHash} from 'node:crypto';
const hash=s=>createHash('sha256').update(s).digest('hex');
const str={type:'string'},strings={type:'array',maxItems:32,items:str};
export const issueSchema={type:'object',properties:{work:{type:['string','null']},issue:str,disposition:{enum:['continue','waiting','blocked','deferred','out_of_scope']},reason:str,next_step:str,evidence_refs:strings},required:['issue','disposition','reason'],additionalProperties:false};
export const issueUpserts={type:'array',maxItems:32,items:{...issueSchema,properties:{...issueSchema.properties,key:str},required:['key',...issueSchema.required]}};
const text=(v,n,max=2000)=>{if(typeof v!=='string'||!v.trim()||v.length>max)throw Error('Invalid '+n);return v;};
export function normalizeIssue(u){
  if(!u||typeof u!=='object'||Array.isArray(u)||Object.keys(u).some(k=>!Object.hasOwn(issueSchema.properties,k)))throw Error('Invalid unresolved issue');
  if(!issueSchema.properties.disposition.enum.includes(u.disposition))throw Error('Invalid issue disposition');
  const refs=u.evidence_refs??[];if(!Array.isArray(refs)||refs.length>32)throw Error('Invalid issue evidence refs');
  return {work:u.work==null?null:text(u.work,'work ref',200),issue:text(u.issue,'unresolved issue'),disposition:u.disposition,reason:text(u.reason,'issue reason'),next_step:u.next_step==null||u.next_step===''?'':text(u.next_step,'next step'),evidence_refs:[...new Set(refs.map(r=>text(r,'evidence ref',300)))].sort()};
}
const key=k=>{if(typeof k!=='string'||!/^[a-zA-Z0-9][a-zA-Z0-9:._-]{0,119}$/.test(k))throw Error('Invalid issue key');return k;};
export class IssueSets {
  constructor(engine){this.e=engine;engine.store.db.exec(`CREATE TABLE IF NOT EXISTS orch_issue_sets(task TEXT NOT NULL,epoch TEXT NOT NULL,basis TEXT NOT NULL,revision INTEGER NOT NULL,PRIMARY KEY(task,epoch,basis));
    CREATE TABLE IF NOT EXISTS orch_issues(task TEXT NOT NULL,epoch TEXT NOT NULL,basis TEXT NOT NULL,key TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(task,epoch,basis,key));
    CREATE TABLE IF NOT EXISTS orch_issue_snapshots(id TEXT PRIMARY KEY,task TEXT NOT NULL,epoch TEXT NOT NULL,basis TEXT NOT NULL,revision INTEGER NOT NULL,count INTEGER NOT NULL,sha256 TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS orch_issue_snapshot_items(snapshot TEXT NOT NULL,key TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(snapshot,key));`);}
  basis(v){return hash(JSON.stringify(v.basis));}
  revision(r,v){return this.e.store.q('SELECT revision FROM orch_issue_sets WHERE task=? AND epoch=? AND basis=?',r.task,r.epoch,this.basis(v))?.revision??0;}
  *rows(r,v){yield* this.e.store.db.prepare('SELECT key,data FROM orch_issues WHERE task=? AND epoch=? AND basis=? ORDER BY key').iterate(r.task,r.epoch,this.basis(v));}
  command(r,o){
    if(o.upsert!==undefined||o.remove!==undefined)return this.e.store.tx(()=>{
      const s=this.e.store;r=s.run(r.task);if(r.host!==this.e.host)throw Error('Use the owning host');s.own(r.owner,r.task,true);const v=this.e.resolutions.view(r);
      if(o.expected_signature!==v.signature)throw Error('Stale decision signature');
      const revision=this.revision(r,v);if(o.expected_revision!==revision)throw Error('Issue set revision conflict');
      const upsert=o.upsert??[],remove=o.remove??[];
      if(!Array.isArray(upsert)||upsert.length>32||!Array.isArray(remove)||remove.length>32||Buffer.byteLength(JSON.stringify(o))>24576)throw Error('Issue batch too large; send additional bounded batches');
      const keys=new Set();for(const k of remove){key(k);if(keys.has(k))throw Error('Duplicate issue key');keys.add(k);}
      const normalized=upsert.map(u=>{const {key:k,...rest}=u;key(k);if(keys.has(k))throw Error('Duplicate issue key');keys.add(k);const issue=normalizeIssue(rest);if(issue.work&&s.work(r.task,issue.work).epoch!==r.epoch)throw Error('Issue work outside current epoch');this.e.resolutions.validateRefs(r,issue.evidence_refs);return {key:k,data:JSON.stringify(issue)};});
      for(const k of remove)s.sql('DELETE FROM orch_issues WHERE task=? AND epoch=? AND basis=? AND key=?',r.task,r.epoch,this.basis(v),k);
      for(const row of normalized)s.sql('INSERT INTO orch_issues VALUES(?,?,?,?,?) ON CONFLICT(task,epoch,basis,key) DO UPDATE SET data=excluded.data',r.task,r.epoch,this.basis(v),row.key,row.data);
      s.sql('INSERT INTO orch_issue_sets VALUES(?,?,?,?) ON CONFLICT(task,epoch,basis) DO UPDATE SET revision=excluded.revision',r.task,r.epoch,this.basis(v),revision+1);
      this.e.resolutions.reopen(r,v);s.event(r,null,'issues_staged',{revision:revision+1,basis:this.basis(v),upsert:normalized.map(x=>x.key),remove});
      return {issue_set_revision:revision+1,signature:this.e.resolutions.view(s.run(r.task)).signature,basis:this.basis(v)};
    });
    const v=this.e.resolutions.view(r),basis=this.basis(v),revision=this.revision(r,v),frozen=o.issue_set_id;
    if(frozen&&!this.e.store.q('SELECT id FROM orch_issue_snapshots WHERE id=? AND task=? AND epoch=?',frozen,r.task,r.epoch))throw Error('Issue snapshot unavailable');
    const offset=o.offset??0,limit=o.limit??8,budget=o.max_bytes??8192;
    if(!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(limit)||limit<1||limit>32||!Number.isSafeInteger(budget)||budget<2048||budget>24000)throw Error('Invalid issue page');
    const snapshot=frozen??hash(basis+':'+revision);if(o.snapshot!==undefined&&o.snapshot!==snapshot||offset&&!o.snapshot)throw Error('Issue page changed; restart pagination');
    const clause=frozen?'snapshot=?':'task=? AND epoch=? AND basis=?',args=frozen?[frozen]:[r.task,r.epoch,basis],table=frozen?'orch_issue_snapshot_items':'orch_issues';
    const total=this.e.store.q('SELECT COUNT(*) AS n FROM '+table+' WHERE '+clause,...args).n,result={snapshot,issue_set_revision:revision,total,items:[],next_offset:null};
    for(const row of this.e.store.all('SELECT key,data FROM '+table+' WHERE '+clause+' ORDER BY key LIMIT ? OFFSET ?',...args,limit,offset)){
      result.items.push({key:row.key,...JSON.parse(row.data)});result.next_offset=offset+result.items.length<total?offset+result.items.length:null;
      if(Buffer.byteLength(JSON.stringify(result))>budget){result.items.pop();result.next_offset=offset+result.items.length;break;}
    }
    if(!result.items.length&&offset<total)throw Error('Issue exceeds page budget; increase max_bytes or inspect original issue');
    return result;
  }
  reference(r,v,revision){
    if(!Number.isSafeInteger(revision)||revision<0||this.revision(r,v)!==revision)throw Error('Issue set revision conflict');
    let count=0;const h=createHash('sha256');for(const row of this.rows(r,v)){h.update(row.key+'\0'+row.data+'\n');count++;}
    const sha256=h.digest('hex'),basis_key=this.basis(v),id='issues-'+hash([r.task,r.epoch,basis_key,revision,sha256].join('\0'));
    return {id,basis_key,revision,count,sha256};
  }
  freeze(r,v,ref){
    const s=this.e.store;s.sql('INSERT OR IGNORE INTO orch_issue_snapshots VALUES(?,?,?,?,?,?,?)',ref.id,r.task,r.epoch,ref.basis_key,ref.revision,ref.count,ref.sha256);
    s.sql('INSERT OR IGNORE INTO orch_issue_snapshot_items SELECT ?,key,data FROM orch_issues WHERE task=? AND epoch=? AND basis=?',ref.id,r.task,r.epoch,ref.basis_key);
  }
}
