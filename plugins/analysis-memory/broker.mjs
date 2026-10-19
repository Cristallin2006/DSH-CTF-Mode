import {hash} from './store.mjs';

const denied=()=>{throw Error('Memory item unavailable in the current grant');};
const object=(v,keys)=>{if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).some(k=>!keys.includes(k)))throw Error('Invalid restricted memory fields');};
const integer=(v,min,max)=>{if(!Number.isSafeInteger(v)||v<min||v>max)throw Error('Invalid memory page or revision');return v;};
const refs=d=>[...(d.evidence_refs??[]),...(d.details?.input_refs??[]),...(d.acceptance_source_refs??[])];
const project=d=>{
  const out={};for(const k of ['id','revision','target_id','expected_generation','kind','title','body','origin','verification','review_state','applicability','unresolved','accept_scope','observed_at','valid_from','valid_to','recheck_after','details'])if(d[k]!==undefined)out[k]=structuredClone(d[k]);
  const source=r=>({source_id:r.source_id,...(r.content_sha256?{content_sha256:r.content_sha256}:{})});
  out.evidence_refs=(d.evidence_refs??[]).map(source);
  if(out.details?.input_refs)out.details.input_refs=out.details.input_refs.map(source);
  out.dependency_refs=d.dependency_refs??[];return out;
};
function page(value,args,tag){
  const chars=Array.from(value),offset=integer(args.offset??0,0,chars.length),budget=integer(args.max_bytes??8192,512,16384);
  if(offset&&args.snapshot!==tag)throw Error('Memory page changed; restart from offset zero');
  if(args.snapshot!==undefined&&args.snapshot!==tag)throw Error('Memory page changed; restart from offset zero');
  let end=offset,size=0;while(end<chars.length){const n=Buffer.byteLength(JSON.stringify(chars[end]))-2;if(size+n>budget-384)break;size+=n;end++;}
  return {text:chars.slice(offset,end).join(''),offset,next_offset:end<chars.length?end:null,total_codepoints:chars.length,snapshot:tag,offset_unit:'Unicode code points',truncated:end<chars.length};
}
const merge=ranges=>ranges.sort((a,b)=>a[0]-b[0]).reduce((a,r)=>{const last=a.at(-1);if(last&&r[0]<=last[1])last[1]=Math.max(last[1],r[1]);else a.push([...r]);return a;},[]);
export class MemoryReadBroker {
  constructor(store){
    this.s=store;this.closed=false;this.pending=new Set();
    store.db.exec(`CREATE TABLE IF NOT EXISTS mem_solver_grants(work TEXT PRIMARY KEY,task TEXT NOT NULL,owner TEXT NOT NULL,revision INTEGER NOT NULL,data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS mem_solver_receipts(work TEXT NOT NULL,child TEXT NOT NULL,grant_revision INTEGER NOT NULL,kind TEXT NOT NULL,item TEXT NOT NULL,version TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(work,child,grant_revision,kind,item,version));
      CREATE TABLE IF NOT EXISTS mem_solver_changes(seq INTEGER NOT NULL,work TEXT NOT NULL,revision INTEGER NOT NULL,data TEXT NOT NULL,PRIMARY KEY(work,seq));
      INSERT OR IGNORE INTO mem_meta VALUES('solver-broker','1');`);
  }
  alive(){if(this.closed)throw Error('Restricted memory service unavailable');}
  normalize(owner,task,plan){
    this.alive();this.s.own(owner,task,true);object(plan,['bindings','sources']);
    const bindings=plan.bindings??[],sources=plan.sources??[];
    if(!Array.isArray(bindings)||bindings.length>40||!Array.isArray(sources)||sources.length>40)throw Error('Memory grant too large');
    const result={bindings:bindings.map(b=>{object(b,['record_id','revision','use']);integer(b.revision,1,Number.MAX_SAFE_INTEGER);if(!['context','premise','challenge'].includes(b.use))throw Error('Invalid memory binding use');const d=this.s.head(task,b.record_id);if(d.revision!==b.revision||d.review_state!=='reviewed'||!['current','disputed'].includes(this.s.applicable(task,d)))throw Error('Only current reviewed memory revisions can be granted');return {...b};}),sources:sources.map(g=>{
      object(g,['source_id','sha256','access','ranges']);if(!/^src-/.test(g.source_id))throw Error('Only registered src-* snapshots are supported');
      const s=this.s.verifySource(this.s.sourceRow(task,g.source_id));if(s.sha256!==g.sha256)throw Error('Source hash mismatch');
      const length=Array.from(s.body).length;if(!['full','ranges'].includes(g.access))throw Error('Invalid source access');
      if(g.access==='full'){if(g.ranges!==undefined)throw Error('Full source grants do not take ranges');return {source_id:s.id,sha256:s.sha256,access:'full',ranges:[[0,length]]};}
      if(!Array.isArray(g.ranges)||!g.ranges.length||g.ranges.length>16)throw Error('Expected fixed Unicode code point ranges');
      const ranges=g.ranges.map(r=>{if(!Array.isArray(r)||r.length!==2)throw Error('Invalid range');integer(r[0],0,length);integer(r[1],r[0]+1,length);return r;});return {source_id:s.id,sha256:s.sha256,access:'ranges',ranges:merge(ranges)};
    })};
    if(new Set(bindings.map(b=>b.record_id)).size!==bindings.length||new Set(sources.map(s=>s.source_id)).size!==sources.length)throw Error('Duplicate memory grant item');
    return result;
  }
  row(work){const r=this.s.q('SELECT * FROM mem_solver_grants WHERE work=?',work);return r?{...r,data:JSON.parse(r.data)}:null;}
  save(g){this.s.run('INSERT INTO mem_solver_grants VALUES(?,?,?,?,?) ON CONFLICT(work) DO UPDATE SET owner=excluded.owner,revision=excluded.revision,data=excluded.data',g.work,g.task,g.owner,g.revision,JSON.stringify(g.data));}
  event(g,data){this.s.run('INSERT INTO mem_solver_changes(seq,work,revision,data) SELECT COALESCE(MAX(seq),0)+1,?,?,? FROM mem_solver_changes WHERE work=?',g.work,g.revision,JSON.stringify(data),g.work);}
  grant(owner,task,work,plan,expected){
    const normalized=this.normalize(owner,task,plan);
    return this.s.tx(()=>{
      this.s.own(owner,task,true);const old=this.row(work);
      if(old&&(old.task!==task||old.owner!==owner))throw Error('Memory grant revision conflict');
      if(old&&[expected,expected+1].includes(old.revision)&&JSON.stringify(old.data.plan)===JSON.stringify(normalized))return {grant_revision:old.revision,pending_additions:old.data.pending,deduplicated:true};
      if((old?.revision??0)!==expected)throw Error('Memory grant revision conflict');
      const g={work,task,owner,revision:expected+1,data:{plan:normalized,active:old?.data.active??{bindings:[],sources:[]},pending:true,seen:{}}};
      // Revocations are immediate. Additions are published only at a verified step boundary.
      g.data.active.bindings=g.data.active.bindings.filter(b=>normalized.bindings.some(n=>JSON.stringify(n)===JSON.stringify(b)));
      g.data.active.sources=g.data.active.sources.filter(s=>normalized.sources.some(n=>JSON.stringify(n)===JSON.stringify(s)));
      this.save(g);this.event(g,{kind:'grant_changed',grant_revision:g.revision,pending_additions:true});return {grant_revision:g.revision,pending_additions:true};
    });
  }
  authorize(p){
    this.alive();p.check();const g=this.row(p.work);
    if(!g||g.task!==p.task||g.owner!==p.owner||!g.data.binding||['host','epoch','child','turn'].some(k=>g.data.binding[k]!==p[k]))denied();
    this.s.own(p.owner,p.task,true);return g;
  }
  boundary(p){
    this.alive();p.check();const g=this.row(p.work);if(!g||g.owner!==p.owner||g.task!==p.task)denied();this.s.own(p.owner,p.task,true);
    g.data.binding={host:p.host,epoch:p.epoch,child:p.child,turn:p.turn};
    if(g.data.pending){g.data.active=g.data.plan;g.data.pending=false;}
    this.save(g);return this.status(p);
  }
  safeRecord(g,id){
    const grant=g.data.active.bindings.find(b=>b.record_id===id);if(!grant)denied();
    let d;try{d=this.s.head(g.task,id);}catch{denied();}
    if(d.revision!==grant.revision||d.review_state!=='reviewed'||!['current','disputed'].includes(this.s.applicable(g.task,d)))denied();
    const visited=new Set(),walk=v=>{
      if(visited.has(v.id))return true;if(visited.size>=64)return false;visited.add(v.id);
      const deps=(v.dependency_refs??[]).map(r=>({id:r.record_id,revision:r.revision}));
      for(const rel of this.s.all("SELECT left_id,right_id FROM mem_relations WHERE task=? AND kind='contradicts' AND (left_id=? OR right_id=?)",g.task,v.id,v.id))deps.push({id:rel.left_id===v.id?rel.right_id:rel.left_id});
      for(const ref of deps){const b=g.data.active.bindings.find(b=>b.record_id===ref.id);if(!b||ref.revision&&b.revision!==ref.revision)return false;let peer;try{peer=this.s.head(g.task,ref.id);}catch{return false;}if(peer.revision!==b.revision||peer.review_state!=='reviewed'||!['current','disputed'].includes(this.s.applicable(g.task,peer))||!walk(peer))return false;}return true;
    };
    if(!walk(d))throw Error('Current grant is insufficient for a complete evidence check');
    return {...project(d),effective_applicability:this.s.applicable(g.task,d),binding_use:grant.use,authority:'reviewed memory data; not independently verified source evidence'};
  }
  sync(g){
    let changed=false;for(const b of g.data.active.bindings){let state;try{const d=this.s.head(g.task,b.record_id);state={revision:d.revision,applicability:this.s.applicable(g.task,d),review_state:d.review_state};}catch{state={available:false};}
      const signature=JSON.stringify(state);if(g.data.seen[b.record_id]!==signature){g.data.seen[b.record_id]=signature;this.event(g,{kind:'record_state',record_id:b.record_id,...state});changed=true;}}
    for(const source of g.data.active.sources){let valid=false;try{valid=this.s.verifySource(this.s.sourceRow(g.task,source.source_id)).sha256===source.sha256;}catch{}
      const key='source:'+source.source_id,signature=JSON.stringify({sha256:source.sha256,valid});if(g.data.seen[key]!==signature){g.data.seen[key]=signature;this.event(g,{kind:'source_state',source_id:source.source_id,sha256:source.sha256,valid});changed=true;}}
    if(changed)this.save(g);
  }
  status(p,args={}){
    const g=this.authorize(p);this.sync(g);
    const records=g.data.active.bindings.map(b=>({type:'record',record_id:b.record_id,revision:b.revision,use:b.use,current:JSON.parse(g.data.seen[b.record_id]??'{}')})),sources=g.data.active.sources.map(s=>({type:'source',source_id:s.source_id,sha256:s.sha256,access:s.access,current:JSON.parse(g.data.seen['source:'+s.source_id]??'{}')})),items=[...records,...sources];
    const offset=integer(args.offset??0,0,items.length),limit=integer(args.limit??8,1,20),budget=integer(args.max_bytes??8192,512,16384),snapshot=hash(JSON.stringify([g.revision,items]));
    if(offset&&args.snapshot!==snapshot||args.snapshot!==undefined&&args.snapshot!==snapshot)throw Error('Memory page changed; restart from offset zero');
    const out={available:true,grant_revision:g.revision,pending_additions:g.data.pending,records:[],sources:[],latest_seq:this.s.q('SELECT COALESCE(MAX(seq),0) AS n FROM mem_solver_changes WHERE work=?',p.work).n,snapshot,next_offset:null,index_truncated:false,authority:'scope and actual delivery metadata; not understanding',supported_sources:['src-*'],offset_unit:'Unicode code points'};
    let count=0;for(const item of items.slice(offset,offset+limit)){const list=item.type==='record'?out.records:out.sources;list.push(item);if(Buffer.byteLength(JSON.stringify(out))>budget-100){list.pop();break;}count++;}
    if(offset+count<items.length){if(!count)throw Error('Memory status budget too small for one item');out.next_offset=offset+count;out.index_truncated=true;}if(Buffer.byteLength(JSON.stringify(out))>budget)throw Error('Memory status budget too small');return out;
  }
  receipt(p,g,kind,id,version,range,total,persist=true){
    const old=this.s.q('SELECT data FROM mem_solver_receipts WHERE work=? AND child=? AND grant_revision=? AND kind=? AND item=? AND version=?',p.work,p.child,g.revision,kind,id,version);
    const ranges=merge([...(old?JSON.parse(old.data).ranges:[]),range]);const data={ranges,total,full:ranges.length===1&&ranges[0][0]===0&&ranges[0][1]===total};
    if(persist)this.s.run('INSERT OR REPLACE INTO mem_solver_receipts VALUES(?,?,?,?,?,?,?)',p.work,p.child,g.revision,kind,id,version,JSON.stringify(data));return data;
  }
  async read(p,args){
    const promise=this.readNow(p,args);this.pending.add(promise);try{return await promise;}finally{this.pending.delete(promise);}
  }
  async readNow(p,args){
    const fields={status:['offset','limit','max_bytes','snapshot'],query:['query','offset','limit','max_bytes','snapshot'],get:['record_id','expected_revision','offset','max_bytes','snapshot'],read_source:['source_id','expected_hash','range_index','offset','max_bytes','snapshot'],changes:['after_seq','limit','max_bytes']}[args.action];
    if(!fields)throw Error('Invalid restricted memory action');object(args,['action',...fields]);
    const g=this.authorize(p);this.sync(g);const revision=g.revision;let out,receipt;
    if(args.action==='status')out=this.status(p,args);
    if(args.action==='query'){
      if(args.query!==undefined&&(typeof args.query!=='string'||args.query.length>200))throw Error('Invalid query');
      const items=[];for(const b of g.data.active.bindings){try{const d=this.safeRecord(g,b.record_id);if(!args.query||(d.title+'\n'+d.body).toLowerCase().includes(args.query.toLowerCase()))items.push({id:d.id,revision:d.revision,kind:d.kind,title:d.title,origin:d.origin,verification:d.verification,applicability:d.effective_applicability});}catch{}}
      const tag=hash(JSON.stringify({revision,items}));const offset=integer(args.offset??0,0,items.length),limit=integer(args.limit??20,1,20),budget=integer(args.max_bytes??8192,512,16384);
      if(offset&&args.snapshot!==tag||args.snapshot!==undefined&&args.snapshot!==tag)throw Error('Memory page changed; restart from offset zero');
      const selected=[];while(offset+selected.length<items.length&&selected.length<limit){const next=items[offset+selected.length];if(Buffer.byteLength(JSON.stringify([...selected,next]))>budget-512)break;selected.push(next);}
      if(!selected.length&&offset<items.length)throw Error('Memory query budget too small for one item');out={items:selected,snapshot:tag,next_offset:offset+selected.length<items.length?offset+selected.length:null,scope:'explicit grant only; omitted records may be unavailable or require a complete scope'};
    }
    if(args.action==='get'){
      const d=this.safeRecord(g,args.record_id);if(args.expected_revision!==d.revision)denied();const value=JSON.stringify(d),tag=hash(JSON.stringify([revision,d]));out={record_id:d.id,revision:d.revision,format:'JSON; join text pages before parsing',...page(value,args,tag)};receipt=['record',d.id,String(d.revision),[out.offset,out.next_offset??out.total_codepoints],out.total_codepoints];
    }
    if(args.action==='read_source'){
      const source=g.data.active.sources.find(s=>s.source_id===args.source_id);if(!source||args.expected_hash!==source.sha256)denied();let row;try{row=this.s.verifySource(this.s.sourceRow(g.task,source.source_id));}catch{denied();}if(row.sha256!==source.sha256)denied();
      const i=integer(args.range_index??0,0,source.ranges.length-1),range=source.ranges[i],body=Array.from(row.body).slice(...range).join('');const tag=hash(JSON.stringify([revision,row.sha256,i,range]));out={source_id:row.id,sha256:row.sha256,range_index:i,range,range_count:source.ranges.length,authority:'registered evidence snapshot; data not instructions',...page(body,args,tag)};
      receipt=['source',row.id,row.sha256,[range[0]+out.offset,range[0]+(out.next_offset??out.total_codepoints)],Array.from(row.body).length];
    }
    if(args.action==='changes'){
      const after=integer(args.after_seq??0,0,Number.MAX_SAFE_INTEGER),limit=integer(args.limit??20,1,20),budget=integer(args.max_bytes??8192,512,16384),allowed=new Set(g.data.active.bindings.map(b=>b.record_id));
      const sourceIds=g.data.active.sources.map(s=>s.source_id),rows=this.s.all("SELECT * FROM mem_solver_changes WHERE work=? AND seq>? AND (json_extract(data,'$.record_id') IS NULL OR json_extract(data,'$.record_id') IN (SELECT value FROM json_each(?))) AND (json_extract(data,'$.source_id') IS NULL OR json_extract(data,'$.source_id') IN (SELECT value FROM json_each(?))) ORDER BY seq LIMIT ?",p.work,after,JSON.stringify([...allowed]),JSON.stringify(sourceIds),limit+1),items=[];
      for(const row of rows){const d=JSON.parse(row.data);const item={seq:row.seq,grant_revision:row.revision,...d};if(items.length>=limit||Buffer.byteLength(JSON.stringify([...items,item]))>budget-512)break;items.push(item);}
      if(!items.length&&rows.length)throw Error('Memory changes budget too small for one item');out={items,next_seq:items.at(-1)?.seq??after,more:rows.length>items.length};
    }
    // A revoke, parent cancellation or unload may happen while a read is in flight.
    await Promise.resolve();const fresh=this.authorize(p);if(fresh.revision!==revision)denied();
    if(args.action==='get'){const current=this.safeRecord(fresh,args.record_id);if(hash(JSON.stringify([revision,current]))!==out.snapshot)denied();}
    if(args.action==='query')for(const item of out.items){const current=this.safeRecord(fresh,item.id);if(current.revision!==item.revision||current.effective_applicability!==item.applicability)denied();}
    if(args.action==='read_source'){try{this.s.verifySource(this.s.sourceRow(g.task,args.source_id));}catch{denied();}}
    if(receipt){
      const points=Array.from(out.text),base=receipt[3][0],budget=args.max_bytes??8192;
      const fit=n=>{const candidate={...out,text:points.slice(0,n).join(''),next_offset:out.offset+n<out.total_codepoints?out.offset+n:null,truncated:out.offset+n<out.total_codepoints};const range=[base,base+n],coverage=this.receipt(p,g,...receipt.slice(0,3),range,receipt[4],false);return {candidate,range,coverage,bytes:Buffer.byteLength(JSON.stringify({...candidate,read_coverage:coverage}))};};
      let lo=0,hi=points.length;while(lo<hi){const mid=Math.ceil((lo+hi)/2);if(fit(mid).bytes<=budget)lo=mid;else hi=mid-1;}
      const fitted=fit(lo);if(fitted.bytes>budget||!lo&&points.length)throw Error('Memory page budget too small; increase max_bytes');
      out=fitted.candidate;out.read_coverage=this.receipt(p,g,...receipt.slice(0,3),fitted.range,receipt[4]);
    }
    if(args.action==='query')for(const item of out.items)this.receipt(p,g,'index',item.id,String(item.revision),[0,1],1);
    return out;
  }
  coverage(owner,task,work,sources=[]){
    this.alive();this.s.own(owner,task);const g=this.row(work);if(!g||g.task!==task||g.owner!==owner)return {enabled:false};
    const rows=this.s.all("SELECT item,version,data FROM mem_solver_receipts WHERE work=? AND child=? AND grant_revision=? AND kind='source'",work,g.data.binding?.child??'',g.revision);
    return {enabled:true,grant_revision:g.revision,required_sources:sources.map(id=>{
      const source=g.data.active.sources.find(s=>s.source_id===id),read=rows.filter(r=>r.item===id&&r.version===source?.sha256).map(r=>JSON.parse(r.data)),ranges=merge(read.flatMap(r=>r.ranges));
      let current=false;try{current=!!source&&this.s.verifySource(this.s.sourceRow(task,id)).sha256===source.sha256;}catch{}
      const snapshot_full_read=!!source&&ranges.length===1&&ranges[0][0]===0&&ranges[0][1]===read[0]?.total;
      return {source_id:id,source_current:current,snapshot_full_read,full_read:current&&snapshot_full_read,ranges};
    }),authority:'actual returned source ranges under this grant and child; not understanding'};
  }
  async close(){this.closed=true;await Promise.allSettled([...this.pending]);}
}
