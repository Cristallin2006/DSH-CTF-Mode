// Validate only the shipped contract; no remote schemas or executable input.
export function validate(value,schema,root=schema,at='$'){
  const fail=()=>{throw Error('Candidate schema mismatch at '+at);};
  const match=(v,s)=>{try{validate(v,s,root,at);return true;}catch{return false;}};
  if(schema.$ref){let s=root;for(const key of schema.$ref.slice(2).split('/'))s=s[key];return validate(value,s,root,at);}
  if(schema.type){const types=Array.isArray(schema.type)?schema.type:[schema.type],kind=value===null?'null':Array.isArray(value)?'array':typeof value;if(!types.includes(kind)&&!(types.includes('integer')&&Number.isInteger(value)))fail();}
  if('const' in schema&&value!==schema.const)fail();
  if(schema.enum&&!schema.enum.includes(value))fail();
  if(typeof value==='string'){if(value.length<(schema.minLength??0)||value.length>(schema.maxLength??Infinity))fail();if(schema.pattern&&!new RegExp(schema.pattern).test(value))fail();if(schema.format==='date-time'&&(!/^\d{4}-\d\d-\d\dT/.test(value)||!Number.isFinite(Date.parse(value))))fail();}
  if(typeof value==='number'&&(!Number.isFinite(value)||value<(schema.minimum??-Infinity)))fail();
  if(Array.isArray(value)){if(value.length<(schema.minItems??0)||value.length>(schema.maxItems??Infinity))fail();if(schema.items)value.forEach((v,i)=>validate(v,schema.items,root,at+'['+i+']'));}
  if(value&&typeof value==='object'&&!Array.isArray(value)){for(const k of schema.required??[])if(!(k in value))fail();for(const [k,v] of Object.entries(value)){if(schema.properties?.[k])validate(v,schema.properties[k],root,at+'.'+k);else if(schema.additionalProperties===false)fail();}}
  for(const s of schema.allOf??[])validate(value,s,root,at);
  if(schema.if&&match(value,schema.if)&&schema.then)validate(value,schema.then,root,at);
}
