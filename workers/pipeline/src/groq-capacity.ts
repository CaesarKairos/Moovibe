import { GroqError } from './groq-client';

const bounded = (value: unknown, fallback: number, ceiling: number) => {
  const n = Number(value ?? fallback);
  return Number.isFinite(n) && n >= 0 ? Math.min(n, ceiling) : 0;
};
export function capacityConfig(env: Record<string, unknown>) {
  const margin = bounded(env.GROQ_SAFETY_MARGIN, .1, .95);
  const safe = (name: string, fallback: number) => Math.floor(bounded(env[name], fallback, fallback) * (1 - margin));
  return { rpm: safe('GROQ_RPM', 30), rpd: safe('GROQ_RPD', 1000),
    tpm: safe('GROQ_TPM', 8000), tpd: safe('GROQ_TPD', 200000), margin,
    itpm: env.GROQ_ITPM == null ? null : safe('GROQ_ITPM', 8000),
    otpm: env.GROQ_OTPM == null ? null : safe('GROQ_OTPM', 8000) };
}
export const capacityDay = (now: number) => new Date(now).toISOString().slice(0, 10);
export function spacing(config: ReturnType<typeof capacityConfig>, reservation: number) {
  return Math.ceil(Math.max(60000, 60000 / config.rpm, reservation * 60000 / config.tpm,
    config.itpm == null ? 0 : reservation * 60000 / config.itpm,
    config.otpm == null ? 0 : 2048 * 60000 / config.otpm));
}
export async function reserveCapacity(db: D1Database, env: Record<string, unknown>, tokens: number, now = Date.now()) {
  const c = capacityConfig(env), day = capacityDay(now), interval = spacing(c, tokens);
  const denied = (seconds: number, reason: string): never => {
    const error = new GroqError(`Groq capacity deferred: ${reason}`);
    error.deferred = true; error.retryAfter = Math.max(1, seconds); throw error;
  };
  if (c.rpd < 1 || tokens > c.tpd) return denied(86400, 'configured daily budget insufficient');
  if (!Number.isFinite(interval) || tokens > c.tpm || tokens > (c.itpm ?? Infinity) || 2048 > (c.otpm ?? Infinity))
    return denied(86400, 'request reservation exceeds configured minute budget; review context/limits');
  try {
    const result = await db.prepare(`INSERT INTO groq_capacity(day,attempts,reserved_tokens,next_at) SELECT ?,1,?,? WHERE (NOT EXISTS (
        SELECT 1 FROM system_state WHERE key='gen_pilot_count:groq'
          AND json_extract(value,'$.day')=? AND COALESCE(json_extract(value,'$.count'),0)>0
      ) OR EXISTS (SELECT 1 FROM groq_capacity WHERE day=?))
      AND NOT EXISTS (SELECT 1 FROM groq_capacity WHERE day=? AND next_at>?)
      ON CONFLICT(day) DO UPDATE SET attempts=attempts+1,reserved_tokens=reserved_tokens+?,next_at=MAX(?,?+CAST((?*60000+MAX(1,server_tpm)-1)/MAX(1,server_tpm) AS INTEGER))
      WHERE next_at<=? AND attempts<MIN(?,server_rpd) AND reserved_tokens+?<=? AND ?<=server_tpm`)
      .bind(day,tokens,now+interval,day,day,capacityDay(now-86400000),now,tokens,now+interval,now,Math.ceil(tokens/(1-c.margin)),now,c.rpd,tokens,c.tpd,tokens).run();
    // The first insert also needs to obey zero/undersized budgets.
    if (result.meta.changes) return { day, tokens };
    const row = await db.prepare('SELECT * FROM groq_capacity WHERE day=?').bind(day).first<any>();
    if (!row) {
      const previous = await db.prepare('SELECT next_at FROM groq_capacity WHERE day=?').bind(capacityDay(now-86400000)).first<{next_at:number}>();
      if (previous && previous.next_at>now) return denied(Math.ceil((previous.next_at-now)/1000), 'minute budget across UTC rollover');
    }
    if (row && tokens > row.server_tpm) return denied(86400, 'reservation exceeds observed organization TPM');
    const daily = !row || row.attempts >= Math.min(c.rpd,row.server_rpd) || row.reserved_tokens + tokens > c.tpd;
    return denied(daily ? Math.ceil((Date.parse(day) + 86400000 - now)/1000) : Math.ceil((row.next_at-now)/1000), daily ? 'daily budget' : 'paced minute budget');
  } catch (error) {
    if (error instanceof GroqError) throw error;
    return denied(300, 'D1 unavailable; fail closed');
  }
}
export async function recordCapacity(db: D1Database, reservation: { day: string; tokens: number }, event: { usage?: any; error?: string; headers?: Record<string,string> }) {
  const u = event.usage;
  const valid = [u?.prompt_tokens,u?.completion_tokens,u?.total_tokens].every(n => Number.isSafeInteger(n) && n >= 0) && u.total_tokens >= u.prompt_tokens + u.completion_tokens;
  const prompt = valid ? u.prompt_tokens : 0, completion = valid ? u.completion_tokens : 0, total = valid ? u.total_tokens : 0;
  const cached = valid && Number.isSafeInteger(u?.prompt_tokens_details?.cached_tokens) ? Math.max(0,Math.min(prompt,u.prompt_tokens_details.cached_tokens)) : 0;
  // Use raw total conservatively. Cached tokens are visible, never forecast as guaranteed savings.
  const refund = valid ? reservation.tokens - total : 0;
  const bucket = String([256,512,1024,2048,4096,8192].find(n => total <= n) ?? 'overflow');
  const error = ['daily_429','daily_tokens_429','daily_requests_429','minute_tokens_429','minute_requests_429','rate_429','credential','invalid_json','transient','unknown'].includes(event.error || '') ? event.error! : 'success';
  await db.prepare(`UPDATE groq_capacity SET reserved_tokens=reserved_tokens-?, measured=measured+?,
    prompt_tokens=prompt_tokens+?,completion_tokens=completion_tokens+?,total_tokens=total_tokens+?,cached_tokens=cached_tokens+?,sum_squares=sum_squares+?,
    histogram=json_set(histogram,?,COALESCE(json_extract(histogram,?),0)+?),
    errors=json_set(errors,?,COALESCE(json_extract(errors,?),0)+1),headers=?,server_rpd=MIN(server_rpd,?,attempts+?),server_tpm=MIN(server_tpm,?) WHERE day=?`)
    .bind(refund,valid?1:0,prompt,completion,total,cached,total*total,`$."${bucket}"`,`$."${bucket}"`,valid?1:0,`$."${error}"`,`$."${error}"`,JSON.stringify(event.headers || {}),bounded(event.headers?.['x-ratelimit-limit-requests'],1000,1000),bounded(event.headers?.['x-ratelimit-remaining-requests'],1000,1000),bounded(event.headers?.['x-ratelimit-limit-tokens'],8000,8000),reservation.day).run();
}
export async function capacityStatus(db: D1Database, env: Record<string,unknown>) {
  const config = capacityConfig(env);
  const row = await db.prepare('SELECT * FROM groq_capacity WHERE day=?').bind(capacityDay(Date.now())).first<any>();
  const average = row?.measured ? row.total_tokens / row.measured : null;
  const histogram = JSON.parse(row?.histogram || '{}');
  const percentile = (p: number) => {
    if (!row?.measured) return null;
    let count = 0;
    for (const bound of ['256','512','1024','2048','4096','8192','overflow']) {
      count += Number(histogram[bound] || 0);
      if (count >= Math.ceil(row.measured*p)) return bound === 'overflow' ? '>8192' : Number(bound);
    }
    return null;
  };
  const finalized = await db.prepare("SELECT COUNT(*) n FROM movies WHERE enrichment_status='complete' AND enriched_at>=?").bind(capacityDay(Date.now())).first<any>();
  const waiting = await db.prepare("SELECT COUNT(*) n FROM pipeline_jobs WHERE type IN ('ENRICH_MOVIE','INDEX_MOVIE') AND status='queued' AND last_error LIKE '[GENERATION_DEFERRED]%Groq%'").first<any>();
  return { day_timezone:'UTC', next_admission_at: row?.next_at ? new Date(row.next_at).toISOString() : null, percentiles_raw_upper_bounds: {p50:percentile(.5),p90:percentile(.9),p95:percentile(.95)}, finalized_today: finalized?.n ?? 0, jobs_waiting_quota: waiting?.n ?? 0, d1_account_usage: null, config, billing: 'not_verified; manually confirm provider plans', ...row,
    average_raw_tokens: average, stddev_raw_tokens: average == null ? null : Math.sqrt(Math.max(0,row.sum_squares/row.measured-average*average)),
    estimated_remaining: average ? Math.max(0,Math.floor(Math.min(Math.min(config.rpd,row?.server_rpd ?? config.rpd)-(row?.attempts||0), (config.tpd-(row?.reserved_tokens||0))/average, Number(env.MOVIE_GENERATION_PILOT_LIMIT||3)-(row?.attempts||0)))) : null,
    accounting: 'raw measured totals plus conservative outstanding reservations; histogram percentiles are bucket bounds' };
}

// Scheduler hint only; the atomic gate remains authoritative under concurrency.
export async function plannedCapacity(db: D1Database, env: Record<string,unknown>, now = Date.now()) {
  const c = capacityConfig(env);
  const row = await db.prepare('SELECT attempts,reserved_tokens,server_rpd FROM groq_capacity WHERE day=?').bind(capacityDay(now)).first<any>();
  if (!row) {
    const legacy = await db.prepare("SELECT value FROM system_state WHERE key='gen_pilot_count:groq'").first<{value:string}>();
    if (legacy) { const prior=JSON.parse(legacy.value); if (prior.day===capacityDay(now) && prior.count>0) return 0; }
  }
  const remainingRequests = Math.max(0,Math.min(c.rpd,row?.server_rpd ?? c.rpd)-(row?.attempts || 0));
  // Even a minimal request must reserve completion + protocol framing.
  const remainingTokens = Math.max(0,c.tpd-(row?.reserved_tokens || 0));
  return Math.min(remainingRequests,Math.floor(remainingTokens/2304));
}
