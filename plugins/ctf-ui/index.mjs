import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import path from 'node:path';
import {CtfUiController} from './controller.mjs';
const req=createRequire(path.join(process.env.DSH_NATIVE_PACKAGE_ROOT??'/opt/node24/lib/node_modules/@deepseek-ai/dsh','package.json'));
const {TypertRemoteService,Remote,RemoteError}=await import(pathToFileURL(req.resolve('@deepseek-ai/dsh-typert-protocol')).href);
const {default:z}=await import(pathToFileURL(req.resolve('@deepseek-ai/schemastery')).href);
const initializers=[];
export const name='dsh-ctf-ui';
export const inject=['agents','agentPresets','settings','typertGateway'];
class CtfUi extends TypertRemoteService{
  constructor(ctx){
    super(ctx,'ctfUi');for(const init of initializers)init.call(this);
    const settings=ctx.settings.register('ctf-mode',z.object({defaultPreference:z.union(['auto','solo','orchestrated']).default('auto')}),{applies:'live'});
    this.controller=new CtfUiController({getAgent:id=>ctx.agents.get(id),presetOf:agent=>ctx.agentPresets.composedPreset(agent.ctx),settings});
  }
  async status(request){try{return await this.controller.status(request);}catch(error){throw failure(error);}}
  async change(request){try{return await this.controller.change(request);}catch(error){throw failure(error);}}
  async defaults(request){try{return await this.controller.defaults(request);}catch(error){throw failure(error);}}
  async saveDefaults(request){try{return await this.controller.saveDefaults(request);}catch(error){throw failure(error);}}
}
function failure(error){return new RemoteError('gateway/bad-request',String(error.message).slice(0,500),{});}
// Official source-mode Remote metadata; no extra HTTP endpoint or authentication path.
for(const method of ['status','change','defaults','saveDefaults'])Remote(method)(CtfUi.prototype[method],{kind:'method',name:method,static:false,private:false,addInitializer:init=>initializers.push(init)});
export function apply(ctx){ctx.plugin(CtfUi);}
