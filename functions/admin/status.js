function response(data,status=200){return new Response(JSON.stringify(data),{status,headers:{'content-type':'application/json','cache-control':'no-store'}})}
export async function onRequestGet({request,env}) {
  if(!env.ADMIN_TOKEN||request.headers.get('authorization')!==`Bearer ${env.ADMIN_TOKEN}`) return response({error:'unauthorized'},401);
  if(!env.MOOVIBE_LIBRARY)return response({error:'MOOVIBE_LIBRARY binding missing'},503);
  const counts=await env.MOOVIBE_LIBRARY.prepare(`SELECT COUNT(*) movies,SUM(collection_status='complete') detailed,SUM(enrichment_status='complete') enriched,SUM(embedding_status='complete') embedded FROM movies`).first();
  const jobs=await env.MOOVIBE_LIBRARY.prepare(`SELECT status,type,COUNT(*) count,MAX(updated_at) last_update FROM pipeline_jobs GROUP BY status,type ORDER BY type,status`).all();
  const errors=await env.MOOVIBE_LIBRARY.prepare(`SELECT job_key,type,last_error,updated_at FROM pipeline_jobs WHERE last_error IS NOT NULL ORDER BY updated_at DESC LIMIT 20`).all();
  const queries=await env.MOOVIBE_LIBRARY.prepare(`SELECT COUNT(*) total,SUM(run_count>0) processed,SUM(status='running') running,MAX(last_run_at) last_run FROM collection_queries`).first();
  const state=await env.MOOVIBE_LIBRARY.prepare(`SELECT key,value,updated_at FROM system_state`).all();
  return response({ok:true,counts,jobs:jobs.results,queries,recent_errors:errors.results,state:state.results});
}
