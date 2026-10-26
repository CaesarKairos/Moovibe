import { capacityConfig } from './groq-capacity';
// Recovery only changes durable intent. The ordinary outbox and consumers own
// publication, quotas, idempotency and actual completion.
export const recoveryCategory = (error: string) => error.match(/^\[([A-Z_]+)\]/)?.[1] || 'UNKNOWN';
export function recoveryEligibility(row: any) {
  if (row.status !== 'error') return 'job_not_terminal';
  if (row.movie_complete) return 'movie_already_complete';
  if (/INVALID_CREDENTIAL|INSUFFICIENT_CREDITS|INVALID_REQUEST|TMDb 40[134]/i.test(row.last_error || '')) return 'configuration_or_source_fix_required';
  try { const p=JSON.parse(row.payload_json); if (!p.tmdb_id && !p.query_id) return 'invalid_payload'; }
  catch { return 'invalid_payload'; }
  return null;
}
export async function diagnoseFailures(db: D1Database, filter = '', limit = 25) {
  const cap=Math.max(1,Math.min(50,Math.floor(Number(limit)||25)));
  const groups=await db.prepare(`SELECT type,CASE WHEN last_error LIKE '[%]%' THEN substr(last_error,2,instr(last_error,']')-2) ELSE 'UNKNOWN' END category,COUNT(*) count
    FROM pipeline_jobs WHERE status='error' GROUP BY type,category`).all<any>();
  const rows=await db.prepare(`SELECT j.*, (m.collection_status='complete' AND m.enrichment_status='complete' AND m.embedding_status='complete') movie_complete,
    (SELECT COUNT(*) FROM pipeline_attempts a WHERE a.job_key=j.job_key AND a.legacy=0) recorded_attempts,
    (SELECT COUNT(*) FROM pipeline_attempts a WHERE a.job_key=j.job_key AND a.outcome='failed') failed_attempts,
    (SELECT COALESCE(MAX(legacy_attempts),0) FROM pipeline_attempts a WHERE a.job_key=j.job_key) legacy_attempts,
    (SELECT json_group_array(json_object('at',started_at,'outcome',outcome,'error',error,'legacy',legacy,'legacy_attempts',legacy_attempts)) FROM (SELECT * FROM pipeline_attempts a WHERE a.job_key=j.job_key ORDER BY id DESC LIMIT 20)) history_json
    FROM pipeline_jobs j LEFT JOIN movies m ON m.tmdb_id=json_extract(j.payload_json,'$.tmdb_id')
    WHERE j.status='error' AND (?='' OR j.last_error LIKE ? ESCAPE '\\') ORDER BY j.updated_at,j.job_key LIMIT ?`)
    .bind(filter,`%${filter.replace(/[\\%_]/g,'\\$&')}%`,cap).all<any>();
  return {dry_run:true,groups:groups.results,items:rows.results.map(r=>({...r,history:JSON.parse(r.history_json||'[]'),category:recoveryCategory(r.last_error||''),ineligible_reason:recoveryEligibility(r),eligible:!recoveryEligibility(r)})),limit:cap};
}
export async function recoverFailures(db:D1Database, keys:string[]) {
  if(!Array.isArray(keys)||keys.length<1||keys.length>50||keys.some(k=>typeof k!=='string'||k.length>300)) throw Error('invalid_recovery_batch');
  const id=crypto.randomUUID();
  const statements=[db.prepare('INSERT INTO recovery_batches(id) VALUES(?)').bind(id)];
  for(const key of new Set(keys)) {
    const row=await db.prepare(`SELECT j.*,(m.collection_status='complete' AND m.enrichment_status='complete' AND m.embedding_status='complete') movie_complete FROM pipeline_jobs j LEFT JOIN movies m ON m.tmdb_id=json_extract(j.payload_json,'$.tmdb_id') WHERE j.job_key=?`).bind(key).first<any>();
    if(!row||recoveryEligibility(row)) continue;
    // batch is transactional on D1; guard the snapshot against concurrent recovery.
    statements.push(db.prepare(`INSERT INTO recovery_items(batch_id,job_key) SELECT ?,job_key FROM pipeline_jobs WHERE job_key=? AND status='error' AND updated_at=?`).bind(id,key,row.updated_at));
    statements.push(db.prepare(`UPDATE pipeline_jobs SET status='queued',attempts=0,last_error=NULL,available_at=CURRENT_TIMESTAMP,started_at=NULL,completed_at=NULL,updated_at=CURRENT_TIMESTAMP WHERE job_key=? AND status='error' AND EXISTS(SELECT 1 FROM recovery_items WHERE batch_id=? AND job_key=?)`).bind(key,id,key));
  }
  await db.batch(statements);
  return recoveryProgress(db,id);
}
export async function recoveryProgress(db:D1Database,id:string) {
  const rows=await db.prepare(`SELECT j.job_key,j.type,COALESCE(r.result,j.status) status,CASE WHEN r.result IS NOT NULL THEN r.result_error ELSE j.last_error END last_error,j.attempts,COALESCE(r.finished_at,j.completed_at) completed_at FROM recovery_items r JOIN pipeline_jobs j ON j.job_key=r.job_key WHERE r.batch_id=?`).bind(id).all<any>();
  const items=rows.results;
  return {batch_id:id,recovered:items.length,completed:items.filter(r=>r.status==='done').length,failed_again:items.filter(r=>r.status==='error').length,pending:items.filter(r=>!['done','error'].includes(r.status)).length,items};
}
export async function throughputStatus(db:D1Database,env:Record<string,unknown>={}) {
  const [jobs,completed,attempts,errors,capacity,queue,denial,publication]=await Promise.all([
    db.prepare(`SELECT COALESCE(SUM(status='queued' AND (available_at IS NULL OR available_at<=CURRENT_TIMESTAMP) AND (queue_lease_until IS NULL OR queue_lease_until<=CURRENT_TIMESTAMP)),0) ready,
      COALESCE(SUM(status='queued' AND queue_lease_until>CURRENT_TIMESTAMP),0) awaiting_lease,
      COALESCE(SUM(status='queued' AND available_at>CURRENT_TIMESTAMP),0) cooldown,
      COALESCE(SUM(status='queued' AND (last_error LIKE '[GENERATION_DEFERRED]%' OR publication_state='queue_quota')),0) awaiting_quota,
      COALESCE(SUM(status='error'),0) terminal,COALESCE(SUM(status='running'),0) running FROM pipeline_jobs`).first<any>(),
    db.prepare(`SELECT COUNT(*) unique_completed,COALESCE(SUM(completed_at>=datetime('now','-3 hours','start of day','+3 hours')),0) today,
      COALESCE(SUM(completed_at>=datetime('now','-1 hour')),0) last_hour,COALESCE(SUM(recovered),0) recovered_movies FROM movie_completions`).first<any>(),
    db.prepare(`SELECT total,failed,successful,deferred FROM pipeline_attempt_totals WHERE id=1`).first<any>(),
    db.prepare(`SELECT COUNT(DISTINCT json_extract(j.payload_json,'$.tmdb_id')) unique_movies FROM pipeline_jobs j LEFT JOIN movies m ON m.tmdb_id=json_extract(j.payload_json,'$.tmdb_id') WHERE j.status='error' AND NOT(COALESCE(m.collection_status,'')='complete' AND COALESCE(m.enrichment_status,'')='complete' AND COALESCE(m.embedding_status,'')='complete')`).first<any>(),
    db.prepare(`SELECT * FROM groq_capacity WHERE day=date('now')`).first<any>(),
    db.prepare(`SELECT * FROM queue_transport WHERE id=1`).first<any>(),
    db.prepare(`SELECT value FROM system_state WHERE key='groq_last_denial'`).first<any>(),
    db.prepare(`SELECT publication_state,COUNT(*) count FROM pipeline_jobs WHERE status='queued' GROUP BY publication_state`).all<any>()
  ]);
  const blocked=queue?.blocked_until && Date.parse(queue.blocked_until+'Z')>Date.now();
  const config=capacityConfig(env);
  let recentDenial:any=null;try{recentDenial=JSON.parse(denial?.value||'null');}catch{}
  const reasons:string[]=[];
  if(blocked) reasons.push(queue.reason||'QUEUE_BLOCKED');
  if(env.QUEUE_LOCAL_ADMISSION_ENABLED!=='false' && queue?.day===new Date().toISOString().slice(0,10)&&queue.estimated_operations+3>8000) reasons.push('QUEUE_LOCAL_BUDGET');
  if(env.GROQ_CAPACITY_MODE!=='provider' && recentDenial?.until>Date.now()) reasons.push(recentDenial.reason);
  if(env.GROQ_CAPACITY_MODE!=='provider' && capacity?.reserved_tokens>=config.tpd) reasons.push('GROQ_TPD');
  if(env.GROQ_CAPACITY_MODE!=='provider' && capacity?.attempts>=Math.min(config.rpd,capacity?.server_rpd??config.rpd,capacity?.server_daily_ceiling??config.rpd)) reasons.push('GROQ_RPD');
  if(capacity?.attempts>=Math.min(800,Number(env.MOVIE_GENERATION_PILOT_LIMIT??800))) reasons.push('ADMIN_ATTEMPT_CAP');
  if(capacity?.next_at>Date.now()) reasons.push('PROVIDER_COOLDOWN');
  if(jobs.ready&&!jobs.running) reasons.push('READY_WITHOUT_EXECUTION_EVIDENCE');
  if(jobs.awaiting_lease) reasons.push('AWAITING_DELIVERY');
  if(jobs.awaiting_quota) reasons.push('QUOTA_COOLDOWN');
  if(jobs.terminal) reasons.push('TERMINAL_ERRORS');
  const bottleneck=reasons[0]||'NO_CONFIRMED_BOTTLENECK';
  return {time_zone:'America/Sao_Paulo',jobs,completed,attempts,unique_movies_in_error:errors?.unique_movies||0,movies_per_hour:completed?.last_hour||0,daily_projection:(completed?.last_hour||0)*24,bottleneck,bottleneck_reasons:[...new Set(reasons)],publication_states:publication.results,last_groq_denial:recentDenial,groq_measured_tokens:capacity?.total_tokens||0,queue_estimated_operations:queue?.estimated_operations||0,queue_account_measured_operations:null,consumer_status:'unknown_without_account_metrics',history_coverage:'attempts since migration; original terminal errors preserved as legacy snapshots'};
}
