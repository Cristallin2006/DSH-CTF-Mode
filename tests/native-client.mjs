// Exercise the public full-document fallback when a native work reply is large.
// Runtime activity remains a live bounded summary; stored fields come from the
// version-pinned JSON document, never from a clipped tool response.
export async function expandWork(call,task,value){
  if(!value?.large_fields_omitted)return value;
  let lastError;
  for(let retry=0;retry<3;retry++){
    try{
      let offset=0,snapshot;const parts=[];
      do{const p=await call('dsh_orchestration',{action:'work_document',task,options:{work:value.id,offset,max_bytes:8192,...snapshot?{snapshot}:{}}});parts.push(p.result);offset=p.next_offset;snapshot=p.snapshot;}while(offset!==null);
      return {...value,...JSON.parse(parts.join(''))};
    }catch(error){lastError=error;if(!/document changed/i.test(error.message))throw error;}
  }
  throw lastError;
}
