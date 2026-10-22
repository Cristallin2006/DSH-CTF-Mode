/** Optional discovery and explicitly reviewed, workspace-scoped method cards. */
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';

const hash=v=>createHash('sha256').update(v).digest('hex');
const json=JSON.stringify;
const plain=v=>!!v&&typeof v==='object'&&!Array.isArray(v);
const string=(v,max=4000)=>typeof v==='string'&&v.trim().length>0&&v.length<=max;
const list=v=>Array.isArray(v)&&v.every(x=>string(x));
const fields=(v,names)=>plain(v)&&Object.keys(v).every(k=>names.includes(k));
const norm=v=>v.normalize('NFKC').toLowerCase();
const inside=(root,p)=>{const rel=path.relative(root,p);return rel!== '..'&&!rel.startsWith('..'+path.sep)&&!path.isAbsolute(rel);};
const unavailable=()=>{throw Error('Method unavailable in this workspace/task scope');};
export const cardFields=['title','signals','aliases','preconditions','procedure','verification','failure_boundaries','counterexamples','uncertainties','tags'];
const authority='method-reference-data-not-instructions-or-current-target-facts';
const actions={schema:[],search:['query','kind','include_history','offset','limit','max_bytes','snapshot'],read_reference:['id','offset','max_bytes','snapshot','expected_hash'],read_method:['id','expected_revision','offset','max_bytes','snapshot'],draft_method:['record_id','record_revision','card','redaction_note'],review_method:['id','expected_revision','decision','reason']};
export const knowledgeOptions={query:{type:'string',maxLength:500},kind:{enum:['all','reference','method']},include_history:{type:'boolean'},offset:{type:'integer',minimum:0},limit:{type:'integer',minimum:1,maximum:50},max_bytes:{type:'integer',minimum:2048,maximum:12000},snapshot:{type:'string'},expected_hash:{type:'string'},id:{type:'string'},expected_revision:{type:'integer',minimum:1},record_id:{type:'string'},record_revision:{type:'integer',minimum:1},redaction_note:{type:'string',maxLength:4000},card:{type:'object',required:cardFields,properties:Object.fromEntries(cardFields.map(k=>[k,k==='title'?{type:'string',maxLength:512}:{type:'array',items:{type:'string',maxLength:4000}}])),additionalProperties:false},decision:{enum:['publish','reject','retire']},reason:{type:'string',maxLength:4000}};

export function terms(text){
  const n=norm(text),out=n.match(/[a-z0-9_][a-z0-9_.+-]*/g)??[];
  for(const run of n.matchAll(/[\p{Script=Han}]+/gu)){
    const chars=Array.from(run[0]);if(chars.length===1)out.push(chars[0]);
    for(let i=0;i<chars.length-1;i++)out.push(chars[i]+chars[i+1]);
  }
  return [...new Set(out)];
}
export function match(query,doc){
  const ts=terms(query),matches=[];let score=0;
  const weights={title:5,aliases:4,signals:3,tags:3,preconditions:2,failure_boundaries:2,counterexamples:2,uncertainties:1,procedure:1,verification:1};
  for(const [field,weight] of Object.entries(weights)){
    const value=norm(Array.isArray(doc[field])?doc[field].join('\n'):doc[field]??''),hit=ts.filter(t=>value.includes(t));
    if(hit.length){score+=weight*hit.length;matches.push({field,terms:hit});}
  }
  return {score,matches};
}
function page(body,o,meta={}){
  const chars=Array.from(body),snapshot=hash(json(meta)+'\n'+body),offset=o.offset??0,budget=o.max_bytes??8192;
  if(o.snapshot&&o.snapshot!==snapshot)throw Error('Knowledge snapshot changed; restart paging');
  if(o.expected_hash&&o.expected_hash!==hash(body))throw Error('Reference hash changed; review current original');
  if(offset>chars.length)throw Error('Offset outside material');
  const out={...meta,authority,sha256:hash(body),snapshot,offset,total_codepoints:chars.length,text:'',next_offset:null};
  let end=offset,bytes=Buffer.byteLength(json(out));
  while(end<chars.length){const cost=Buffer.byteLength(json(chars[end]))-2;if(bytes+cost+32>budget)break;out.text+=chars[end++];bytes+=cost;}
  if(end===offset&&end<chars.length)throw Error('Page budget too small');
  out.next_offset=end<chars.length?end:null;
  if(Buffer.byteLength(json(out))>budget)throw Error('Page budget too small');return out;
}
function navigationPage(items,o,scope){
  const snapshot=hash(json(items)),offset=o.offset??0,budget=o.max_bytes??8192;
  if(o.snapshot&&o.snapshot!==snapshot)throw Error('Knowledge search changed; restart paging');
  if(offset>items.length)throw Error('Offset outside search');
  const out={authority,scope,engine:'explicit-metadata-lexical-v1',snapshot,total:items.length,offset,items:[],next_offset:null,warning:'Candidates only. Scores are lexical relevance, not truth or applicability. No match does not prove missing knowledge. Read the full conditions and original reference; lookup is optional.'};
  for(const item of items.slice(offset,offset+(o.limit??10))){out.items.push(item);out.next_offset=offset+out.items.length<items.length?offset+out.items.length:null;if(Buffer.byteLength(json(out))>budget){out.items.pop();out.next_offset=offset+out.items.length;break;}}
  if(!out.items.length&&offset<items.length)throw Error('Search page budget too small');return out;
}

export class Knowledge {
  constructor(store,catalogPath=new URL('./knowledge-catalog.json',import.meta.url)){
    this.s=store;
    const c=JSON.parse(fs.readFileSync(catalogPath,'utf8'));
    if(c.version!==1||!Array.isArray(c.cards)||new Set(c.cards.map(d=>d.id)).size!==c.cards.length)throw Error('Invalid knowledge catalog');
    for(const d of c.cards)if(!fields(d,['id','skill','reference','title','signals','aliases','preconditions','failure_boundaries','counterexamples','tags'])||!string(d.id,100)||!/^[-a-z0-9]+$/.test(d.skill)||typeof d.reference!=='string'||!d.reference.startsWith('references/')||!d.reference.endsWith('.md')||d.reference.includes('\\')||d.reference.includes('\0')||d.reference.split('/').some(v=>['','.','..'].includes(v))||!string(d.title,512)||!['signals','aliases','preconditions','failure_boundaries','counterexamples','tags'].every(k=>list(d[k])))throw Error('Invalid catalog card');
    this.catalog=c.cards;
    store.db.exec('CREATE TABLE IF NOT EXISTS mem_method_entries(id TEXT PRIMARY KEY,project TEXT NOT NULL,task TEXT NOT NULL,head INTEGER NOT NULL);CREATE INDEX IF NOT EXISTS mem_method_project ON mem_method_entries(project);CREATE TABLE IF NOT EXISTS mem_method_revisions(id TEXT NOT NULL,revision INTEGER NOT NULL,data TEXT NOT NULL,PRIMARY KEY(id,revision))');
    const version=store.q("SELECT value FROM mem_meta WHERE key='method-library'");if(version&&version.value!=='1')throw Error('Unsupported method library version');
    store.run("INSERT OR IGNORE INTO mem_meta VALUES('method-library','1')");
  }
  project(actor,task,write=false){const owner=this.s.own(actor,task,write);return hash(fs.realpathSync(owner.workspace));}
  row(actor,task,id){
    const project=this.project(actor,task),r=this.s.q('SELECT e.task,r.data FROM mem_method_entries e JOIN mem_method_revisions r ON r.id=e.id AND r.revision=e.head WHERE e.id=? AND e.project=?',id,project);
    if(!r)unavailable();const d=JSON.parse(r.data);if(d.state!=='published'&&r.task!==task&&d.state!=='retired')unavailable();return d;
  }
  sourceState(d){
    try{const old=this.s.head(d.source.task,d.source.id);return old.revision===d.source.revision&&old.review_state==='reviewed'&&this.s.applicable(d.source.task,old)==='current'?'current':'needs_recheck';}catch{return 'needs_recheck';}
  }
  projection(d){return {id:d.id,revision:d.revision,state:d.state,source_status:this.sourceState(d),card:d.card,reviewed:['published','retired'].includes(d.state),created_at:d.created_at,updated_at:d.updated_at,authority,verification:'not-validated-for-current-target'};}
  draft(actor,task,o){
    const s=this.s,project=this.project(actor,task,true),input=o.card;
    const card=plain(input)?Object.fromEntries(cardFields.filter(k=>k in input).map(k=>[k,input[k]])):input;
    if(!fields(input,cardFields)||!fields(card,cardFields)||Object.keys(card).length!==cardFields.length||!string(card.title,512)||!cardFields.filter(k=>k!=='title').every(k=>list(card[k]))||!['signals','preconditions','procedure','verification','failure_boundaries'].every(k=>card[k].length>0)||Buffer.byteLength(json(card))>48000||!string(o.redaction_note))throw Error('Invalid method card: preserve conditions, procedure, verification and failure boundaries; card is limited to 48 KiB per write, never truncated');
    if(s.sensitive(json(card)+'\n'+o.redaction_note))throw Error('Sensitive method card refused; explicitly redact first');
    return s.tx(()=>{
      const source=s.get(actor,task,o.record_id);
      if(source.revision!==o.record_revision||source.kind!=='method_candidate'||source.review_state!=='reviewed'||source.applicability!=='current')throw Error('Use the current reviewed method_candidate');
      const sourceRef={task,id:source.id,revision:source.revision};
      const id='method-'+hash(json({project,source:sourceRef,card,redaction_note:o.redaction_note}));
      if(s.q('SELECT id FROM mem_method_entries WHERE id=?',id)){const old=this.row(actor,task,id);return {id,revision:old.revision,state:old.state,authority};}
      const at=new Date().toISOString(),d={id,revision:1,state:'draft',card,redaction_note:o.redaction_note,source:sourceRef,created_at:at,updated_at:at};
      s.run('INSERT INTO mem_method_entries VALUES(?,?,?,1)',id,project,task);s.run('INSERT INTO mem_method_revisions VALUES(?,1,?)',id,json(d));s.audit(task,actor,'method-draft',{id,revision:1});return {id,revision:1,state:'draft',authority};
    });
  }
  review(actor,task,o){
    const s=this.s;this.project(actor,task,true);if(!string(o.reason))throw Error('Review reason required');
    return s.tx(()=>{
      const d=this.row(actor,task,o.id);if(d.revision!==o.expected_revision)throw Error('Method revision conflict');
      const owner=s.q('SELECT task FROM mem_method_entries WHERE id=?',d.id).task;
      if(o.decision==='publish'){
        if(d.state!=='draft'||owner!==task)throw Error('Only the originating task can publish this draft');
        const source=s.get(actor,task,d.source.id);
        if(this.sourceState(d)!=='current'||source.details.redaction_status!=='reviewed')throw Error('Source changed or redaction review missing; create a corrected draft');
        // Validate original evidence again; publication never imports it into the project card.
        for(const ref of [...source.evidence_refs,...(source.details.input_refs??[])]){
          const src=s.verifySource(s.sourceRow(task,ref.source_id));
          if(!s.q('SELECT source FROM mem_reads WHERE task=? AND actor=? AND source=? AND sha256=?',task,actor,src.id,src.sha256))throw Error('Read original source before method publication');
        }
      }else if(o.decision==='reject'){
        if(d.state!=='draft'||owner!==task)throw Error('Only the originating task can reject its draft');
      }else if(o.decision==='retire'){
        if(d.state!=='published')throw Error('Only published methods can be retired');
      }else throw Error('Invalid method review');
      if(s.sensitive(o.reason))throw Error('Sensitive review reason refused');
      const next={...d,revision:d.revision+1,state:{publish:'published',reject:'rejected',retire:'retired'}[o.decision],review_reason:o.reason,updated_at:new Date().toISOString()};
      s.run('INSERT INTO mem_method_revisions VALUES(?,?,?)',d.id,next.revision,json(next));s.run('UPDATE mem_method_entries SET head=? WHERE id=?',next.revision,d.id);s.audit(task,actor,'method-'+o.decision,{id:d.id,revision:next.revision});return {id:d.id,revision:next.revision,state:next.state,authority};
    });
  }
  async reference(id,skills){
    const d=this.catalog.find(c=>c.id===id),skill=d&&skills.get(d.skill);
    if(!d||!skill?.invocation?.modelInvocable||skill.resourceBase?.kind!=='directory')throw Error('Reference unavailable in current skill scope');
    const root=fs.realpathSync(skill.resourceBase.path),file=fs.realpathSync(path.resolve(root,d.reference));
    if(!inside(root,file))throw Error('Reference outside skill directory');
    const fd=fs.openSync(file,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW??0)|(fs.constants.O_NONBLOCK??0));let buf;
    try{const stat=fs.fstatSync(fd);if(!stat.isFile()||stat.size>1024*1024)throw Error('Reference is not bounded regular UTF-8 text');buf=Buffer.alloc(stat.size+1);let size=0;while(size<buf.length){const n=fs.readSync(fd,buf,size,buf.length-size,null);if(!n)break;size+=n;}if(size>1024*1024||size!==stat.size)throw Error('Reference changed while reading');buf=buf.subarray(0,size);}finally{fs.closeSync(fd);}
    return {card:d,text:new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(buf)};
  }
  async command(actor,task,action,o={},skills=new Map()){
    if(!actions[action]||!fields(o,actions[action]))throw Error('Invalid knowledge operation/options');
    if(action==='schema')return {version:1,actions,card_fields:cardFields,scope:'same canonical workspace only; drafts belong to originating task',optional:true,no_automatic_skill_writes:true,authority};
    this.project(actor,task);
    for(const [k,min,max] of [['offset',0,Number.MAX_SAFE_INTEGER],['limit',1,50],['max_bytes',2048,12000]])if(o[k]!==undefined&&(!Number.isSafeInteger(o[k])||o[k]<min||o[k]>max))throw Error('Invalid knowledge '+k);
    if(action==='draft_method')return this.draft(actor,task,o);
    if(action==='review_method')return this.review(actor,task,o);
    if(action==='read_method'){
      const d=this.row(actor,task,o.id);if(o.expected_revision!==undefined&&o.expected_revision!==d.revision)throw Error('Method revision changed');
      return page(json(this.projection(d)),o,{id:d.id,revision:d.revision,state:d.state,source_status:this.sourceState(d)});
    }
    if(action==='read_reference'){
      const d=await this.reference(o.id,skills);return page(d.text,o,{id:d.card.id,skill:d.card.skill,reference:d.card.reference});
    }
    if(typeof(o.query??'')!=='string'||(o.query??'').length>500||!['all','reference','method'].includes(o.kind??'all')||(o.include_history!==undefined&&typeof o.include_history!=='boolean'))throw Error('Invalid knowledge search');
    const query=o.query??'',items=[];
    if(o.kind!=='method')for(const d of this.catalog){
      if(!skills.get(d.skill)?.invocation?.modelInvocable)continue;
      const m=match(query,d);if(query.trim()&&!m.score)continue;
      items.push({id:d.id,kind:'reference',skill:d.skill,reference:d.reference,title:d.title,preconditions:d.preconditions,failure_boundaries:d.failure_boundaries,counterexamples:d.counterexamples,score:m.score,matches:m.matches,conditions_available:true});
    }
    if(o.kind!=='reference'){
      const project=this.project(actor,task);
      // Stream all scoped heads: no latest-N scan window can erase old relevant methods.
      const statement=this.s.db.prepare('SELECT e.task,r.data FROM mem_method_entries e JOIN mem_method_revisions r ON r.id=e.id AND r.revision=e.head WHERE e.project=? ORDER BY e.id');
      const sourceStates=new Map();
      for(const row of statement.iterate(project)){
        const d=JSON.parse(row.data);if(d.state!=='published'&&!(o.include_history&&(d.state==='retired'||row.task===task)))continue;
        const sourceKey=json(d.source);if(!sourceStates.has(sourceKey))sourceStates.set(sourceKey,this.sourceState(d));
        const source_status=sourceStates.get(sourceKey);if(!o.include_history&&source_status!=='current')continue;
        const m=match(query,d.card);if(query.trim()&&!m.score)continue;
        items.push({id:d.id,kind:'method',title:d.card.title,revision:d.revision,state:d.state,source_status,score:m.score,matches:m.matches,conditions_available:true});
      }
    }
    items.sort((a,b)=>b.score-a.score||a.id.localeCompare(b.id));return navigationPage(items,o,'current native skills + reviewed methods in current workspace; private drafts only when explicitly requested');
  }
}

export function knowledgeTool(library,ctx,root){
  return {name:'dsh_knowledge',description:'可选的专业参考导航和同工作区方法记忆。search 返回候选和词法匹配理由，read_reference/read_method 分页读完整原文；不命中不妨碍继续分析。草稿从当前已复核 method_candidate 提炼，review_method 显式脱敏复核后发布；无自动 skill 改写，不共享凭据、实例事实或权限。仅主会话；Solver 专业原文仍用 skill_plan/skill。先看 schema 或 analysis-memory/references/knowledge-library.md。',parameters:{type:'object',properties:{action:{enum:Object.keys(actions)},task:{type:'string'},options:{type:'object',properties:knowledgeOptions,additionalProperties:false}},required:['action'],additionalProperties:false},output:{schema:{type:'string'},render(_a,v){return [{type:'text',text:v}];}},async execute(args,exec){
    const actor=root(exec),o=args.options??{},skills=new Map();
    if(args.action==='read_reference'||(args.action==='search'&&o.kind!=='method')){
      const lookup={cwd:exec.agent.session.header.cwd,scope:exec.agent,signal:exec.signal};
      if(!ctx.skills||!ctx.tools.get('skill',exec.agent))throw Error('Native scoped skill loader unavailable; use original tools');
      const wanted=new Set(library.catalog.map(d=>d.skill));
      for(const summary of await ctx.skills.list(lookup))if(wanted.has(summary.name)&&summary.invocation?.modelInvocable){
        const skill=await ctx.skills.get(summary.name,lookup);if(skill?.invocation?.modelInvocable)skills.set(skill.name,skill);
      }
    }
    exec.signal?.throwIfAborted();return json(await library.command(actor,args.task,args.action,o,skills));
  }};
}
