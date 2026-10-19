import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';
const base=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),source=process.env.DSH_ORCHESTRATION_TEST_ROOT??base;
const {referencePolicy,readMaterial}=await import(pathToFileURL(source+'/plugins/analysis-orchestration/reference-policy.mjs').href);
const root=await fs.mkdtemp(path.join(os.tmpdir(),'dsh-reference-policy-')),skill={name:'fixture',resourceBase:{kind:'directory',path:root}},checks=[];
await fs.mkdir(root+'/references');await fs.writeFile(root+'/references/core.md','COMPLETE_CORE_REFERENCE');await fs.writeFile(root+'/references/deeper.md','OPTIONAL_REFERENCE');
const manifest=root+'/skill-materials.json',write=required=>fs.writeFile(manifest,JSON.stringify({version:1,required_references:required}));
try{
 assert.equal((await referencePolicy(skill)).policy.state,'absent');await write(['references/core.md']);
 let result=await referencePolicy(skill,[]);assert.deepEqual(result.references,['references/core.md']);const firstHash=result.policy.sha256;
 result=await referencePolicy(skill,['references/core.md','references/deeper.md']);assert.deepEqual(result.references,['references/core.md','references/deeper.md']);assert.deepEqual(result.required,['references/core.md']);
 await write(['references/core.md','references/deeper.md']);assert.notEqual((await referencePolicy(skill)).policy.sha256,firstHash);
 checks.push('A skill-owned policy supplies complete mandatory references despite omitted/empty assignment references; explicit selections extend and deduplicate rather than override it; policy changes have content receipts');
 for(const bad of [{version:2,required_references:[]},{version:1,required_references:['../outside.md']},{version:1,required_references:['references/core.md','references/core.md']},{version:1,required_references:[],optional:'ignore missing source'}]){await fs.writeFile(manifest,JSON.stringify(bad));await assert.rejects(referencePolicy(skill),/Invalid/);}
 await fs.writeFile(manifest,'{broken');await assert.rejects(referencePolicy(skill),/JSON/);await fs.writeFile(manifest,'x'.repeat(17000));await assert.rejects(referencePolicy(skill),/supported small/);
 await fs.unlink(manifest);const outside=root+'-outside.json';await fs.writeFile(outside,'{"version":1,"required_references":[]}');await fs.symlink(outside,manifest);await assert.rejects(referencePolicy(skill),/escapes/);await fs.unlink(manifest);await fs.symlink(root+'/absent.json',manifest);await assert.rejects(referencePolicy(skill));await fs.unlink(manifest);
 await write(['references/core.md']);await assert.rejects(referencePolicy(skill,Array.from({length:8},(_,i)=>'references/'+i+'.md')),/exceed eight/);
 checks.push('Malformed/oversized/out-of-directory/dangling policies and union overflow fail explicitly; a present but broken policy never degrades to body-only delivery');
 await fs.writeFile(root+'/references/invalid.md',Buffer.from([0xff]));await assert.rejects(readMaterial(root,'references/invalid.md'));
 await fs.writeFile(root+'/references/huge.md','x'.repeat(65537));await assert.rejects(readMaterial(root,'references/huge.md'),/supported small/);
 const fifo=root+'/references/pipe.md';assert.equal(spawnSync('mkfifo',[fifo]).status,0);await assert.rejects(readMaterial(root,'references/pipe.md'),/supported small/);
 const noLocal=await referencePolicy({name:'fixture'});assert.equal(noLocal.policy.state,'unavailable');await assert.rejects(referencePolicy({name:'fixture'},['references/core.md']),/local directory/);
 checks.push('Reference contents require bounded regular UTF-8 files; a FIFO does not hang the loader; nonlocal providers do not acquire filesystem-reading authority');
 const value={ok:true,checks,externalModelCalls:0,externalTargetRequests:0};await fs.mkdir(base+'/.test-results',{recursive:true});await fs.writeFile(base+'/.test-results/reference-policy-unit.json',JSON.stringify(value,null,2));console.log(JSON.stringify(value,null,2));
}finally{ /* Synthetic fixture retained for audit; no production files touched. */ }
