import { GeminiClient, RetryableError } from '../../../functions/_lib/gemini.js';
import { buildMovieDocument, EMBEDDING_SCHEMA_VERSION } from '../../../functions/_lib/recommender.js';
import { discoveryQueries } from './queries';
import { HISTORICAL_DISCOVERY_BUDGET,HISTORICAL_DISCOVERY_DUE_SQL,MOVIE_BACKLOG_SQL,PIPELINE_BUDGET,RECENT_DISCOVERY_BUDGET,RECENT_DISCOVERY_DUE_SQL,STALE_JOBS_SQL,STALE_JOB_MINUTES,retryDelaySeconds,shouldRetry,stableDiscoveryKey } from './job-policy';

type JobType='DISCOVER_QUERY'|'FETCH_MOVIE'|'ENRICH_MOVIE'|'EMBED_MOVIE'|'REFRESH_MOVIE'|'REEMBED_MOVIE';
type Job={ type:JobType; key:string; payload:Record<string,unknown> };
interface Env {
  MOOVIBE_LIBRARY:D1Database; MOVIE_VECTORS:VectorizeIndex; PIPELINE_QUEUE:Queue<Job>;
  GEMINI_API_KEY:string; TMDB_API_KEY:string; ADMIN_TOKEN?:string;
  EMBEDDING_MODEL:string; EMBEDDING_DIMENSIONS:string; EMBEDDING_SCHEMA_VERSION:string;
}
const TMDB='https://api.themoviedb.org/3';
const json=(data:unknown,status=200)=>new Response(JSON.stringify(data),{status,headers:{'content-type':'application/json'}});
const log=(event:string,data:Record<string,unknown>={})=>console.log(JSON.stringify({service:'moovibe-pipeline',event,at:new Date().toISOString(),...data}));

async function tmdb(env:Env,path:string,params:Record<string,unknown>={}) {
  const url=new URL(TMDB+path); url.searchParams.set('api_key',env.TMDB_API_KEY);
  for(const [k,v] of Object.entries(params)) if(v!==undefined) url.searchParams.set(k,String(v));
  const response=await fetch(url,{headers:{'User-Agent':'Moovibe/2.0'}});
  if([429,500,502,503,504].includes(response.status)) throw new RetryableError(`TMDb transient ${response.status}`,Number(response.headers.get('Retry-After')||0));
  if(!response.ok) throw new Error(`TMDb ${response.status}: ${(await response.text()).slice(0,300)}`);
  return response.json<any>();
}

async function enqueue(env:Env,job:Job) {
  const result=await env.MOOVIBE_LIBRARY.prepare(`INSERT INTO pipeline_jobs(job_key,type,payload_json,status,available_at) VALUES(?,?,?,'queued',CURRENT_TIMESTAMP) ON CONFLICT(job_key) DO UPDATE SET type=excluded.type,payload_json=excluded.payload_json,status='queued',attempts=0,last_error=NULL,available_at=CURRENT_TIMESTAMP,started_at=NULL,completed_at=NULL,updated_at=CURRENT_TIMESTAMP WHERE pipeline_jobs.status IN ('done','error') AND (pipeline_jobs.available_at IS NULL OR pipeline_jobs.available_at<=CURRENT_TIMESTAMP)`).bind(job.key,job.type,JSON.stringify(job.payload)).run();
  if(result.meta.changes) await env.PIPELINE_QUEUE.send(job);
  return Boolean(result.meta.changes);
}

const DISCOVERY_SEED_KEY='discovery_seed_version';
type SeedResult={skipped:boolean;inserted:number;updated:number;unchanged:number};

// Static discovery definitions are content-hashed so the cron can detect code
// changes with a single 1-row read instead of rewriting every query each run.
async function discoverySeedVersion():Promise<string> {
  const canonical=discoveryQueries().map(q=>`${q.id}\n${q.label}\n${JSON.stringify(q.params)}`).join('\n');
  const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(canonical));
  return [...new Uint8Array(digest)].map(b=>b.toString(16).padStart(2,'0')).join('');
}

// Differential seed: reads current rows first and writes only definitions that
// are genuinely new or changed, so a second run over unchanged definitions
// performs zero row writes. legacy-* provenance rows are never selected as
// targets, inserted, or updated (is_executable stays 0 and untouched).
async function seedQueries(env:Env):Promise<Omit<SeedResult,'skipped'>> {
  const definitions=discoveryQueries();
  const existing=await env.MOOVIBE_LIBRARY.prepare(`SELECT query_id,label,params_json,is_executable FROM collection_queries WHERE query_id NOT LIKE 'legacy-%'`).all<{query_id:string;label:string;params_json:string;is_executable:number}>();
  const rows=new Map(existing.results.map(r=>[r.query_id,r]));
  const statements:D1PreparedStatement[]=[];
  let inserted=0,updated=0,unchanged=0;
  for(const q of definitions) {
    const params=JSON.stringify(q.params);
    const row=rows.get(q.id);
    if(!row) {
      statements.push(env.MOOVIBE_LIBRARY.prepare(`INSERT INTO collection_queries(query_id,label,params_json,is_executable,status,next_run_at) VALUES(?,?,?,1,'pending',CURRENT_TIMESTAMP) ON CONFLICT(query_id) DO NOTHING`).bind(q.id,q.label,params));
      inserted++;
    } else if(row.label!==q.label||row.params_json!==params||row.is_executable!==1) {
      statements.push(env.MOOVIBE_LIBRARY.prepare(`UPDATE collection_queries SET label=?,params_json=?,is_executable=1 WHERE query_id=? AND query_id NOT LIKE 'legacy-%'`).bind(q.label,params,q.id));
      updated++;
    } else unchanged++;
  }
  for(let i=0;i<statements.length;i+=80) await env.MOOVIBE_LIBRARY.batch(statements.slice(i,i+80));
  return {inserted,updated,unchanged};
}

// Bootstrap/sync separated from the cron hot path: runs only when the stored
// definition version differs from the code (fresh database or a deploy that
// added/changed discovery queries), or when forced via POST /admin/seed.
async function syncDiscoverySeed(env:Env,force=false):Promise<SeedResult> {
  const version=await discoverySeedVersion();
  const stored=await env.MOOVIBE_LIBRARY.prepare(`SELECT value FROM system_state WHERE key=?`).bind(DISCOVERY_SEED_KEY).first<{value:string}>();
  if(!force&&stored?.value===version) return {skipped:true,inserted:0,updated:0,unchanged:discoveryQueries().length};
  const result=await seedQueries(env);
  if(stored?.value!==version) await env.MOOVIBE_LIBRARY.prepare(`INSERT INTO system_state(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=CURRENT_TIMESTAMP`).bind(DISCOVERY_SEED_KEY,version).run();
  log('discovery_seed_sync',{...result});
  return {skipped:false,...result};
}

async function recoverJobs(env:Env) {
  const stale=await env.MOOVIBE_LIBRARY.prepare(STALE_JOBS_SQL).bind(`-${STALE_JOB_MINUTES} minutes`,100).all<Job&{job_key:string;payload_json:string;attempts:number}>();
  let recovered=0;
  for(const row of stale.results) {
    const error=`stale lease recovered after ${STALE_JOB_MINUTES} minutes`;
    const changed=await env.MOOVIBE_LIBRARY.prepare(`UPDATE pipeline_jobs SET status='queued',last_error=?,available_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE job_key=? AND status='running' AND updated_at < datetime('now',?)`).bind(error,row.job_key,`-${STALE_JOB_MINUTES} minutes`).run();
    if(changed.meta.changes){
      const payload=JSON.parse(row.payload_json);
      if(row.type==='DISCOVER_QUERY')await env.MOOVIBE_LIBRARY.prepare(`UPDATE collection_queries SET status='pending',last_error=?,updated_at=CURRENT_TIMESTAMP WHERE query_id=? AND is_executable=1 AND status='running'`).bind(error,String(payload.query_id)).run();
      await env.PIPELINE_QUEUE.send({type:row.type as JobType,key:row.job_key,payload});recovered++;log('job_retry',{job_key:row.job_key,type:row.type,attempt:row.attempts,error});
    }
  }
  // Outbox repair: a crash between the D1 insert and Queue.send must not strand work.
  const stranded=await env.MOOVIBE_LIBRARY.prepare(`SELECT job_key,type,payload_json FROM pipeline_jobs WHERE status='queued' AND updated_at<datetime('now','-5 minutes') AND (available_at IS NULL OR available_at<=CURRENT_TIMESTAMP) ORDER BY updated_at LIMIT 100`).all<any>();
  for(const row of stranded.results){await env.PIPELINE_QUEUE.send({type:row.type,key:row.job_key,payload:JSON.parse(row.payload_json)});await env.MOOVIBE_LIBRARY.prepare(`UPDATE pipeline_jobs SET updated_at=CURRENT_TIMESTAMP WHERE job_key=? AND status='queued'`).bind(row.job_key).run();}
  return {stale:recovered,stranded:stranded.results.length};
}

// Failures caused by bugs that are already fixed in code. Only these exact
// error fingerprints are requeued, so a general backlog of unrelated terminal
// errors is never touched.
const KNOWN_FAILURE_RULES:{type:'ENRICH_MOVIE'|'FETCH_MOVIE';like:string;reason:string}[]=[
  {type:'ENRICH_MOVIE',like:'%Illegal invocation%',reason:'GeminiClient fetch binding fixed'},
  {type:'FETCH_MOVIE',like:'%UNIQUE constraint failed: genres.name%',reason:'genre identity resolution fixed'}
];

// Idempotent, authenticated recovery of known fixed failures: conditional
// status='error' → 'queued' transition (never duplicates an active job), zeroed
// attempts, cleared last_error, available_at=now, a Queue message per job and —
// for FETCH — honest movie state so the film can really be processed again.
async function requeueKnownFailures(env:Env) {
  const requeued:{ENRICH_MOVIE:number;FETCH_MOVIE:number}={ENRICH_MOVIE:0,FETCH_MOVIE:0};
  let moviesReset=0;
  for(const rule of KNOWN_FAILURE_RULES) {
    const rows=await env.MOOVIBE_LIBRARY.prepare(`SELECT job_key,payload_json FROM pipeline_jobs WHERE status='error' AND type=? AND last_error LIKE ?`).bind(rule.type,rule.like).all<{job_key:string;payload_json:string}>();
    for(const row of rows.results) {
      const changed=await env.MOOVIBE_LIBRARY.prepare(`UPDATE pipeline_jobs SET status='queued',attempts=0,last_error=NULL,available_at=CURRENT_TIMESTAMP,started_at=NULL,completed_at=NULL,updated_at=CURRENT_TIMESTAMP WHERE job_key=? AND status='error'`).bind(row.job_key).run();
      if(!changed.meta.changes) continue;
      const payload=JSON.parse(row.payload_json);
      if(rule.type==='FETCH_MOVIE') {
        // The old lifecycle marked the movie complete before relations finished.
        const reset=await env.MOOVIBE_LIBRARY.prepare(`UPDATE movies SET collection_status='discovered',last_error=? WHERE tmdb_id=? AND collection_status='complete'`).bind(`requeued after ${rule.reason}`,Number(payload.tmdb_id)).run();
        if(reset.meta.changes) moviesReset++;
      }
      await env.PIPELINE_QUEUE.send({type:rule.type,key:row.job_key,payload});
      requeued[rule.type]++;
    }
  }
  const total=requeued.ENRICH_MOVIE+requeued.FETCH_MOVIE;
  log('requeue_known_failures',{enrich_movie:requeued.ENRICH_MOVIE,fetch_movie:requeued.FETCH_MOVIE,movies_reset:moviesReset});
  return {requeued,total,movies_reset:moviesReset,known_rules:KNOWN_FAILURE_RULES.map(r=>({type:r.type,reason:r.reason}))};
}

async function schedule(env:Env) {
  // Version-gated bootstrap/sync: one 1-row read per cron and zero row writes
  // while definitions are unchanged. A seed failure must not stall the cron.
  try { await syncDiscoverySeed(env); } catch(error:any) { log('discovery_seed_failed',{error:String(error?.message||error).slice(0,300)}); }
  const recovery=await recoverJobs(env);
  // Existing library work is enqueued first and receives almost all of each cron budget.
  const pending=await env.MOOVIBE_LIBRARY.prepare(MOVIE_BACKLOG_SQL).bind(PIPELINE_BUDGET).all<any>();
  let pipelineQueued=0;
  for(const movie of pending.results) {
    if(movie.enrichment_status!=='complete') pipelineQueued+=Number(await enqueue(env,{type:'ENRICH_MOVIE',key:`enrich:${movie.tmdb_id}:v2`,payload:{tmdb_id:movie.tmdb_id}}));
    else if(movie.embedding_status!=='complete') pipelineQueued+=Number(await enqueue(env,{type:'EMBED_MOVIE',key:`embed:${movie.tmdb_id}:${EMBEDDING_SCHEMA_VERSION}`,payload:{tmdb_id:movie.tmdb_id}}));
  }
  const [recentDue,historicalDue]=await Promise.all([
    env.MOOVIBE_LIBRARY.prepare(RECENT_DISCOVERY_DUE_SQL).bind(RECENT_DISCOVERY_BUDGET).all<{query_id:string}>(),
    env.MOOVIBE_LIBRARY.prepare(HISTORICAL_DISCOVERY_DUE_SQL).bind(HISTORICAL_DISCOVERY_BUDGET).all<{query_id:string}>()
  ]);
  let recentDiscoveryQueued=0,historicalDiscoveryQueued=0;
  for(const q of recentDue.results) if(await enqueue(env,{type:'DISCOVER_QUERY',key:stableDiscoveryKey(q.query_id),payload:{query_id:q.query_id}})) recentDiscoveryQueued++;
  for(const q of historicalDue.results) if(await enqueue(env,{type:'DISCOVER_QUERY',key:stableDiscoveryKey(q.query_id),payload:{query_id:q.query_id}})) historicalDiscoveryQueued++;
  const discoveryQueued=recentDiscoveryQueued+historicalDiscoveryQueued;
  await env.MOOVIBE_LIBRARY.prepare(`INSERT INTO system_state(key,value) VALUES('last_cron_at',CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET value=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP`).run();
  log('cron_complete',{pipeline_jobs:pipelineQueued,discovery_jobs:discoveryQueued,recent_discovery_jobs:recentDiscoveryQueued,historical_discovery_jobs:historicalDiscoveryQueued,pipeline_candidates:pending.results.length,recovered_stale:recovery.stale,recovered_stranded:recovery.stranded});
}

// Reserved static keys describe a RUNTIME window: concrete dates are computed
// on every execution and never persisted, so query ids and the discovery seed
// version stay stable regardless of the day.
const RESERVED_DISCOVERY_KEYS=['lane','lookback_days','upcoming_days'];
const isoDay=(d:Date)=>d.toISOString().slice(0,10);
const HISTORICAL_PAGES_PER_JOB=5;
const RECENT_PAGES_PER_JOB=3;
const DISCOVERY_JOB_TIME_LIMIT_MS=25_000;
const RECENT_MAX_PAGES_PER_CYCLE:Record<string,number>={
  'recent-global-30':10,
  'recent-global-120':20,
  'recent-popular-30':10,
  'upcoming-global-60':10,
  'newest-global':5
};

async function discover(env:Env,job:Job) {
  const id=String(job.payload.query_id);
  const row=await env.MOOVIBE_LIBRARY.prepare(`SELECT * FROM collection_queries WHERE query_id=? AND is_executable=1 AND status='pending'`).bind(id).first<any>();
  if(!row) return;
  const startPage=Math.max(1,Number(row.next_page)||1);
  const stored=JSON.parse(row.params_json);
  const params:{[k:string]:unknown}={...stored};
  const lane=String(params.lane||'');
  const lookbackDays=Number(params.lookback_days||0);
  const upcomingDays=Number(params.upcoming_days||0);
  for(const key of RESERVED_DISCOVERY_KEYS) delete params[key];
  const now=new Date();
  if(upcomingDays>0) {
    params['primary_release_date.gte']=isoDay(now);
    params['primary_release_date.lte']=isoDay(new Date(now.getTime()+upcomingDays*86400000));
  } else if(lookbackDays>0) {
    params['primary_release_date.gte']=isoDay(new Date(now.getTime()-lookbackDays*86400000));
    params['primary_release_date.lte']=isoDay(now);
  }
  params.include_adult=false; params.include_video=false;
  const claimed=await env.MOOVIBE_LIBRARY.prepare(`UPDATE collection_queries SET status='running',last_run_at=CURRENT_TIMESTAMP,run_count=run_count+1,updated_at=CURRENT_TIMESTAMP WHERE query_id=? AND is_executable=1 AND status='pending'`).bind(id).run();
  if(!claimed.meta.changes)return;
  const recent=lane==='recent';
  const pagesPerJob=recent?RECENT_PAGES_PER_JOB:HISTORICAL_PAGES_PER_JOB;
  const cyclePageLimit=recent?(RECENT_MAX_PAGES_PER_CYCLE[id]??10):500;
  const startedAt=Date.now();
  let nextPage=startPage,totalPages=Math.max(1,Number(row.total_pages)||1),pagesProcessed=0,resultsSeen=0,newMovies=0,newFetchJobs=0,cycleComplete=false;
  try {
    while(pagesProcessed<pagesPerJob&&nextPage<=500&&nextPage<=cyclePageLimit) {
      if(pagesProcessed>0&&Date.now()-startedAt>=DISCOVERY_JOB_TIME_LIMIT_MS) break;
      const page=nextPage;
      const data=await tmdb(env,'/discover/movie',{...params,page});
      const results=Array.isArray(data.results)?data.results:[];
      totalPages=Math.min(Math.max(1,Number(data.total_pages)||1),500);
      for(const item of results) {
        if(!item.id || !item.title || (!item.overview && !item.release_date)) continue;
        const existing=await env.MOOVIBE_LIBRARY.prepare(`SELECT id,collection_status FROM movies WHERE tmdb_id=?`).bind(item.id).first<any>();
        // The upsert only writes when a tracked value would actually change, so
        // re-running a query over unchanged rows costs zero row writes.
        await env.MOOVIBE_LIBRARY.prepare(`INSERT INTO movies(tmdb_id,title,original_title,overview,release_date,release_year,original_language,popularity,vote_average,vote_count,poster_path,backdrop_path,adult,video) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(tmdb_id) DO UPDATE SET title=excluded.title,overview=CASE WHEN movies.overview IS NULL OR movies.overview='' THEN excluded.overview ELSE movies.overview END,release_date=excluded.release_date,release_year=excluded.release_year,original_language=excluded.original_language,popularity=excluded.popularity,vote_average=excluded.vote_average,vote_count=excluded.vote_count,poster_path=excluded.poster_path,backdrop_path=excluded.backdrop_path,updated_at=CURRENT_TIMESTAMP WHERE movies.title IS NOT excluded.title OR ((movies.overview IS NULL OR movies.overview='') AND IFNULL(excluded.overview,'')<>'') OR movies.release_date IS NOT excluded.release_date OR movies.release_year IS NOT excluded.release_year OR movies.original_language IS NOT excluded.original_language OR movies.popularity IS NOT excluded.popularity OR movies.vote_average IS NOT excluded.vote_average OR movies.vote_count IS NOT excluded.vote_count OR movies.poster_path IS NOT excluded.poster_path OR movies.backdrop_path IS NOT excluded.backdrop_path`).bind(item.id,item.title,item.original_title,item.overview,item.release_date,Number(String(item.release_date||'').slice(0,4))||null,item.original_language,item.popularity,item.vote_average,item.vote_count,item.poster_path,item.backdrop_path,item.adult?1:0,item.video?1:0).run();
        const movie=existing||await env.MOOVIBE_LIBRARY.prepare(`SELECT id,collection_status FROM movies WHERE tmdb_id=?`).bind(item.id).first<any>();
        if(!existing)newMovies++;
        // Membership refresh is throttled to at most one write per week per row.
        await env.MOOVIBE_LIBRARY.prepare(`INSERT INTO movie_discovery_sources(movie_id,query_id) VALUES(?,?) ON CONFLICT(movie_id,query_id) DO UPDATE SET last_seen_at=CURRENT_TIMESTAMP WHERE movie_discovery_sources.last_seen_at IS NULL OR movie_discovery_sources.last_seen_at<datetime('now','-7 days')`).bind(movie.id,id).run();
        if(movie.collection_status==='discovered'&&await enqueue(env,{type:'FETCH_MOVIE',key:`fetch:${item.id}:v1`,payload:{tmdb_id:item.id}})) newFetchJobs++;
      }
      pagesProcessed++; resultsSeen+=results.length; nextPage=page+1;
      if(results.length===0||page>=totalPages||page>=500||page>=cyclePageLimit) {cycleComplete=true;nextPage=1;break;}
    }
  } catch(error) {
    // Persist only fully completed pages. The failing page remains next.
    await env.MOOVIBE_LIBRARY.prepare(`UPDATE collection_queries SET next_page=?,total_pages=?,updated_at=CURRENT_TIMESTAMP WHERE query_id=?`).bind(nextPage,totalPages,id).run();
    throw error;
  }
  const delay=cycleComplete?(recent?'+4 hours':'+30 days'):'+15 minutes';
  await env.MOOVIBE_LIBRARY.prepare(`UPDATE collection_queries SET next_page=?,total_pages=?,status='pending',next_run_at=datetime('now',?),last_error=NULL,updated_at=CURRENT_TIMESTAMP WHERE query_id=?`).bind(nextPage,totalPages,delay,id).run();
  log('discovery_complete',{query_id:id,lane:recent?'recent':'historical',start_page:startPage,end_page:pagesProcessed?nextPage===1?Math.min(startPage+pagesProcessed-1,cyclePageLimit):nextPage-1:startPage,pages_processed:pagesProcessed,results_seen:resultsSeen,new_movies:newMovies,new_fetch_jobs:newFetchJobs,next_page:nextPage,cycle_complete:cycleComplete});
}

// Genre identity resolution. genres.name is UNIQUE while ids come from TMDb and
// from legacy imports, so a blind upsert can violate UNIQUE(genres.name) when
// the same name already exists under a different id. The name is treated as the
// canonical identity: reuse an existing row when the name exists, rename in
// place only when the name is still free, insert only genuinely new genres and
// never rewrite a PK that already has FKs pointing at it. Unresolvable
// inconsistencies are logged instead of being fixed destructively.
async function resolveGenreStatements(env:Env,movieId:number,details:any):Promise<D1PreparedStatement[]> {
  const wanted:{id:number;name:string}[]=(details.genres||[]).filter((g:any)=>g&&g.id&&g.name).map((g:any)=>({id:Number(g.id),name:String(g.name)}));
  if(!wanted.length) return [];
  const ids=wanted.map(g=>g.id), names=wanted.map(g=>g.name);
  const existing=await env.MOOVIBE_LIBRARY.prepare(`SELECT id,name FROM genres WHERE id IN (${ids.map(()=>'?').join(',')}) OR name IN (${names.map(()=>'?').join(',')})`).bind(...ids,...names).all<{id:number;name:string}>();
  const byId=new Map(existing.results.map(r=>[Number(r.id),r.name]));
  const byName=new Map(existing.results.map(r=>[r.name,Number(r.id)]));
  const statements:D1PreparedStatement[]=[];
  const conflicts:{tmdb_id:number;name:string;canonical_id:number}[]=[];
  for(const g of wanted) {
    let canonical=g.id;
    const owner=byName.get(g.name);
    if(owner!==undefined) {
      // Same name already exists (possibly under another/legacy id): reuse it.
      canonical=owner;
      if(owner!==g.id) conflicts.push({tmdb_id:g.id,name:g.name,canonical_id:owner});
    } else if(byId.has(g.id)) {
      // Same id with a stale name and the new name is free: guarded rename.
      statements.push(env.MOOVIBE_LIBRARY.prepare(`UPDATE genres SET name=? WHERE id=? AND NOT EXISTS(SELECT 1 FROM genres WHERE name=?)`).bind(g.name,g.id,g.name));
      byName.set(g.name,g.id);
    } else {
      // Genuinely new genre. OR IGNORE tolerates concurrent inserts; a rare
      // FK miss on the relation below fails the batch and retries cleanly.
      statements.push(env.MOOVIBE_LIBRARY.prepare(`INSERT OR IGNORE INTO genres(id,name) VALUES(?,?)`).bind(g.id,g.name));
      byName.set(g.name,g.id); byId.set(g.id,g.name);
    }
    statements.push(env.MOOVIBE_LIBRARY.prepare(`INSERT OR IGNORE INTO movie_genres(movie_id,genre_id) VALUES(?,?)`).bind(movieId,canonical));
  }
  if(conflicts.length) log('genre_identity_conflict',{movie_id:movieId,conflicts});
  return statements;
}

async function replaceRelations(env:Env,movieId:number,details:any,credits:any,keywords:any) {
  const statements:D1PreparedStatement[]=await resolveGenreStatements(env,movieId,details);
  for(const c of details.production_countries||[]) statements.push(env.MOOVIBE_LIBRARY.prepare(`INSERT INTO countries(iso_3166_1,name) VALUES(?,?) ON CONFLICT(iso_3166_1) DO UPDATE SET name=excluded.name`).bind(c.iso_3166_1,c.name),env.MOOVIBE_LIBRARY.prepare(`INSERT OR IGNORE INTO movie_countries(movie_id,country_code) VALUES(?,?)`).bind(movieId,c.iso_3166_1));
  for(const l of details.spoken_languages||[]) statements.push(env.MOOVIBE_LIBRARY.prepare(`INSERT INTO languages(iso_639_1,name) VALUES(?,?) ON CONFLICT(iso_639_1) DO UPDATE SET name=excluded.name`).bind(l.iso_639_1,l.english_name||l.name),env.MOOVIBE_LIBRARY.prepare(`INSERT OR IGNORE INTO movie_languages(movie_id,language_code) VALUES(?,?)`).bind(movieId,l.iso_639_1));
  for(const k of keywords.keywords||[]) statements.push(env.MOOVIBE_LIBRARY.prepare(`INSERT INTO keywords(id,name) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name`).bind(k.id,k.name),env.MOOVIBE_LIBRARY.prepare(`INSERT OR IGNORE INTO movie_keywords(movie_id,keyword_id) VALUES(?,?)`).bind(movieId,k.id));
  for(const p of (credits.crew||[]).filter((x:any)=>x.job==='Director'||['Directing','Writing','Camera','Sound'].includes(x.department)).slice(0,30)) statements.push(env.MOOVIBE_LIBRARY.prepare(`INSERT INTO people(id,name,original_name,known_for_department) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name`).bind(p.id,p.name,p.original_name,p.known_for_department),env.MOOVIBE_LIBRARY.prepare(`INSERT OR IGNORE INTO movie_credits(movie_id,person_id,department,job,credit_order) VALUES(?,?,?,?,?)`).bind(movieId,p.id,p.department,p.job,p.order||0));
  for(let i=0;i<statements.length;i+=80) await env.MOOVIBE_LIBRARY.batch(statements.slice(i,i+80));
}

async function fetchMovie(env:Env,job:Job) {
  const id=Number(job.payload.tmdb_id);
  const details=await tmdb(env,`/movie/${id}`,{language:'en-US',append_to_response:'credits,keywords,external_ids'});
  const movie=await env.MOOVIBE_LIBRARY.prepare(`SELECT id FROM movies WHERE tmdb_id=?`).bind(id).first<any>();
  if(!movie)return;
  const director=details.credits?.crew?.find((p:any)=>p.job==='Director')?.name||null;
  // 1) Persist details only — collection_status stays 'discovered' until every
  //    relation below is written, so a mid-flight failure can never look like a
  //    fully processed movie.
  await env.MOOVIBE_LIBRARY.prepare(`UPDATE movies SET title=?,original_title=?,overview=?,release_date=?,release_year=?,original_language=?,runtime=?,popularity=?,vote_average=?,vote_count=?,poster_path=?,backdrop_path=?,tagline=?,tmdb_status=?,homepage=?,imdb_id=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`).bind(details.title,details.original_title,details.overview,details.release_date,Number(String(details.release_date||'').slice(0,4))||null,details.original_language,details.runtime,details.popularity,details.vote_average,details.vote_count,details.poster_path,details.backdrop_path,details.tagline,details.status,details.homepage,details.imdb_id||details.external_ids?.imdb_id,movie.id).run();
  // 2) Relations: genres, countries, languages, keywords, credits. Related
  //    writes go through D1 batch (transactional); HTTP stays outside it.
  try {
    await replaceRelations(env,movie.id,details,details.credits||{},details.keywords||{});
  } catch(error:any) {
    // Keep the failure observable on the movie; processJob writes the job's
    // last_error and retry/backoff keeps working. Nothing is marked complete.
    await env.MOOVIBE_LIBRARY.prepare(`UPDATE movies SET last_error=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`).bind(String(error?.message||error).slice(0,300),movie.id).run();
    throw error;
  }
  // 3) Only now is the movie genuinely complete.
  await env.MOOVIBE_LIBRARY.prepare(`UPDATE movies SET collection_status='complete',details_fetched_at=CURRENT_TIMESTAMP,last_error=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=?`).bind(movie.id).run();
  await enqueue(env,{type:'ENRICH_MOVIE',key:`enrich:${id}:v2`,payload:{tmdb_id:id}});
  log('movie_fetched',{tmdb_id:id,director});
}

async function movieRecord(env:Env,id:number) {
  const movie=await env.MOOVIBE_LIBRARY.prepare(`SELECT m.*, (SELECT json_group_array(g.name) FROM movie_genres mg JOIN genres g ON g.id=mg.genre_id WHERE mg.movie_id=m.id) genres,(SELECT json_group_array(c.name) FROM movie_countries mc JOIN countries c ON c.iso_3166_1=mc.country_code WHERE mc.movie_id=m.id) countries,(SELECT json_group_array(l.name) FROM movie_languages ml JOIN languages l ON l.iso_639_1=ml.language_code WHERE ml.movie_id=m.id) languages,(SELECT json_group_array(k.name) FROM movie_keywords mk JOIN keywords k ON k.id=mk.keyword_id WHERE mk.movie_id=m.id) keywords,(SELECT p.name FROM movie_credits mc JOIN people p ON p.id=mc.person_id WHERE mc.movie_id=m.id AND mc.job='Director' LIMIT 1) director FROM movies m WHERE tmdb_id=?`).bind(id).first<any>();
  return movie;
}

async function wikipediaFallback(title:string,year:number|null) {
  for(const candidate of [year?`${title} (${year} film)`:null,`${title} (film)`,title].filter(Boolean) as string[]) {
    const response=await fetch(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(candidate)}`,{headers:{'User-Agent':'Moovibe/2.0 (film recommendation catalog)'}});
    if(!response.ok)continue; const data=await response.json<any>();
    if(data.type==='disambiguation'||!data.extract)continue;
    return {text:String(data.extract).slice(0,3500),url:data.content_urls?.desktop?.page||null};
  }
  return null;
}

const enrichmentSchema={type:'object',properties:{moods:{type:'array',items:{type:'string'}},themes:{type:'array',items:{type:'string'}},atmosphere:{type:'array',items:{type:'string'}},pace:{type:'string',enum:['very_slow','slow','medium','fast','very_fast']},visual_style:{type:'array',items:{type:'string'}},emotional_valence:{type:'number'},energy:{type:'number'},intimacy:{type:'number'},surrealism:{type:'number'},darkness:{type:'number'},humor:{type:'number'},romanticism:{type:'number'},narrative_density:{type:'number'},melancholy_level:{type:'number'},tension_level:{type:'number'},confidence:{type:'number'}},required:['moods','themes','atmosphere','pace','visual_style','emotional_valence','energy','intimacy','surrealism','darkness','humor','romanticism','narrative_density','melancholy_level','tension_level','confidence']};
async function enrich(env:Env,job:Job) {
  const id=Number(job.payload.tmdb_id); const movie=await movieRecord(env,id); if(!movie)return;
  const client=new GeminiClient(env.GEMINI_API_KEY);
  const sparse=String(movie.overview||'').length<120||JSON.parse(movie.keywords||'[]').length<3;
  const wiki=sparse?await wikipediaFallback(movie.title,movie.release_year):null;
  const context=`Title: ${movie.title}\nYear: ${movie.release_year}\nDirector: ${movie.director||'unknown'}\nCountries: ${movie.countries}\nGenres: ${movie.genres}\nKeywords: ${movie.keywords}\nOverview: ${movie.overview||''}\nTagline: ${movie.tagline||''}${wiki?`\nVerified Wikipedia fallback: ${wiki.text}`:''}`;
  const result=await client.generateJson({system:'Analyze cinematic aesthetics from supplied facts. Never create factual claims. Return concise English concepts and all numeric dimensions from 0 to 1.',prompt:context,schema:enrichmentSchema}); const e=result.data as any;
  await env.MOOVIBE_LIBRARY.prepare(`INSERT INTO movie_enrichments(movie_id,moods_json,themes_json,atmosphere_json,visual_style_json,pace,emotional_valence,energy,intimacy,surrealism,darkness,humor,romanticism,narrative_density,melancholy_level,tension_level,confidence,model,schema_version,source_context,provenance_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(movie_id) DO UPDATE SET moods_json=excluded.moods_json,themes_json=excluded.themes_json,atmosphere_json=excluded.atmosphere_json,visual_style_json=excluded.visual_style_json,pace=excluded.pace,emotional_valence=excluded.emotional_valence,energy=excluded.energy,intimacy=excluded.intimacy,surrealism=excluded.surrealism,darkness=excluded.darkness,humor=excluded.humor,romanticism=excluded.romanticism,narrative_density=excluded.narrative_density,melancholy_level=excluded.melancholy_level,tension_level=excluded.tension_level,confidence=excluded.confidence,model=excluded.model,source_context=excluded.source_context,provenance_json=excluded.provenance_json,updated_at=CURRENT_TIMESTAMP`).bind(movie.id,JSON.stringify(e.moods),JSON.stringify(e.themes),JSON.stringify(e.atmosphere),JSON.stringify(e.visual_style),e.pace,e.emotional_valence,e.energy,e.intimacy,e.surrealism,e.darkness,e.humor,e.romanticism,e.narrative_density,e.melancholy_level,e.tension_level,e.confidence,result.model,'style-v2',context,JSON.stringify(wiki?['tmdb',{source:'wikipedia',url:wiki.url}]:['tmdb'])).run();
  await env.MOOVIBE_LIBRARY.prepare(`UPDATE movies SET enrichment_status='complete',enriched_at=CURRENT_TIMESTAMP,embedding_status='pending',last_error=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=?`).bind(movie.id).run();
  await enqueue(env,{type:'EMBED_MOVIE',key:`embed:${id}:${EMBEDDING_SCHEMA_VERSION}`,payload:{tmdb_id:id}}); log('movie_enriched',{tmdb_id:id,model:result.model});
}

async function embed(env:Env,job:Job) {
  const id=Number(job.payload.tmdb_id); const movie=await movieRecord(env,id); if(!movie)return;
  const er=await env.MOOVIBE_LIBRARY.prepare(`SELECT * FROM movie_enrichments WHERE movie_id=?`).bind(movie.id).first<any>(); if(!er) throw new Error('Movie has no enrichment');
  movie.enrichment={moods:er.moods_json,themes:er.themes_json,atmosphere:er.atmosphere_json,visual_style:er.visual_style_json,...er}; const document=buildMovieDocument(movie);
  const bytes=new TextEncoder().encode(document); const digest=[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(b=>b.toString(16).padStart(2,'0')).join('');
  const model=env.EMBEDDING_MODEL||'gemini-embedding-2',dimensions=Number(env.EMBEDDING_DIMENSIONS||768); const values=await new GeminiClient(env.GEMINI_API_KEY).embed(document,{model,dimensions});
  await env.MOVIE_VECTORS.upsert([{id:String(id),values,metadata:{year:movie.release_year||0,language:movie.original_language||'',schema:env.EMBEDDING_SCHEMA_VERSION||EMBEDDING_SCHEMA_VERSION}}]);
  await env.MOOVIBE_LIBRARY.prepare(`UPDATE movies SET embedding_status='complete',embedding_model=?,embedding_dimensions=?,embedding_schema_version=?,semantic_document_hash=?,embedded_at=CURRENT_TIMESTAMP,last_error=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=?`).bind(model,dimensions,env.EMBEDDING_SCHEMA_VERSION||EMBEDDING_SCHEMA_VERSION,digest,movie.id).run(); log('movie_embedded',{tmdb_id:id,model,dimensions});
}

type JobOutcome={retry:boolean;delaySeconds?:number};
async function processJob(env:Env,job:Job):Promise<JobOutcome> {
  const claim=await env.MOOVIBE_LIBRARY.prepare(`UPDATE pipeline_jobs SET status='running',attempts=attempts+1,started_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE job_key=? AND status='queued' AND (available_at IS NULL OR available_at<=CURRENT_TIMESTAMP)`).bind(job.key).run();
  if(!claim.meta.changes)return {retry:false};
  const state=await env.MOOVIBE_LIBRARY.prepare(`SELECT attempts FROM pipeline_jobs WHERE job_key=?`).bind(job.key).first<{attempts:number}>();
  const attempt=Number(state?.attempts||1); log('job_started',{job_key:job.key,type:job.type,attempt});
  try {
    if(job.type==='DISCOVER_QUERY') await discover(env,job); else if(job.type==='FETCH_MOVIE'||job.type==='REFRESH_MOVIE') await fetchMovie(env,job); else if(job.type==='ENRICH_MOVIE') await enrich(env,job); else await embed(env,job);
    await env.MOOVIBE_LIBRARY.prepare(`UPDATE pipeline_jobs SET status='done',completed_at=CURRENT_TIMESTAMP,last_error=NULL,updated_at=CURRENT_TIMESTAMP WHERE job_key=?`).bind(job.key).run();
    log('job_completed',{job_key:job.key,type:job.type,attempt}); return {retry:false};
  } catch(error:any) {
    const message=String(error?.message||error).slice(0,1000); const retry=shouldRetry(attempt);
    const delay=retryDelaySeconds(attempt,error instanceof RetryableError?error.retryAfter:0);
    await env.MOOVIBE_LIBRARY.prepare(`UPDATE pipeline_jobs SET status=?,last_error=?,available_at=datetime('now',?),updated_at=CURRENT_TIMESTAMP WHERE job_key=?`).bind(retry?'queued':'error',message,`+${delay} seconds`,job.key).run();
    if(job.type==='DISCOVER_QUERY')await env.MOOVIBE_LIBRARY.prepare(`UPDATE collection_queries SET status='pending',last_error=?,updated_at=CURRENT_TIMESTAMP WHERE query_id=? AND is_executable=1`).bind(message,String(job.payload.query_id)).run();
    log(retry?'job_retry':'job_error',{job_key:job.key,type:job.type,attempt,error:message.slice(0,300)});
    return retry?{retry:true,delaySeconds:delay}:{retry:false};
  }
}

async function health(env:Env) {
  const counts=await env.MOOVIBE_LIBRARY.prepare(`SELECT COUNT(*) movies,SUM(enrichment_status='complete') enriched,SUM(embedding_status='complete') embedded FROM movies`).first();
  const jobs=await env.MOOVIBE_LIBRARY.prepare(`SELECT status,COUNT(*) count FROM pipeline_jobs GROUP BY status`).all();
  const state=await env.MOOVIBE_LIBRARY.prepare(`SELECT key,value,updated_at FROM system_state`).all(); return {ok:true,counts,jobs:jobs.results,state:state.results};
}

export default {
  async scheduled(_controller:ScheduledController,env:Env,ctx:ExecutionContext){ctx.waitUntil(schedule(env));},
  async queue(batch:MessageBatch<Job>,env:Env){for(const message of batch.messages){const outcome=await processJob(env,message.body);if(outcome.retry)message.retry({delaySeconds:outcome.delaySeconds});else message.ack();}},
  async fetch(request:Request,env:Env){const url=new URL(request.url);if(url.pathname==='/health')return json(await health(env));if(url.pathname==='/admin/run'){if(!env.ADMIN_TOKEN||request.headers.get('authorization')!==`Bearer ${env.ADMIN_TOKEN}`)return json({error:'unauthorized'},401);await schedule(env);return json({ok:true});}if(url.pathname==='/admin/seed'){if(!env.ADMIN_TOKEN||request.headers.get('authorization')!==`Bearer ${env.ADMIN_TOKEN}`)return json({error:'unauthorized'},401);return json(await syncDiscoverySeed(env,true));}if(url.pathname==='/admin/requeue-known-failures'){if(!env.ADMIN_TOKEN||request.headers.get('authorization')!==`Bearer ${env.ADMIN_TOKEN}`)return json({error:'unauthorized'},401);if(request.method!=='POST')return json({error:'method_not_allowed'},405);return json(await requeueKnownFailures(env));}return json({service:'moovibe-pipeline',ok:true});}
};

export { enqueue,processJob,schedule,seedQueries,discover,fetchMovie,replaceRelations,requeueKnownFailures };
