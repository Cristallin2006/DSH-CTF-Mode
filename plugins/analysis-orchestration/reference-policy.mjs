import fs from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';

const hash=data=>createHash('sha256').update(data).digest('hex');
export const referencePath=value=>typeof value==='string'&&value.length<=500&&value.startsWith('references/')&&value.endsWith('.md')&&!value.includes('\\')&&!value.split('/').some(part=>['','..','.'].includes(part));
export async function readMaterial(root,relative,max=65536){
  const resolvedRoot=await fs.realpath(root),file=await fs.realpath(path.join(resolvedRoot,relative));
  const rel=path.relative(resolvedRoot,file);if(rel.startsWith('..')||path.isAbsolute(rel))throw Error('Required material escapes its skill directory');
  const handle=await fs.open(file,constants.O_RDONLY|(constants.O_NOFOLLOW??0)|(constants.O_NONBLOCK??0));let data;
  try{
    const stat=await handle.stat();if(!stat.isFile()||stat.size>max)throw Error('Required material is not a supported small regular file');
    const buffer=Buffer.alloc(max+1);let size=0;while(size<buffer.length){const part=await handle.read(buffer,size,buffer.length-size,null);if(!part.bytesRead)break;size+=part.bytesRead;}
    if(size>max)throw Error('Required material grew beyond its supported size');data=buffer.subarray(0,size);
  }finally{await handle.close();}
  return {content:new TextDecoder('utf-8',{fatal:true}).decode(data),sha256:hash(data),bytes:data.length};
}
export async function referencePolicy(skill,selected=[]){
  if(skill.resourceBase?.kind!=='directory'){
    if(selected.length)throw Error('Required references need a local directory provider: '+skill.name);
    return {policy:{state:'unavailable',reason:'No local directory provider'},required:[],references:[]};
  }
  const root=skill.resourceBase.path,name='skill-materials.json';
  let present=true;try{await fs.lstat(path.join(root,name));}catch(error){if(error.code==='ENOENT')present=false;else throw error;}
  let policy={state:'absent'},required=[];
  if(present){
    const file=await readMaterial(root,name,16384);let input;try{input=JSON.parse(file.content);}catch{throw Error('Invalid skill-materials.json JSON: '+skill.name);}
    if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(key=>!['version','required_references'].includes(key))||input.version!==1||!Array.isArray(input.required_references)||input.required_references.length>8||input.required_references.some(ref=>!referencePath(ref))||new Set(input.required_references).size!==input.required_references.length)throw Error('Invalid skill-materials.json policy: '+skill.name);
    required=[...input.required_references];policy={state:'declared',source:name,sha256:file.sha256,version:1,required_references:required};
  }
  const references=[...new Set([...required,...selected])];if(references.length>8)throw Error('Required and selected references exceed eight for '+skill.name);
  return {policy,required,references};
}
