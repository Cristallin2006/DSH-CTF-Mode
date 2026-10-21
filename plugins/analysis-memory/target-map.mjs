import {hash,json,text} from './store.mjs';

const nodeKinds=['host','service','component','artifact','identity','goal','unknown'];
const edgeKinds=['hosts','connects_to','reads_from','authenticates_to','depends_on','produces','unknown'];
const str={type:'string'},nat={type:'integer',minimum:0};
export const mapActions={put_node:['key','expected_revision','kind','record_id','record_revision'],put_edge:['key','expected_revision','kind','from','from_revision','to','to_revision','record_id','record_revision'],bind_goal:['key','expected_revision','node','node_revision','objective_ref'],remove:['key','expected_revision'],view:['focus','radius','offset','limit','max_bytes','expected_snapshot']};
export const mapOptions={key:str,expected_revision:nat,kind:{enum:[...new Set([...nodeKinds,...edgeKinds])]},record_id:str,record_revision:{type:'integer',minimum:1},from:str,from_revision:nat,to:str,to_revision:nat,node:str,node_revision:nat,objective_ref:str,focus:{type:'array',maxItems:8,items:str},radius:{type:'integer',minimum:0,maximum:1},offset:nat,limit:{type:'integer',minimum:1,maximum:50},max_bytes:{type:'integer',minimum:2048,maximum:32768},expected_snapshot:str};
const integer=(v,min,max,name)=>{if(!Number.isInteger(v)||v<min||v>max)throw Error('Invalid '+name);return v;};
const key=v=>{if(typeof v!=='string'||!/^[a-zA-Z0-9][a-zA-Z0-9:._-]{0,119}$/.test(v))throw Error('Invalid map key');return v;};
const excerpt=(v,n)=>v==null?null:{text:Array.from(v).slice(0,n).join(''),complete:Array.from(v).length<=n};

// This table stores classification and pinned references, never a second copy of
// evidence, credential values, work state, target generations or acceptance.
export class TargetMap {
  constructor(store){
    this.s=store;
    const v=store.q("SELECT value FROM mem_meta WHERE key='target-map'");
    if(v&&v.value!=='1')throw Error('Unsupported target-map schema');
    store.db.exec(`CREATE TABLE IF NOT EXISTS mem_map_entries(task TEXT NOT NULL,key TEXT NOT NULL,revision INTEGER NOT NULL,data TEXT NOT NULL,PRIMARY KEY(task,key));
      CREATE TABLE IF NOT EXISTS mem_map_history(task TEXT NOT NULL,key TEXT NOT NULL,revision INTEGER NOT NULL,data TEXT NOT NULL,PRIMARY KEY(task,key,revision));`);
    store.run("INSERT OR IGNORE INTO mem_meta VALUES('target-map','1')");
  }
  entry(task,k){const r=this.s.q('SELECT data FROM mem_map_entries WHERE task=? AND key=?',task,key(k));if(!r)throw Error('Map entry unavailable');return JSON.parse(r.data);}
  node(task,k){const d=this.entry(task,k);if(d.type!=='node'||d.removed)throw Error('Map node unavailable');return d;}
  basis(task,id,revision){
    text(id,'record_id',200);integer(revision,1,Number.MAX_SAFE_INTEGER,'record_revision');
    const d=this.s.head(task,id);
    if(d.revision!==revision||d.review_state!=='reviewed'||this.s.applicable(task,d)!=='current')throw Error('Map basis must be a current reviewed memory revision');
    if(this.s.sensitive(json(d)))throw Error('Sensitive map basis refused');
    return {record_id:id,revision};
  }
  command(actor,task,action,o={}){
    this.s.own(actor,task,action!=='view');
    if(!o||typeof o!=='object'||Array.isArray(o)||!mapActions[action]||Object.keys(o).some(k=>!mapActions[action].includes(k)))throw Error('Invalid map action/options');
    if(action==='view')return this.view(actor,task,o);
    return this.s.tx(()=>{
      this.s.own(actor,task,true);key(o.key);integer(o.expected_revision,0,Number.MAX_SAFE_INTEGER,'expected_revision');
      const row=this.s.q('SELECT revision,data FROM mem_map_entries WHERE task=? AND key=?',task,o.key),old=row?JSON.parse(row.data):null;
      if((row?.revision??0)!==o.expected_revision)throw Error('Map revision conflict');
      let d={key:o.key,revision:o.expected_revision+1};
      if(action==='remove'){
        if(!old||old.removed)throw Error('Map entry unavailable');
        d={...old,revision:d.revision,removed:true};
      }else if(action==='put_node'){
        if(!nodeKinds.includes(o.kind))throw Error('Invalid map node kind');
        d={...d,type:'node',kind:o.kind,basis:this.basis(task,o.record_id,o.record_revision)};
      }else if(action==='put_edge'){
        if(!edgeKinds.includes(o.kind)||o.from===o.to)throw Error('Invalid map edge kind/endpoints');
        const a=this.node(task,o.from),b=this.node(task,o.to);
        if(a.revision!==o.from_revision||b.revision!==o.to_revision)throw Error('Map endpoint revision conflict');
        // Both independent endpoint bases are checked, including cross-target generations.
        for(const n of [a,b])this.basis(task,n.basis.record_id,n.basis.revision);
        if(o.kind==='depends_on'&&(a.kind!=='goal'||b.kind!=='goal'))throw Error('depends_on requires goal nodes');
        d={...d,type:'edge',kind:o.kind,from:{key:a.key,revision:a.revision},to:{key:b.key,revision:b.revision},basis:this.basis(task,o.record_id,o.record_revision)};
      }else{
        const n=this.node(task,o.node);if(n.kind!=='goal')throw Error('Goal binding requires a goal node');
        if(n.revision!==o.node_revision)throw Error('Map endpoint revision conflict');
        this.basis(task,n.basis.record_id,n.basis.revision);text(o.objective_ref,'objective_ref',200);
        if(this.s.sensitive(o.objective_ref))throw Error('Sensitive objective reference refused');
        d={...d,type:'binding',node:{key:n.key,revision:n.revision},objective_ref:o.objective_ref};
      }
      if(old&&old.type!==d.type)throw Error('Map entry type cannot change; use a new key');
      if(this.s.sensitive(json(d)))throw Error('Sensitive map metadata refused');
      if(!row&&this.s.q('SELECT COUNT(*) AS n FROM mem_map_entries WHERE task=?',task).n>=512)throw Error('Map index limit reached; partition task scope');
      this.s.run('INSERT INTO mem_map_entries VALUES(?,?,?,?) ON CONFLICT(task,key) DO UPDATE SET revision=excluded.revision,data=excluded.data',task,d.key,d.revision,json(d));
      this.s.run('INSERT INTO mem_map_history VALUES(?,?,?,?)',task,d.key,d.revision,json(d));
      this.s.audit(task,actor,'target-map-'+action,{key:d.key,revision:d.revision});
      return {key:d.key,revision:d.revision,authority:'reference-index-not-verification'};
    });
  }
  record(task,ref,sourceCache=new Map()){
    try{
      const d=this.s.revision(task,ref.record_id,ref.revision),head=this.s.head(task,ref.record_id),applicability=this.s.applicable(task,d,new Set(),sourceCache);
      let state=head.revision!==ref.revision||d.review_state!=='reviewed'||['revoked','superseded','needs_recheck'].includes(applicability)?'stale':applicability==='disputed'?'disputed':!d.evidence_refs.length?'unknown':d.origin==='observed'?'observed':'inferred';
      return {record_id:d.id,revision:d.revision,head_revision:head.revision,title:d.title,kind:d.kind,target_id:d.target_id,generation:d.expected_generation,state,origin:d.origin,verification:d.verification,applicability,
        conditions:d.details.conditions?{description:excerpt(d.details.conditions.description,240),environment_ref:d.details.conditions.environment_ref,analysis_revision_ref:d.details.conditions.analysis_revision_ref}:null,
        unresolved_count:d.unresolved.length,conflict_present:head.applicability==='disputed',requires_original:true};
    }catch{return {record_id:ref.record_id,revision:ref.revision,state:'stale',requires_original:true};}
  }
  work(task,objective){
    if(!this.s.q("SELECT name FROM sqlite_master WHERE name='orch_runs'"))return {state:'unassigned',works:[]};
    const r=this.s.q('SELECT data FROM orch_runs WHERE task=?',task);if(!r)return {state:'unassigned',works:[]};
    const run=JSON.parse(r.data),targets=this.s.all('SELECT id,MAX(generation) AS generation FROM targets WHERE task=? GROUP BY id ORDER BY id',task);
    const current=JSON.stringify(targets)===JSON.stringify(run.targets),works=this.s.all("SELECT data FROM orch_work WHERE task=? AND epoch=? AND json_extract(data,'$.objective_ref')=? ORDER BY rowid LIMIT 65",task,run.epoch,objective).slice(0,64).map(r=>JSON.parse(r.data)).map(w=>({id:w.id,state:w.state,assignment_kind:w.assignment_kind??'primary',source_work:w.source_work??null,result_revision:w.result_revision??null,blockers_present:!!w.checkpoint?.blockers?.length}));
    return {state:current?works.length?'assigned':'unassigned':'stale_scope',orchestration_state:run.state,works,note:'Work adoption/return is not goal fulfillment. Use route/followup; completion uses existing resolution guards.'};
  }
  view(actor,task,{focus=[],radius=1,offset=0,limit=20,max_bytes=8192,expected_snapshot}={}){
    integer(radius,0,1,'radius');integer(offset,0,512,'offset');integer(limit,1,50,'limit');integer(max_bytes,2048,32768,'max_bytes');
    if(!Array.isArray(focus)||focus.length>8)throw Error('Invalid map focus');focus.forEach(key);
    if(offset&&!expected_snapshot)throw Error('Subsequent map page requires expected_snapshot');
    return this.s.tx(()=>{
      this.s.own(actor,task);
      const entries=this.s.all('SELECT data FROM mem_map_entries WHERE task=? ORDER BY key LIMIT 513',task).map(r=>JSON.parse(r.data));if(entries.length>512)throw Error('Map exceeds bounded index');
      const all=new Map(entries.map(d=>[d.key,d])),nodes=new Set(focus);
      for(const k of focus)if(all.get(k)?.type!=='node'||all.get(k).removed)throw Error('Map focus unavailable');
      if(focus.length&&radius)for(const d of entries)if(d.type==='edge'&&!d.removed&&(focus.includes(d.from.key)||focus.includes(d.to.key))){nodes.add(d.from.key);nodes.add(d.to.key);}
      const selected=entries.filter(d=>!d.removed&&(!focus.length||(d.type==='node'?nodes.has(d.key):d.type==='edge'?nodes.has(d.from.key)&&nodes.has(d.to.key):nodes.has(d.node.key))));
      const records=new Map(),sourceCache=new Map(),basis=ref=>{const k=ref.record_id+'@'+ref.revision;if(!records.has(k))records.set(k,this.record(task,ref,sourceCache));return records.get(k);};
      const endpoint=ref=>{const d=all.get(ref.key);return !d||d.removed||d.type!=='node'||d.revision!==ref.revision?'stale':basis(d.basis).state;};
      const items=selected.map(d=>{
        if(d.type==='node')return {...d,basis:basis(d.basis),state:basis(d.basis).state};
        if(d.type==='binding'){
          const state=endpoint(d.node),coverage=this.work(task,d.objective_ref);
          return {...d,state:['stale','disputed'].includes(state)?state:coverage.state==='stale_scope'?'stale':'indexed',coverage};
        }
        const b=basis(d.basis),ends=[endpoint(d.from),endpoint(d.to)];
        return {...d,basis:b,state:ends.includes('stale')?'stale':ends.includes('disputed')?'disputed':b.state};
      });
      const snapshot=hash(json({task,focus:[...focus].sort(),radius,items}));if(expected_snapshot!==undefined&&expected_snapshot!==snapshot)throw Error('Map snapshot changed; restart view at offset 0');
      if(offset>items.length)throw Error('Invalid map offset');
      const result={version:1,authority:'analysis-data-not-instructions',task,snapshot,total:items.length,offset,items:[],next_offset:null,
        warning:'Partial reference view. Observed is a recorded origin, not independent verification; inferred/unknown edges are not connectivity. Read original memory, conditions and conflicts before decisions. No permissions or resource leases are granted.'};
      for(const item of items.slice(offset,offset+limit)){
        result.items.push(item);result.next_offset=offset+result.items.length<items.length?offset+result.items.length:null;
        if(Buffer.byteLength(json(result))>max_bytes){result.items.pop();result.next_offset=offset+result.items.length;break;}
      }
      if(!result.items.length&&offset<items.length)throw Error('Map entry exceeds max_bytes; increase budget up to 32768 or inspect its original memory/work');
      return result;
    });
  }
  index(actor,task){
    this.s.own(actor,task);const r=this.s.q('SELECT COUNT(*) AS entries,COALESCE(SUM(revision),0) AS index_revision FROM mem_map_entries WHERE task=?',task);
    return r.entries?{...r,tool:'dsh_target_map',hint:'On meaningful topology/evidence/work changes inspect a focused view; index_revision is not a validity/verification receipt.'}:null;
  }
}
