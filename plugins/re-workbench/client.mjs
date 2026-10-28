import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';

// This token authenticates a local DSH host, not the model. Principals are derived
// from native session headers and authoritative state, never accepted as tool args.
export class ReOwner {
  constructor({ownerRoot,stateRoot,realm,rpcMs=5000,drainMs=7000}){
    this.root=fs.realpathSync(ownerRoot);this.realm=realm;this.rpcMs=rpcMs;this.drainMs=drainMs;
    if(typeof realm!=='string'||!realm)throw Error('Explicit RE realm required');
    this.db=new DatabaseSync(path.join(fs.realpathSync(stateRoot),'state.sqlite3'),{readOnly:true});
    this.db.exec('PRAGMA busy_timeout=3000');
  }
  q(sql,...args){return this.db.prepare(sql).get(...args);}
  all(sql,...args){return this.db.prepare(sql).all(...args);}
  has(table){return !!this.q("SELECT name FROM sqlite_master WHERE name=?",table);}
  parent(owner,task){
    if(typeof owner!=='string'||typeof task!=='string')throw Error('Experiment scope unavailable');
    if(this.q('SELECT task FROM sessions WHERE id=?',owner)?.task!==task)throw Error('Experiment scope unavailable');
    return {realm:this.realm,owner,actor:owner,task,work:null,role:'parent',targets:this.all('SELECT id,MAX(generation) AS generation FROM targets WHERE task=? GROUP BY id ORDER BY id',task)};
  }
  principal(agent){
    const h=agent?.session?.header;if(!h?.id)throw Error('Native session required');
    if(!h.parentSession&&h.origin!=='subagent'){
      const task=this.q('SELECT task FROM sessions WHERE id=?',h.id)?.task;
      return this.parent(h.id,task);
    }
    if(!this.has('orch_work'))throw Error('Experiment scope unavailable');
    const rows=this.all("SELECT task,id,data FROM orch_work WHERE json_extract(data,'$.child')=?",h.id);
    if(rows.length!==1)throw Error('Experiment scope unavailable');
    const row=rows[0],w=JSON.parse(row.data),run=this.q('SELECT owner,data FROM orch_runs WHERE task=?',row.task),r=run?{...JSON.parse(run.data),owner:run.owner}:null;
    if(!r||w.role==='observer'||!w.tools?.includes('dsh_re_experiment'))throw Error('Managed experiment capability was not granted');
    return {...this.parent(r.owner,row.task),role:'solver',actor:h.id,work:row.id,targets:r.targets};
  }
  rpc(p,action,options){
    return new Promise((resolve,reject)=>{
      let data='',done=false,socket;
      const finish=(error,value)=>{if(done)return;done=true;socket?.destroy();error?reject(error):resolve(value);};
      try{
        const request=JSON.stringify({token:fs.readFileSync(path.join(this.root,'token'),'utf8').trim(),principal:p,action,options})+'\n';
        if(Buffer.byteLength(request)>131072)throw Error('RE request exceeds transport budget; use explicit input file references');
        socket=net.createConnection({path:path.join(this.root,'owner.sock')},()=>socket.write(request));
        socket.setEncoding('utf8');socket.setTimeout(this.rpcMs,()=>finish(Error('re_owner_unavailable: wait expired; query the same operation_id, never invent a replacement launch')));
        socket.on('data',chunk=>{data+=chunk;if(Buffer.byteLength(data)>131072)return finish(Error('RE response exceeds transport budget'));
          if(data.includes('\n'))try{const r=JSON.parse(data.slice(0,data.indexOf('\n')));r.ok?finish(null,r.value):finish(Error(r.error));}catch(e){finish(e);}});
        socket.on('error',()=>finish(Error('re_owner_unavailable: connection failed; launch outcome may be unknown; query the same operation_id')));
        socket.on('end',()=>{if(!done)finish(Error('re_owner_unavailable: response lost; do not automatically replay'))});
      }catch(e){finish(e);}
    });
  }
  async command(agent,action,options){
    const p=this.principal(agent);
    if(action==='submit'&&p.role==='parent'&&this.has('orch_runs')){
      const row=this.q('SELECT data FROM orch_runs WHERE task=?',p.task);
      if(row&&JSON.parse(row.data).state==='enabled')throw Error('Coordinator delegates execution to a Solver');
    }
    return this.rpc(p,action,options);
  }
  async drain(task,target=null,owner=null,work=null){
    if(!this.has('analysis_native_jobs'))return;
    const rows=this.all('SELECT owner,data FROM analysis_native_jobs WHERE task=?',task).map(r=>({...r,data:JSON.parse(r.data)}))
      .filter(r=>r.data.kind==='re_owner'&&['launching','running','stopping','cleanup_unknown'].includes(r.data.status)&&(!owner||r.owner===owner)&&(!work||r.data.work===work)&&(!target||r.data.target_basis?.some(t=>t.id===target)));
    const deadline=Date.now()+this.drainMs;
    for(const row of rows){
      if(row.data.owner_root!==this.root)throw Error('RE job belongs to a different shared owner root; cleanup unconfirmed');
      const p=this.parent(row.owner,task),o={job:row.data.job_id};let j=await this.rpc(p,'cancel',o);
      while(!['finished','failed','cancelled'].includes(j.state)&&Date.now()<deadline){await new Promise(r=>setTimeout(r,50));j=await this.rpc(p,'status',o);}
      if(!['finished','failed','cancelled'].includes(j.state))throw Error('RE cleanup unconfirmed; keep task and resource state until reconciled');
    }
  }
  close(){this.db.close();} // Unloading a client never kills the independent owner.
}
