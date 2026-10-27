// Validate only the shipped contract; no remote schemas or executable input.
export function validate(value,schema,root=schema,at='$'){
  const fail=(reason='invalid value',path=at)=>{const error=Error('Candidate schema mismatch at '+path+': '+reason);error.code='MEMORY_CANDIDATE_INVALID';error.path=path;error.reason=reason;throw error;};
  const field=k=>/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)&&k.length<=80?at+'.'+k:at+'['+JSON.stringify(k.slice(0,80))+']';
  const match=(v,s)=>{try{validate(v,s,root,at);return true;}catch{return false;}};
  if(schema.$ref){let s=root;for(const key of schema.$ref.slice(2).split('/'))s=s[key];return validate(value,s,root,at);}
  if(schema.type){const types=Array.isArray(schema.type)?schema.type:[schema.type],kind=value===null?'null':Array.isArray(value)?'array':typeof value;if(!types.includes(kind)&&!(types.includes('integer')&&Number.isInteger(value)))fail('expected type '+types.join('|'));}
  if('const' in schema&&value!==schema.const)fail('expected schema constant');
  if(schema.enum&&!schema.enum.includes(value))fail('value outside schema enum');
  if(typeof value==='string'){if(value.length<(schema.minLength??0)||value.length>(schema.maxLength??Infinity))fail();if(schema.pattern&&!new RegExp(schema.pattern).test(value))fail();if(schema.format==='date-time'&&(!/^\d{4}-\d\d-\d\dT/.test(value)||!Number.isFinite(Date.parse(value))))fail();}
  if(typeof value==='number'&&(!Number.isFinite(value)||value<(schema.minimum??-Infinity)))fail();
  if(Array.isArray(value)){if(value.length<(schema.minItems??0)||value.length>(schema.maxItems??Infinity))fail();if(schema.items)value.forEach((v,i)=>validate(v,schema.items,root,at+'['+i+']'));}
  if(value&&typeof value==='object'&&!Array.isArray(value)){for(const k of schema.required??[])if(!Object.hasOwn(value,k))fail('missing required field',field(k));for(const [k,v] of Object.entries(value)){if(schema.properties&&Object.hasOwn(schema.properties,k))validate(v,schema.properties[k],root,field(k));else if(schema.additionalProperties===false)fail('unknown field',field(k));}}
  for(const s of schema.allOf??[])validate(value,s,root,at);
  if(schema.if&&match(value,schema.if)&&schema.then)validate(value,schema.then,root,at);
}
