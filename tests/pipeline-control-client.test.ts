import {describe,expect,it,vi} from 'vitest';
import {classifyPipelineControlFailure,requestPipelineControl} from '../functions/_lib/pipeline-control-client.js';

const payload={control:{historical_enabled:true,recent_enabled:false},backlog:{awaiting_collection:1},activity:{},jobs:{},health:{}};
const env={PIPELINE_WORKER_URL:'https://pipeline.example.workers.dev',PIPELINE_ADMIN_TOKEN:'shared-token'};

describe('Pages to Worker pipeline control client',()=>{
 it('performs an authenticated read without sending the token in its result',async()=>{const fetcher=vi.fn(async(_url:any,init:any)=>{expect(init.method).toBe('GET');expect(init.headers.authorization).toBe('Bearer shared-token');return new Response(JSON.stringify(payload),{status:200})});const result=await requestPipelineControl(env,undefined,{fetcher});expect(result.control.recent_enabled).toBe(false);expect(JSON.stringify(result)).not.toContain('shared-token');expect(fetcher).toHaveBeenCalledOnce();});
 it.each([[401,'WORKER_AUTH_FAILED'],[403,'WORKER_AUTH_FAILED'],[404,'WORKER_ROUTE_NOT_FOUND']])('classifies HTTP %i as %s',async(status,code)=>{await expect(requestPipelineControl(env,undefined,{fetcher:async()=>new Response(JSON.stringify({error:'x'}),{status})})).rejects.toMatchObject({code,status});});
 it('distinguishes Worker D1 failures',async()=>{await expect(requestPipelineControl(env,undefined,{fetcher:async()=>new Response(JSON.stringify({error:'pipeline_control_d1_failure'}),{status:503})})).rejects.toMatchObject({code:'WORKER_D1_FAILURE',status:503});});
 it('rejects invalid JSON and incompatible successful payloads',async()=>{await expect(requestPipelineControl(env,undefined,{fetcher:async()=>new Response('not-json',{status:200})})).rejects.toMatchObject({code:'WORKER_BAD_RESPONSE'});await expect(requestPipelineControl(env,undefined,{fetcher:async()=>new Response('{}',{status:200})})).rejects.toMatchObject({code:'WORKER_BAD_RESPONSE'});});
 it('distinguishes timeout, network and missing configuration',async()=>{expect(classifyPipelineControlFailure({networkError:Object.assign(Error('late'),{name:'TimeoutError'})})).toBe('WORKER_TIMEOUT');expect(classifyPipelineControlFailure({networkError:Error('offline')})).toBe('WORKER_NETWORK_ERROR');await expect(requestPipelineControl({},undefined,{fetcher:vi.fn()})).rejects.toMatchObject({code:'WORKER_CONFIG_MISSING'});});
});
