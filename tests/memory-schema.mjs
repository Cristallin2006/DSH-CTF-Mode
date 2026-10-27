import assert from 'node:assert/strict';
import fs from 'node:fs';
import {validate} from '../plugins/analysis-memory/schema.mjs';
const schema=JSON.parse(fs.readFileSync(new URL('../plugins/analysis-memory/candidate.schema.json',import.meta.url)));
function failure(value,pattern){assert.throws(()=>validate(value,schema),error=>{assert.equal(error.code,'MEMORY_CANDIDATE_INVALID');assert(pattern.test(error.message),error.message);assert(!error.message.includes('PRIVATE_VALUE'));return true;});}
failure({},/\$\.schema_version: missing required field/);
const candidate={schema_version:'0.2',operation_id:'fixture',expected_generation:0,target_id:null,kind:'claim',title:'Synthetic',body:'PRIVATE_VALUE',origin:'inferred',verification:'untested',evidence_refs:[],accept_scope:null,unresolved:[],details:{proposition:'Synthetic condition',conditions:{description:'Fixture',environment_ref:null,analysis_revision_ref:null}}};
validate(candidate,schema);
const missing=structuredClone(candidate);delete missing.target_id;failure(missing,/\$\.target_id: missing required field/);
const nested=structuredClone(candidate);delete nested.details.conditions;failure(nested,/\$\.details\.conditions: missing required field/);
failure({...candidate,verification:'PRIVATE_VALUE'},/\$\.verification: value outside schema enum/);
failure({...candidate,task:'PRIVATE_VALUE'},/\$\.task: unknown field/);
failure(JSON.parse(JSON.stringify(candidate).replace(/}$/,',"__proto__":{"secret":"PRIVATE_VALUE"}}')),/unknown field/);
failure(JSON.parse(JSON.stringify(candidate).replace(/}$/,',"toString":"PRIVATE_VALUE"}')),/unknown field/);
console.log(JSON.stringify({ok:true,checks:['exact required/nested field paths','enum/type errors without value leakage','unknown and prototype field rejection','unchanged valid candidate contract']}));
