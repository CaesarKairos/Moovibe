export const MAX_JOB_ATTEMPTS=5;
export const STALE_JOB_MINUTES=30;
export const RECENT_DISCOVERY_BUDGET=1;
export const HISTORICAL_DISCOVERY_BUDGET=1;
export const PIPELINE_BUDGET=20;
export const COLLECTION_BACKLOG_BUDGET=4;
export const ENRICHMENT_BACKLOG_BUDGET=8;
export const EMBEDDING_BACKLOG_BUDGET=8;

const DISCOVERY_DUE_BASE=`SELECT query_id FROM collection_queries
  WHERE is_executable=1 AND status='pending'
    AND (next_run_at IS NULL OR next_run_at<=CURRENT_TIMESTAMP)`;

// Separate lane queries guarantee that a permanently-due recent lane cannot
// consume the historical allocation (or vice versa).
export const RECENT_DISCOVERY_DUE_SQL=`${DISCOVERY_DUE_BASE}
    AND query_id LIKE 'recent-v2:%'
  ORDER BY COALESCE(last_run_at,''),query_id LIMIT ?`;
export const HISTORICAL_DISCOVERY_DUE_SQL=`${DISCOVERY_DUE_BASE}
    AND query_id LIKE 'history-v2:%'
  ORDER BY COALESCE(last_run_at,''),query_id LIMIT ?`;

export const STALE_JOBS_SQL=`SELECT job_key,type,payload_json,attempts FROM pipeline_jobs
  WHERE status='running' AND updated_at < datetime('now', ?)
  ORDER BY updated_at LIMIT ?`;

export const MOVIE_BACKLOG_SQL=`WITH candidates AS (
  SELECT tmdb_id,collection_status,enrichment_status,embedding_status,updated_at,
    CASE WHEN collection_status='discovered' THEN 'collection'
         WHEN enrichment_status IN ('pending','error') THEN 'enrichment'
         WHEN enrichment_status='complete' AND embedding_status IN ('pending','error') THEN 'embedding' END stage
  FROM movies
  WHERE collection_status='discovered'
     OR (collection_status='complete' AND (enrichment_status IN ('pending','error') OR embedding_status IN ('pending','error')))
), ranked AS (
  SELECT *,ROW_NUMBER() OVER(PARTITION BY stage ORDER BY updated_at,tmdb_id) stage_rank FROM candidates WHERE stage IS NOT NULL
)
SELECT tmdb_id,collection_status,enrichment_status,embedding_status FROM ranked
WHERE (stage='collection' AND stage_rank<=?) OR (stage='enrichment' AND stage_rank<=?) OR (stage='embedding' AND stage_rank<=?)
ORDER BY CASE stage WHEN 'collection' THEN 0 WHEN 'embedding' THEN 1 ELSE 2 END,stage_rank LIMIT ?`;

export const stableDiscoveryKey=(queryId:string)=>`discover:${queryId}:v1`;
export const retryDelaySeconds=(attempt:number,retryAfter=0)=>retryAfter
  ?Math.min(43200,Math.max(60,retryAfter))
  :Math.min(3600,60*2**Math.max(0,attempt-1));
export const shouldRetry=(attempt:number)=>attempt<MAX_JOB_ATTEMPTS;
