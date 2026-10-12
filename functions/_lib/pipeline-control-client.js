const knownCodes=new Set(['WORKER_AUTH_FAILED','WORKER_ROUTE_NOT_FOUND','WORKER_TIMEOUT','WORKER_BAD_RESPONSE','WORKER_D1_FAILURE','WORKER_NETWORK_ERROR','WORKER_CONFIG_MISSING','WORKER_UNKNOWN_ERROR']);

export class PipelineControlError extends Error{
 constructor(code,details={}){super(code);this.name='PipelineControlError';this.code=knownCodes.has(code)?code:'WORKER_UNKNOWN_ERROR';this.status=details.status||null;this.duration_ms=details.duration_ms||null;this.worker_code=details.worker_code||null;}
}

export function classifyPipelineControlFailure({status,workerCode,networkError}={}){
 if(networkError?.name==='TimeoutError'||networkError?.name==='AbortError')return 'WORKER_TIMEOUT';
 if(networkError)return 'WORKER_NETWORK_ERROR';
 if(status===401||status===403)return 'WORKER_AUTH_FAILED';
 if(status===404)return 'WORKER_ROUTE_NOT_FOUND';
 if(workerCode==='pipeline_control_d1_failure'||workerCode==='D1_FAILURE')return 'WORKER_D1_FAILURE';
 if(status&&status>=500)return 'WORKER_UNKNOWN_ERROR';
 return 'WORKER_BAD_RESPONSE';
}

const validPayload=data=>data&&typeof data==='object'&&data.control&&typeof data.control.historical_enabled==='boolean'&&typeof data.control.recent_enabled==='boolean'&&data.backlog&&typeof data.backlog==='object';

export async function requestPipelineControl(env,body,options={}){
 if(!env.PIPELINE_WORKER_URL||!env.PIPELINE_ADMIN_TOKEN)throw new PipelineControlError('WORKER_CONFIG_MISSING');
 let url;try{url=new URL('/admin/pipeline-control',env.PIPELINE_WORKER_URL);}catch{throw new PipelineControlError('WORKER_CONFIG_MISSING');}
 const started=Date.now(),fetcher=options.fetcher||fetch;
 let result;
 try{result=await fetcher(url,{method:body?'POST':'GET',headers:{authorization:`Bearer ${env.PIPELINE_ADMIN_TOKEN}`,'content-type':'application/json'},body:body?JSON.stringify(body):undefined,signal:(options.signal||AbortSignal.timeout(15000))});}
 catch(error){throw new PipelineControlError(classifyPipelineControlFailure({networkError:error}),{duration_ms:Date.now()-started});}
 const duration_ms=Date.now()-started,text=await result.text().catch(()=>'');
 let data;try{data=text?JSON.parse(text):null;}catch{throw new PipelineControlError('WORKER_BAD_RESPONSE',{status:result.status,duration_ms});}
 if(!result.ok){const workerCode=typeof data?.error==='string'?data.error:null;throw new PipelineControlError(classifyPipelineControlFailure({status:result.status,workerCode}),{status:result.status,duration_ms,worker_code:workerCode});}
 if(!validPayload(data))throw new PipelineControlError('WORKER_BAD_RESPONSE',{status:result.status,duration_ms});
 return {...data,communication:{status:result.status,duration_ms}};
}
