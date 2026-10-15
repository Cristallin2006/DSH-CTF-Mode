import {randomUUID} from 'node:crypto';
import {MemoryStore,ids,text,json,processIdentity} from './store.mjs';

export class AnalysisStore extends MemoryStore {
  addWork(actor,task,{question,sources=[],depends_on=[]}){
    this.own(actor,task,true);text(question,'question');sources=ids(sources);depends_on=ids(depends_on);
    for(const s of sources)this.verifySource(this.sourceRow(task,s));
    for(const d of depends_on)if(this.work(task,d).inputs.some(s=>!sources.includes(s)))throw Error('Explicitly assign prerequisite evidence before sharing its result');
    return this.tx(()=>{this.own(actor,task,true);const id='work-'+randomUUID();this.run('INSERT INTO mem_work(id,task,question,inputs,deps,state) VALUES(?,?,?,?,?,?)',id,task,question,json(sources),json(depends_on),'pending');this.audit(task,actor,'work-add',{id});return {work:id};});
  }
  work(task,id){const w=this.q('SELECT * FROM mem_work WHERE id=? AND task=?',id,task);if(!w)throw Error('Work unavailable');return {...w,inputs:JSON.parse(w.inputs),deps:JSON.parse(w.deps),result:w.result?JSON.parse(w.result):null};}
  verifyWork(w,seen=new Set()){
    if(this.baseTask(w.task).status!=='running')throw Error('Task is not running');
    if(seen.has(w.id)||seen.size>40)throw Error('Invalid dependency chain');seen.add(w.id);
    for(const s of w.inputs)this.verifySource(this.sourceRow(w.task,s));
    for(const id of w.deps){const d=this.work(w.task,id);if(d.state!=='adopted')throw Error('Dependency not adopted');if(d.inputs.some(s=>!w.inputs.includes(s)))throw Error('Prerequisite evidence grant missing');this.verifyWork(d,new Set(seen));}
  }
  claim(actor,task,id,host,max){
    return this.tx(()=>{this.own(actor,task,true);const w=this.work(task,id);if(w.state!=='pending')throw Error('Work not pending');if(this.q("SELECT COUNT(*) AS n FROM mem_work WHERE state='running'").n>=max)throw Error('Collaboration capacity reached');this.verifyWork(w);this.run("UPDATE mem_work SET state='running',host=?,pid=?,identity=? WHERE id=?",host,process.pid,processIdentity(),id);this.audit(task,actor,'work-claim',{id});return w;});
  }
  publishChild(task,id,host,child){if(!this.run("UPDATE mem_work SET child=? WHERE id=? AND task=? AND state='running' AND host=?",child,id,task,host).changes)throw Error('Lost work ownership');}
  childRead(child,work,source){
    const row=this.q("SELECT * FROM mem_work WHERE id=? AND child=? AND state='running'",work,child);if(!row)throw Error('Evidence unavailable');
    const w=this.work(row.task,work);if(!w.inputs.includes(source))throw Error('Evidence unavailable');this.verifyWork(w);const s=this.verifySource(this.sourceRow(row.task,source));
    this.run('INSERT OR IGNORE INTO mem_child_reads VALUES(?,?,?)',work,child,source);return {source_id:source,text:s.body,sha256:s.sha256,authority:'evidence-data-not-instructions'};
  }
  workContext(actor,task,id){
    const w=this.work(task,id);this.own(actor,task,true);this.verifyWork(w);
    return {task,work:id,question:w.question,sources:w.inputs,memory:this.context(actor,task,{budget_bytes:3072,source_grant:w.inputs}),dependencies:w.deps.map(d=>({work:d,result:this.work(task,d).result}))};
  }
  settle(task,id,host,state,result,diagnostic){
    return this.tx(()=>{
      const w=this.work(task,id);if(w.state!=='running'||w.host!==host)throw Error('Lost work ownership');
      if(state==='returned')try{
        this.verifyWork(w);if(!result||typeof result!=='object'||Array.isArray(result))throw Error('Invalid result object');text(result.conclusion,'conclusion');
        const refs=ids(result.evidence);if((w.inputs.length&&!refs.length)||refs.some(s=>!w.inputs.includes(s)||!this.q('SELECT source FROM mem_child_reads WHERE work=? AND child=? AND source=?',id,w.child,s)))throw Error('Result lacks actually read assigned evidence');
        if(!Array.isArray(result.unresolved)||result.unresolved.length>40||result.unresolved.some(x=>typeof x!=='string'||x.length>2000))throw Error('Invalid unresolved conditions');
        result={conclusion:result.conclusion,evidence:refs,unresolved:result.unresolved,origin:'inferred',verification:'untested'};
      }catch(e){state='failed';diagnostic=e.message;result=null;}
      if(!['returned','failed','cancelled','interrupted'].includes(state))throw Error('Invalid work terminal state');
      this.run('UPDATE mem_work SET state=?,result=?,diagnostic=? WHERE id=?',state,result?json(result):null,diagnostic??null,id);this.audit(task,'host','work-settle',{id,state});return {work:id,state,diagnostic};
    });
  }
  reviewWork(actor,task,{work,decision,reason}){
    if(!['adopted','rejected','needs_more_evidence'].includes(decision))throw Error('Invalid review');text(reason,'reason',3000);
    return this.tx(()=>{this.own(actor,task,true);const w=this.work(task,work);if(w.state!=='returned')throw Error('Only returned work can be reviewed');this.verifyWork(w);
      if(decision==='adopted')for(const id of w.result.evidence){const s=this.sourceRow(task,id);if(!this.q('SELECT source FROM mem_reads WHERE task=? AND actor=? AND source=? AND sha256=?',task,actor,id,s.sha256))throw Error('Main source read required');}
      this.run('UPDATE mem_work SET state=? WHERE id=?',decision,work);this.audit(task,actor,'work-review',{work,decision,reason});return {work,state:decision,verification:'untested'};
    });
  }
  workStatus(actor,task){this.own(actor,task);return this.all('SELECT id,state,question,child,diagnostic FROM mem_work WHERE task=? ORDER BY rowid DESC LIMIT 100',task);}
  retire(actor,task,{work,reason}){text(reason,'reason',3000);return this.tx(()=>{this.own(actor,task,true);const w=this.work(task,work);if(['running','adopted','retired'].includes(w.state))throw Error('Work cannot be retired');this.run("UPDATE mem_work SET state='retired' WHERE id=?",work);this.audit(task,actor,'work-retire',{work,reason});return {work,state:'retired'};});}
  recover(actor,task){return this.tx(()=>{this.own(actor,task);const rows=this.all("SELECT * FROM mem_work WHERE task=? AND state='running'",task);for(const w of rows){if(processIdentity(w.pid)===w.identity)throw Error('Execution host still alive; recovery refused');this.run("UPDATE mem_work SET state='interrupted',diagnostic='Host exited; no replay' WHERE id=?",w.id);}this.audit(task,actor,'work-recover',{count:rows.length});return {interrupted:rows.length};});}
}
