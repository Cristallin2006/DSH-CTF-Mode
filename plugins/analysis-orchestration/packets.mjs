import {createHash} from 'node:crypto';
import {resultPage} from './views.mjs?revision=0.8.0';
const digest=s=>createHash('sha256').update(s).digest('hex');
const bytes=v=>Buffer.byteLength((typeof v==='string'?v:JSON.stringify(v))??'');
const merge=ranges=>ranges.sort((a,b)=>a[0]-b[0]).reduce((out,r)=>{const last=out.at(-1);if(last&&r[0]<=last[1])last[1]=Math.max(last[1],r[1]);else out.push([...r]);return out;},[]);

// Immutable assignment text only. No filesystem paths, cross-work queries or
// implicit source/memory grants are accepted by this delivery channel.
export class Packets {
  constructor(engine){
    this.e=engine;engine.store.db.exec(`CREATE TABLE IF NOT EXISTS orch_packets(id TEXT PRIMARY KEY,task TEXT NOT NULL,work TEXT NOT NULL,kind TEXT NOT NULL,sha256 TEXT NOT NULL,body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS orch_packet_reads(work TEXT NOT NULL,child TEXT NOT NULL,packet TEXT NOT NULL,ranges TEXT NOT NULL,PRIMARY KEY(work,child,packet));`);
  }
  put(r,w,kind,body,required_read=true){
    const sha256=digest(body),id='packet-'+digest(w.id+'\0'+kind+'\0'+sha256);
    this.e.store.sql('INSERT OR IGNORE INTO orch_packets VALUES(?,?,?,?,?,?)',id,r.task,w.id,kind,sha256,body);
    return {packet_id:id,sha256,kind,required_read,bytes:bytes(body),codepoints:Array.from(body).length,read_with:'dsh_solver_feedback action=read_material; packet_id, expected_hash, offset, max_bytes; follow next_offset with snapshot. Pages contain result text, not a summary.'};
  }
  pending(w,child){return (w.assignment_materials??[]).filter(p=>p.required_read&&!this.covered(w,child,p));}
  covered(w,child,p){const r=this.e.store.q('SELECT ranges FROM orch_packet_reads WHERE work=? AND child=? AND packet=?',w.id,child,p.packet_id);return p.codepoints===0||!!r&&JSON.parse(r.ranges).some(([a,b])=>a===0&&b>=p.codepoints);}
  prepare(r,w,assignment){
    if(w.role==='observer')return assignment;
    const value=structuredClone(assignment),parts=(w.assignment_materials??[]).filter(p=>p.kind.startsWith('followup:'));
    if(bytes(value.recorded_task?.goal)>8192){const p=this.put(r,w,'recorded_goal',typeof value.recorded_task.goal==='string'?value.recorded_task.goal:JSON.stringify(value.recorded_task.goal));parts.push(p);value.recorded_task.goal='Read the complete recorded goal in goal_material; current recorded constraints remain authoritative.';value.recorded_task.goal_material=p;}
    if(bytes(value.targets)>8192){const p=this.put(r,w,'target_context',JSON.stringify(value.targets));parts.push(p);value.targets=[];value.targets_material=p;}
    if(bytes(value.question)>8192){const p=this.put(r,w,'task_question',value.question);parts.push(p);value.question='Read the complete task question from the required assignment material before executing. The manifest is not a summary or a replacement task.';value.question_material=p;}
    if(bytes(value.handoff)>8192){
      const p=this.put(r,w,'handoff',JSON.stringify(value.handoff));parts.push(p);
      value.handoff={constraints:value.handoff.constraints,responsibility:value.handoff.responsibility,authority:value.handoff.authority,full_handoff_material:p};
    }
    for(const d of value.dependencies??[]){
      const original=this.e.store.work(r.task,d.work),full=original.result_external?this.e.store.fullResult(original).result:d.result;
      if(typeof full==='string'&&bytes(full)>8192){const p=this.put(r,w,'dependency:'+d.work+'@'+(original.result_revision??0),full,false);parts.push(p);delete d.result;d.result_material=p;}
    }
    const unique=[...new Map(parts.map(p=>[p.packet_id,p])).values()];
    const current=this.e.store.work(r.task,w.id);
    if(JSON.stringify(current.assignment_materials??[])!==JSON.stringify(unique)){current.assignment_materials=unique;current.material_delivery={state:this.pending({...current,assignment_materials:unique},current.child).length?'pending':'read',required:unique.filter(p=>p.required_read).length,authority:'Exact text available through bounded pages; receipts are reads, not understanding or permanent context visibility'};this.e.store.saveWork(current);}
    if(unique.length)value.assignment_materials=unique;
    return value;
  }
  message(r,w,content){
    if(bytes(content)<=8192)return content;
    const p=this.put(r,w,'followup:'+(w.turn_serial??1),content),fresh=this.e.store.work(r.task,w.id);
    fresh.assignment_materials=[...(fresh.assignment_materials??[]).filter(x=>!x.kind.startsWith('followup:')),p];fresh.material_delivery={state:'pending',authority:'Read complete followup before execution; no new tools or authorization'};this.e.store.saveWork(fresh);
    return '[DSH full followup material] '+JSON.stringify(p);
  }
  read(r,w,child,args){
    const row=this.e.store.q('SELECT * FROM orch_packets WHERE id=? AND task=? AND work=?',args.packet_id,r.task,w.id);
    if(!row||args.expected_hash!==row.sha256||digest(row.body)!==row.sha256)throw Error('Assignment material unavailable');
    const p=(w.assignment_materials??[]).find(p=>p.packet_id===args.packet_id)??{packet_id:row.id,sha256:row.sha256,codepoints:Array.from(row.body).length};
    if(args.snapshot!==undefined&&args.snapshot!==p.sha256)throw Error('Material snapshot changed');
    const requested=args.max_bytes??8192,budget=Math.min(requested,12000);if(!Number.isSafeInteger(requested)||requested<2048||requested>16384)throw Error('Invalid material page budget');
    const page=resultPage({id:p.packet_id,result:row.body,result_revision:1,state:'immutable_assignment_material'},{offset:args.offset??0,max_bytes:budget,expected_revision:1},{sha256:p.sha256,snapshot:p.sha256,original_source:'Immutable coordinator-assigned text packet; not a filesystem read or new authorization',read_coverage:{full:false,all_required_read:false},authority:'assigned text, not new permissions'});
    const old=this.e.store.q('SELECT ranges FROM orch_packet_reads WHERE work=? AND child=? AND packet=?',w.id,child,p.packet_id),end=page.next_offset??p.codepoints;
    const ranges=merge([...(old?JSON.parse(old.ranges):[]),[page.offset,end]]);
    this.e.store.sql('INSERT INTO orch_packet_reads VALUES(?,?,?,?) ON CONFLICT(work,child,packet) DO UPDATE SET ranges=excluded.ranges',w.id,child,p.packet_id,JSON.stringify(ranges));
    const fresh=this.e.store.work(r.task,w.id),complete=this.pending(fresh,child).length===0;
    if(complete&&fresh.material_delivery?.state!=='read'){fresh.material_delivery={...fresh.material_delivery,state:'read',authority:'All required text ranges read by this child; not proof of understanding'};this.e.store.saveWork(fresh);}
    return {...page,snapshot:p.sha256,read_coverage:{full:this.covered(fresh,child,p),all_required_read:complete},authority:'assigned text, not new permissions'};
  }
  index(r,w,args){
    const offset=args.offset??0,limit=args.limit??8,budget=args.max_bytes??8192;
    if(!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(limit)||limit<1||limit>32||!Number.isSafeInteger(budget)||budget<2048||budget>16384)throw Error('Invalid material index page');
    const total=this.e.store.q('SELECT COUNT(*) AS n FROM orch_packets WHERE task=? AND work=?',r.task,w.id).n;
    const snapshot=digest(w.id+':'+total);if(args.snapshot!==undefined&&args.snapshot!==snapshot||offset&&!args.snapshot)throw Error('Material index changed; restart pagination');
    const result={snapshot,total,items:[],next_offset:null};
    for(const row of this.e.store.all('SELECT id AS packet_id,sha256,kind FROM orch_packets WHERE task=? AND work=? ORDER BY rowid LIMIT ? OFFSET ?',r.task,w.id,limit,offset)){
      result.items.push(row);result.next_offset=offset+result.items.length<total?offset+result.items.length:null;
      if(bytes(result)>budget){result.items.pop();result.next_offset=offset+result.items.length;break;}
    }
    return result;
  }
}
