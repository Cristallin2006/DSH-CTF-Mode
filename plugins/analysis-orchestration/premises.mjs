import fs from 'node:fs';
import path from 'node:path';
import {hash} from './store.mjs?revision=0.7.1';

// This projection is mirrored by analysis-v1/session.py. It contains only
// explicitly selected premise closures and never searches task-wide memory.
export function premiseBasis(store,task,bindings){
  const nodes=new Map(),sources=new Map();
  function source(id){
    if(sources.has(id))return;const out={id,sha256:null,valid:false};
    try{
      let s=store.q('SELECT * FROM mem_sources WHERE task=? AND id=?',task,id);
      if(!s&&id.startsWith('doc-')&&store.q("SELECT name FROM sqlite_master WHERE name='handoff_documents'"))s=store.q('SELECT * FROM handoff_documents WHERE task=? AND id=?',task,id);
      const owner=store.q('SELECT workspace FROM mem_owners WHERE task=?',task);
      if(s){
        out.sha256=s.sha256;const root=fs.realpathSync(owner.workspace),file=fs.realpathSync(s.path),relative=path.relative(root,file),stat=fs.statSync(file),limit=s.chunks?2097152:131072;
        out.valid=relative!=='..'&&!relative.startsWith('../')&&!path.isAbsolute(relative)&&!file.startsWith(store.root+'/')&&!file.split('/').some(p=>/^(\.dsh|\.ssh|\.aws|\.git|\.env(?:\..*)?|credentials?)$/i.test(p))&&stat.isFile()&&stat.size<=limit&&(s.target===null?s.generation===0:store.q('SELECT MAX(generation) AS g FROM targets WHERE task=? AND id=?',task,s.target)?.g===s.generation)&&(!s.chunks||file===s.path&&hash(JSON.parse(s.chunks).join(''))===s.sha256)&&hash(fs.readFileSync(file))===s.sha256;
      }
    }catch{}sources.set(id,out);
  }
  function visit(id){if(nodes.has(id))return;const node={id,revision:null,review_state:null,applicability:'unavailable',generation_valid:false,time_valid:false,dependencies:[],sources:[]};nodes.set(id,node);if(nodes.size>256)throw Error('Premise closure exceeds supported bound');try{const row=store.q('SELECT r.data FROM mem_objects o JOIN mem_revisions r ON r.id=o.id AND r.task=o.task AND r.rev=o.head WHERE o.task=? AND o.id=?',task,id);if(!row)return;const d=JSON.parse(row.data);Object.assign(node,{revision:d.revision,review_state:d.review_state,applicability:d.applicability,generation_valid:d.target_id===null?d.expected_generation===0:store.q('SELECT MAX(generation) AS g FROM targets WHERE task=? AND id=?',task,d.target_id)?.g===d.expected_generation,time_valid:!((d.recheck_after&&Date.parse(d.recheck_after)<=Date.now())||(d.valid_from&&Date.parse(d.valid_from)>Date.now())||(d.valid_to&&Date.parse(d.valid_to)<=Date.now())),dependencies:d.dependency_refs??[],sources:[...new Set([...(d.evidence_refs??[]),...(d.details?.input_refs??[]),...(d.acceptance_source_refs??[])].map(s=>s.source_id))].sort()});for(const ref of node.dependencies)visit(ref.record_id);for(const id of node.sources)source(id);}catch(error){if(/exceeds/.test(error.message))throw error;node.applicability='unavailable';}}
  for(const b of bindings)visit(b.record_id);
  function effective(id,seen=new Set()){
    const n=nodes.get(id);if(!n||seen.has(id))return 'needs_recheck';
    if(['revoked','superseded','unavailable'].includes(n.applicability))return n.applicability;
    seen.add(id);if(!n.generation_valid||!n.time_valid||n.sources.some(id=>!sources.get(id)?.valid)||n.dependencies.some(d=>nodes.get(d.record_id)?.revision!==d.revision||effective(d.record_id,new Set(seen))!=='current'))return 'needs_recheck';return n.applicability;
  }
  for(const n of nodes.values())n.effective_applicability=effective(n.id);
  return {bindings,nodes:[...nodes.values()].sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0),sources:[...sources.values()].sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0)};
}
