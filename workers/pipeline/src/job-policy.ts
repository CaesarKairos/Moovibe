export const MAX_JOB_ATTEMPTS=5;
export const STALE_JOB_MINUTES=30;
export const DISCOVERY_BUDGET=2;
export const PIPELINE_BUDGET=50;

export const DISCOVERY_DUE_SQL=`SELECT query_id FROM collection_queries
  WHERE is_executable=1 AND status='pending'
    AND (next_run_at IS NULL OR next_run_at<=CURRENT_TIMESTAMP)
  ORDER BY COALESCE(last_run_at,''),query_id LIMIT ?`;

export const STALE_JOBS_SQL=`SELECT job_key,type,payload_json,attempts FROM pipeline_jobs
  WHERE status='running' AND updated_at < datetime('now', ?)
  ORDER BY updated_at LIMIT ?`;

export const MOVIE_BACKLOG_SQL=`SELECT tmdb_id,enrichment_status,embedding_status FROM movies
  WHERE collection_status='complete'
    AND (enrichment_status IN ('pending','error') OR embedding_status IN ('pending','error'))
  ORDER BY CASE WHEN enrichment_status='complete' THEN 0 ELSE 1 END, updated_at, tmdb_id LIMIT ?`;

export const stableDiscoveryKey=(queryId:string)=>`discover:${queryId}:v1`;
export const retryDelaySeconds=(attempt:number,retryAfter=0)=>retryAfter
  ?Math.min(43200,Math.max(60,retryAfter))
  :Math.min(3600,60*2**Math.max(0,attempt-1));
export const shouldRetry=(attempt:number)=>attempt<MAX_JOB_ATTEMPTS;
