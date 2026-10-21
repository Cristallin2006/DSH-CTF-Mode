// Fixed adapter for the real production preflight; no arbitrary module/tool execution.
import {preflight} from '../../../plugins/analysis-orchestration/planning.mjs';
const fixture=JSON.parse(process.argv[2]);
const engine={effectiveTools:()=>fixture.granted,ctx:{tools:{get:name=>fixture.granted.includes(name)?{}:null}}};
const result=preflight(engine,{execution_plan:{kind:'execution',requirements:[{purpose:'Synthetic calculation',any_of:['fixture_calculate']}],...(fixture.limit?{limits:[{unit:'candidate',max:2,authority_ref:'synthetic-explicit-limit'}]}:{})}},{});
console.log(JSON.stringify({status:result.ok?'checked':'blocked',coverage:result.coverage?.limits??'unsupported'}));
