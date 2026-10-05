import {beforeEach,describe,expect,it,vi} from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';

vi.mock('../functions/_lib/gemini.js',()=>({
  RetryableError:class RetryableError extends Error {retryAfter:number;constructor(message:string,retryAfter=0){super(message);this.retryAfter=retryAfter;}},
  GeminiClient:class {async generateJson(){return {model:'test-model',data:{moods:['calm'],themes:['memory'],atmosphere:['warm'],pace:'medium',visual_style:['natural'],emotional_valence:.5,energy:.5,intimacy:.5,surrealism:.1,darkness:.1,humor:.2,romanticism:.2,narrative_density:.5,melancholy_level:.2,tension_level:.2,confidence:.9}};} async embed(){return Array(768).fill(0.01);}}
}));

import {processJob,schedule,seedQueries,discover,replaceRelations,requeueKnownFailures} from '../workers/pipeline/src/index.js';
import {discoveryQueries} from '../workers/pipeline/src/queries.js';
import {HISTORICAL_DISCOVERY_BUDGET,HISTORICAL_DISCOVERY_DUE_SQL,MOVIE_BACKLOG_SQL,RECENT_DISCOVERY_BUDGET,RECENT_DISCOVERY_DUE_SQL,stableDiscoveryKey} from '../workers/pipeline/src/job-policy.js';

class Statement {
  values:any[]=[];
  constructor(private db:Database.Database,private sql:string){}
  bind(...values:any[]){this.values=values;return this;}
  async run(){const r=this.db.prepare(this.sql).run(...this.values);return {meta:{changes:r.changes}};}
  async all<T>(){return {results:this.db.prepare(this.sql).all(...this.values) as T[]};}
  async first<T>(){return this.db.prepare(this.sql).get(...this.values) as T|null;}
}
const makeEnv=(db:Database.Database)=>{
  const sent:any[]=[];
  const env:any={MOOVIBE_LIBRARY:{prepare:(sql:string)=>new Statement(db,sql),batch:async(xs:Statement[])=>Promise.all(xs.map(x=>x.run()))},PIPELINE_QUEUE:{send:async(j:any)=>{sent.push(j);}},MOVIE_VECTORS:{upsert:vi.fn()},GEMINI_API_KEY:'x',TMDB_API_KEY:'x',EMBEDDING_MODEL:'gemini-embedding-2',EMBEDDING_DIMENSIONS:'768',EMBEDDING_SCHEMA_VERSION:'movie-v1'};
  return {env,sent};
};
const trackRowWrites=(env:any,table?:string)=>{
  const counter={count:0};
  const prepare=env.MOOVIBE_LIBRARY.prepare;
  env.MOOVIBE_LIBRARY.prepare=(sql:string)=>{
    const statement=prepare(sql);
    if(/^\s*(INSERT|UPDATE|DELETE)\b/i.test(sql)&&(!table||sql.includes(table))){
      const run=statement.run.bind(statement);
      statement.run=async()=>{counter.count++;return run();};
    }
    return statement;
  };
  return counter;
};
// Counts actually affected rows (changes), not executed statements.
const trackChangedRows=(env:any,table:string)=>{
  const counter={count:0};
  const prepare=env.MOOVIBE_LIBRARY.prepare;
  env.MOOVIBE_LIBRARY.prepare=(sql:string)=>{
    const statement=prepare(sql);
    if(/^\s*(INSERT|UPDATE|DELETE)\b/i.test(sql)&&sql.includes(table)){
      const run=statement.run.bind(statement);
      statement.run=async()=>{const r=await run();counter.count+=Number(r.meta?.changes||0);return r;};
    }
    return statement;
  };
  return counter;
};
let db:Database.Database;
beforeEach(()=>{db=new Database(':memory:');for(const file of fs.readdirSync('migrations').filter(x=>x.endsWith('.sql')).sort())db.exec(fs.readFileSync(`migrations/${file}`,'utf8'));});

describe('pipeline scheduling',()=>{
  it('never schedules imported provenance and uses one stable active job per real query',async()=>{
    db.exec(`INSERT INTO collection_queries(query_id,label,params_json,is_executable,status) VALUES('legacy-x','old','{}',0,'imported');`);
    const {env,sent}=makeEnv(db);await schedule(env);await schedule(env);
    expect(sent.some(x=>x.payload.query_id==='legacy-x')).toBe(false);
    const keys=sent.filter(x=>x.type==='DISCOVER_QUERY').map(x=>x.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys.every(x=>x.endsWith(':v1'))).toBe(true);
  });
  it('puts enrichment backlog ahead of the bounded discovery budget',async()=>{
    db.exec(`INSERT INTO movies(tmdb_id,title,collection_status) VALUES(99,'Backlog','complete')`);
    const {env,sent}=makeEnv(db);await schedule(env);
    expect(sent[0]).toMatchObject({type:'ENRICH_MOVIE',key:'enrich:99:v2'});
    expect(sent.filter(x=>x.type==='DISCOVER_QUERY')).toHaveLength(RECENT_DISCOVERY_BUDGET+HISTORICAL_DISCOVERY_BUDGET);
    expect(db.prepare(MOVIE_BACKLOG_SQL).all(50)).toHaveLength(1);
  });
  it('gives both lanes their own budget so recent work cannot monopolize historical work',async()=>{
    const {env,sent}=makeEnv(db);await schedule(env);
    const jobs=sent.filter(x=>x.type==='DISCOVER_QUERY');
    const recentIds=new Set(['recent-global-120','recent-global-30','upcoming-global-60','recent-popular-30','newest-global']);
    expect(jobs.filter(x=>recentIds.has(x.payload.query_id))).toHaveLength(RECENT_DISCOVERY_BUDGET);
    expect(jobs.filter(x=>!recentIds.has(x.payload.query_id))).toHaveLength(HISTORICAL_DISCOVERY_BUDGET);
  });
  it('eligibility SQL excludes imported rows',()=>{
    db.exec(`INSERT INTO collection_queries(query_id,label,params_json,is_executable,status) VALUES('legacy','L','{}',0,'imported'),('real','R','{}',1,'pending')`);
    expect(db.prepare(HISTORICAL_DISCOVERY_DUE_SQL).all(10)).toEqual([{query_id:'real'}]);
    expect(db.prepare(RECENT_DISCOVERY_DUE_SQL).all(10)).toEqual([]);
    expect(stableDiscoveryKey('real')).toBe('discover:real:v1');
  });
  it('recovers a stale running job and ignores its obsolete delivery until requeued',async()=>{
    db.exec(`INSERT INTO pipeline_jobs(job_key,type,payload_json,status,updated_at) VALUES('enrich:7:v2','ENRICH_MOVIE','{"tmdb_id":7}','running',datetime('now','-31 minutes'))`);
    const {env,sent}=makeEnv(db);await schedule(env);
    expect(sent.some(x=>x.key==='enrich:7:v2')).toBe(true);
    expect((db.prepare(`SELECT status,last_error FROM pipeline_jobs WHERE job_key='enrich:7:v2'`).get() as any)).toMatchObject({status:'queued',last_error:expect.stringContaining('stale lease')});
  });
  it('also releases the discovery-query lease when its job is stale',async()=>{
    db.exec(`INSERT INTO collection_queries(query_id,label,params_json,is_executable,status) VALUES('stale-q','Q','{}',1,'running');INSERT INTO pipeline_jobs(job_key,type,payload_json,status,updated_at) VALUES('discover:stale-q:v1','DISCOVER_QUERY','{"query_id":"stale-q"}','running',datetime('now','-31 minutes'))`);
    const {env}=makeEnv(db);await schedule(env);
    expect((db.prepare(`SELECT status,last_error FROM collection_queries WHERE query_id='stale-q'`).get() as any)).toMatchObject({status:'pending',last_error:expect.stringContaining('stale lease')});
  });
  it('second seedQueries run without changes performs zero row writes and keeps legacy untouched',async()=>{
    db.exec(`INSERT INTO collection_queries(query_id,label,params_json,is_executable,status) VALUES('legacy-keep','Legacy','{}',0,'imported');`);
    const {env}=makeEnv(db);
    const writes=trackRowWrites(env);
    const first=await seedQueries(env);
    expect(first.inserted).toBeGreaterThan(1000);
    expect(first.updated).toBe(0);
    const afterFirst=writes.count;
    expect(afterFirst).toBe(first.inserted);
    const second=await seedQueries(env);
    expect(second).toMatchObject({inserted:0,updated:0});
    expect(writes.count).toBe(afterFirst);
    expect(db.prepare(`SELECT label,params_json,is_executable,status FROM collection_queries WHERE query_id='legacy-keep'`).get()).toEqual({label:'Legacy',params_json:'{}',is_executable:0,status:'imported'});
  });
  it('applies real definition changes as targeted row writes only',async()=>{
    const {env}=makeEnv(db);
    await seedQueries(env);
    const target=discoveryQueries()[0];
    db.prepare(`UPDATE collection_queries SET label='drifted',params_json='{}' WHERE query_id=?`).run(target.id);
    const writes=trackRowWrites(env);
    const result=await seedQueries(env);
    expect(result).toMatchObject({inserted:0,updated:1});
    expect(writes.count).toBe(1);
    expect(db.prepare(`SELECT label,params_json FROM collection_queries WHERE query_id=?`).get(target.id)).toEqual({label:target.label,params_json:JSON.stringify(target.params)});
  });
  it('cron reseeds discovery only when the definition version changes',async()=>{
    const {env}=makeEnv(db);
    await schedule(env);
    const state=db.prepare(`SELECT value FROM system_state WHERE key='discovery_seed_version'`).get() as any;
    expect(state.value).toMatch(/^[0-9a-f]{64}$/);
    const writes=trackRowWrites(env,'collection_queries');
    await schedule(env);
    expect(writes.count).toBe(0);
  });
});

describe('job state machine',()=>{
  it('keeps retry state and error observable after a failure',async()=>{
    db.exec(`INSERT INTO collection_queries(query_id,label,params_json,is_executable,status) VALUES('q','Q','{}',1,'pending');INSERT INTO pipeline_jobs(job_key,type,payload_json) VALUES('discover:q:v1','DISCOVER_QUERY','{"query_id":"q"}')`);
    vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response('busy',{status:503})));
    const {env}=makeEnv(db);const result=await processJob(env,{type:'DISCOVER_QUERY',key:'discover:q:v1',payload:{query_id:'q'}});
    expect(result.retry).toBe(true);
    expect((db.prepare(`SELECT status,attempts,last_error FROM pipeline_jobs WHERE job_key='discover:q:v1'`).get() as any)).toMatchObject({status:'queued',attempts:1,last_error:expect.stringContaining('503')});
    expect((db.prepare(`SELECT status,last_error FROM collection_queries WHERE query_id='q'`).get() as any)).toMatchObject({status:'pending',last_error:expect.stringContaining('503')});
    vi.unstubAllGlobals();
  });
  it('moves an exhausted retry to terminal error without losing last_error',async()=>{
    db.exec(`INSERT INTO collection_queries(query_id,label,params_json,is_executable,status) VALUES('final-q','Q','{}',1,'pending');INSERT INTO pipeline_jobs(job_key,type,payload_json,attempts) VALUES('discover:final-q:v1','DISCOVER_QUERY','{"query_id":"final-q"}',4)`);
    vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response('busy',{status:503})));
    const {env}=makeEnv(db);const result=await processJob(env,{type:'DISCOVER_QUERY',key:'discover:final-q:v1',payload:{query_id:'final-q'}});
    expect(result.retry).toBe(false);
    expect((db.prepare(`SELECT status,attempts,last_error FROM pipeline_jobs WHERE job_key='discover:final-q:v1'`).get() as any)).toMatchObject({status:'error',attempts:5,last_error:expect.stringContaining('503')});
    vi.unstubAllGlobals();
  });
  it('a successful enrichment idempotently upserts enrichment and schedules embedding',async()=>{
    const overview='A'.repeat(130);db.prepare(`INSERT INTO movies(tmdb_id,title,overview,collection_status) VALUES(1,'Film',?,'complete')`).run(overview);
    const movieId=(db.prepare(`SELECT id FROM movies WHERE tmdb_id=1`).get() as any).id;
    for(const [id,name] of [[1,'one'],[2,'two'],[3,'three']] as const){db.prepare(`INSERT INTO keywords(id,name) VALUES(?,?)`).run(id,name);db.prepare(`INSERT INTO movie_keywords(movie_id,keyword_id) VALUES(?,?)`).run(movieId,id);}
    db.exec(`INSERT INTO pipeline_jobs(job_key,type,payload_json) VALUES('enrich:1:v2','ENRICH_MOVIE','{"tmdb_id":1}')`);
    const {env,sent}=makeEnv(db);const auditObjects:any[]=[];const consoleSpy=vi.spyOn(console,'log').mockImplementation((value:any)=>{try{const parsed=JSON.parse(String(value));if(parsed.event==='ai_trace')auditObjects.push(parsed);}catch{}});expect((await processJob(env,{type:'ENRICH_MOVIE',key:'enrich:1:v2',payload:{tmdb_id:1}})).retry).toBe(false);
    expect(sent).toContainEqual({type:'EMBED_MOVIE',key:'embed:1:movie-v1',payload:{tmdb_id:1}});
    expect((db.prepare('SELECT COUNT(*) n FROM movie_enrichments').get() as any).n).toBe(1);
    db.exec(`UPDATE pipeline_jobs SET status='queued' WHERE job_key='enrich:1:v2'`);
    await processJob(env,{type:'ENRICH_MOVIE',key:'enrich:1:v2',payload:{tmdb_id:1}});
    expect((db.prepare('SELECT COUNT(*) n FROM movie_enrichments').get() as any).n).toBe(1);
    expect((db.prepare(`SELECT COUNT(*) n FROM pipeline_jobs WHERE job_key='embed:1:movie-v1'`).get() as any).n).toBe(1);
    await processJob(env,{type:'EMBED_MOVIE',key:'embed:1:movie-v1',payload:{tmdb_id:1}});
    expect(auditObjects.filter(x=>x.stage==='movie_enrichment')).toHaveLength(2);
    const embedding=auditObjects.find(x=>x.stage==='movie_embedding');
    expect(embedding).toMatchObject({model:'gemini-embedding-2',dimensions:768,success:true,status:'complete'});
    expect(embedding.input).toContain('Film');expect(embedding.input_hash).toMatch(/^[a-f0-9]{64}$/);expect(embedding).not.toHaveProperty('values');expect(JSON.stringify(embedding)).not.toContain('0.01,0.01');
    expect(auditObjects.every(x=>x.service==='moovibe'&&x.event==='ai_trace')).toBe(true);consoleSpy.mockRestore();
  });
});

describe('genre identity resolution',()=>{
  const details=(genres:any[])=>({genres,production_countries:[],spoken_languages:[]});
  const credits={crew:[],cast:[]};
  const keywords={keywords:[]};
  const movieOf=(tmdbId:number)=>{db.prepare(`INSERT INTO movies(tmdb_id,title) VALUES(?,'Film')`).run(tmdbId);return (db.prepare(`SELECT id FROM movies WHERE tmdb_id=?`).get(tmdbId) as any).id;};

  it('reuses the existing row when the genre name already exists under a different id',async()=>{
    db.prepare(`INSERT INTO genres(id,name) VALUES(-100,'Drama')`).run();
    const movieId=movieOf(1);
    const {env}=makeEnv(db);
    await replaceRelations(env,movieId,details([{id:18,name:'Drama'}]),credits,keywords);
    expect((db.prepare(`SELECT COUNT(*) n FROM genres`).get() as any).n).toBe(1);
    expect(db.prepare(`SELECT genre_id FROM movie_genres WHERE movie_id=?`).get(movieId)).toEqual({genre_id:-100});
  });
  it('keeps a compatible id+name pair as a single canonical row',async()=>{
    db.prepare(`INSERT INTO genres(id,name) VALUES(18,'Drama')`).run();
    const movieId=movieOf(1);
    const {env}=makeEnv(db);
    await replaceRelations(env,movieId,details([{id:18,name:'Drama'}]),credits,keywords);
    expect((db.prepare(`SELECT COUNT(*) n FROM genres`).get() as any).n).toBe(1);
    expect(db.prepare(`SELECT genre_id FROM movie_genres WHERE movie_id=?`).get(movieId)).toEqual({genre_id:18});
  });
  it('renames a stale id in place only when the new name is free, never rewriting the PK',async()=>{
    db.prepare(`INSERT INTO genres(id,name) VALUES(18,'Legacy Name')`).run();
    const movieId=movieOf(1);
    const {env}=makeEnv(db);
    await replaceRelations(env,movieId,details([{id:18,name:'Drama'}]),credits,keywords);
    expect(db.prepare(`SELECT id,name FROM genres WHERE id=18`).get()).toEqual({id:18,name:'Drama'});
    expect((db.prepare(`SELECT COUNT(*) n FROM genres`).get() as any).n).toBe(1);
  });
  it('reprocessing the same film is idempotent',async()=>{
    const movieId=movieOf(1);
    const {env}=makeEnv(db);
    const payload=details([{id:18,name:'Drama'},{id:28,name:'Action'}]);
    await replaceRelations(env,movieId,payload,credits,keywords);
    const genresAfter=(db.prepare(`SELECT COUNT(*) n FROM genres`).get() as any).n;
    const relationsAfter=(db.prepare(`SELECT COUNT(*) n FROM movie_genres`).get() as any).n;
    await replaceRelations(env,movieId,payload,credits,keywords);
    expect((db.prepare(`SELECT COUNT(*) n FROM genres`).get() as any).n).toBe(genresAfter);
    expect((db.prepare(`SELECT COUNT(*) n FROM movie_genres`).get() as any).n).toBe(relationsAfter);
    expect(genresAfter).toBe(2);
    expect(relationsAfter).toBe(2);
  });
  it('lets two films share one genre even when their TMDb ids conflict',async()=>{
    const first=movieOf(1); const second=movieOf(2);
    const {env}=makeEnv(db);
    await replaceRelations(env,first,details([{id:18,name:'Drama'}]),credits,keywords);
    // Before the fix this second relation blew up with UNIQUE(genres.name).
    await replaceRelations(env,second,details([{id:9999,name:'Drama'}]),credits,keywords);
    expect((db.prepare(`SELECT COUNT(*) n FROM genres`).get() as any).n).toBe(1);
    expect((db.prepare(`SELECT COUNT(*) n FROM movie_genres`).get() as any).n).toBe(2);
    expect(db.prepare(`SELECT genre_id FROM movie_genres WHERE movie_id=?`).get(second)).toEqual({genre_id:18});
  });
});

const tmdbDetails=()=>new Response(JSON.stringify({
  title:'Film 5',original_title:'Orig 5',overview:'Story of a film',release_date:'2001-02-03',original_language:'en',
  runtime:90,popularity:5,vote_average:7,vote_count:10,poster_path:'/p.jpg',backdrop_path:'/b.jpg',
  tagline:'T',status:'Released',homepage:'https://h',imdb_id:'tt1',
  genres:[{id:18,name:'Drama'}],
  production_countries:[{iso_3166_1:'US',name:'USA'}],
  spoken_languages:[{iso_639_1:'en',english_name:'English',name:'English'}],
  keywords:{keywords:[{id:100,name:'memory'}]},
  credits:{crew:[{id:7,name:'Dir',original_name:'Dir',known_for_department:'Directing',job:'Director',department:'Directing',order:0}],cast:[]},
  external_ids:{imdb_id:'tt1'}
}),{status:200,headers:{'content-type':'application/json'}});

describe('fetch lifecycle',()=>{
  it('marks the movie complete only after relations are persisted and stays recoverable on failure',async()=>{
    db.prepare(`INSERT INTO movies(tmdb_id,title,collection_status) VALUES(5,'Seed','discovered')`).run();
    db.prepare(`INSERT INTO pipeline_jobs(job_key,type,payload_json) VALUES('fetch:5:v1','FETCH_MOVIE','{"tmdb_id":5}')`).run();
    vi.stubGlobal('fetch',vi.fn(()=>Promise.resolve(tmdbDetails())));
    const {env,sent}=makeEnv(db);
    env.MOOVIBE_LIBRARY.batch=async()=>{throw new Error('D1_ERROR: UNIQUE constraint failed: genres.name');};
    const failed=await processJob(env,{type:'FETCH_MOVIE',key:'fetch:5:v1',payload:{tmdb_id:5}});
    expect(failed.retry).toBe(true);
    const movie=db.prepare(`SELECT collection_status,details_fetched_at,last_error FROM movies WHERE tmdb_id=5`).get() as any;
    expect(movie.collection_status).toBe('discovered');   // not falsely complete
    expect(movie.details_fetched_at).toBeNull();          // completion step never ran
    expect(movie.last_error).toContain('genres.name');    // observable failure
    expect(sent.some(x=>x.type==='ENRICH_MOVIE')).toBe(false);
    expect(db.prepare(`SELECT status,last_error,attempts FROM pipeline_jobs WHERE job_key='fetch:5:v1'`).get()).toMatchObject({status:'queued',attempts:1,last_error:expect.stringContaining('genres.name')});
    // Retry succeeds and only then completes.
    db.prepare(`UPDATE pipeline_jobs SET status='queued',attempts=0,available_at=CURRENT_TIMESTAMP WHERE job_key='fetch:5:v1'`).run();
    env.MOOVIBE_LIBRARY.batch=async(xs:Statement[])=>Promise.all(xs.map(x=>x.run()));
    const ok=await processJob(env,{type:'FETCH_MOVIE',key:'fetch:5:v1',payload:{tmdb_id:5}});
    expect(ok.retry).toBe(false);
    const done=db.prepare(`SELECT collection_status,details_fetched_at,last_error FROM movies WHERE tmdb_id=5`).get() as any;
    expect(done.collection_status).toBe('complete');
    expect(done.details_fetched_at).not.toBeNull();
    expect(done.last_error).toBeNull();
    expect(sent.some(x=>x.type==='ENRICH_MOVIE'&&x.key==='enrich:5:v2')).toBe(true);
    expect((db.prepare(`SELECT COUNT(*) n FROM genres WHERE name='Drama'`).get() as any).n).toBe(1);
    vi.unstubAllGlobals();
  });
});

describe('known failure recovery',()=>{
  const seedFailures=()=>{
    db.prepare(`INSERT INTO movies(tmdb_id,title,collection_status) VALUES(3,'A','complete'),(4,'B','complete')`).run();
    const stmt=db.prepare(`INSERT INTO pipeline_jobs(job_key,type,payload_json,status,attempts,last_error) VALUES(?,?,?,'error',5,?)`);
    stmt.run('enrich:1:v2','ENRICH_MOVIE','{"tmdb_id":1}','Illegal invocation: function called with incorrect `this` reference');
    stmt.run('enrich:2:v2','ENRICH_MOVIE','{"tmdb_id":2}','Gemini 429 rate limited');
    stmt.run('fetch:3:v1','FETCH_MOVIE','{"tmdb_id":3}','D1_ERROR: UNIQUE constraint failed: genres.name');
    stmt.run('fetch:4:v1','FETCH_MOVIE','{"tmdb_id":4}','TMDb 404: not found');
  };
  it('requeues only the known fixed errors and restores honest movie state',async()=>{
    seedFailures();
    const {env,sent}=makeEnv(db);
    const result=await requeueKnownFailures(env);
    expect(result.requeued).toEqual({ENRICH_MOVIE:1,FETCH_MOVIE:1});
    expect(result.total).toBe(2);
    expect(result.movies_reset).toBe(1);
    expect(db.prepare(`SELECT status,attempts,last_error FROM pipeline_jobs WHERE job_key='enrich:1:v2'`).get()).toMatchObject({status:'queued',attempts:0,last_error:null});
    expect(db.prepare(`SELECT status FROM pipeline_jobs WHERE job_key='enrich:2:v2'`).get()).toMatchObject({status:'error'});
    expect(db.prepare(`SELECT status FROM pipeline_jobs WHERE job_key='fetch:4:v1'`).get()).toMatchObject({status:'error'});
    expect(db.prepare(`SELECT collection_status FROM movies WHERE tmdb_id=3`).get()).toMatchObject({collection_status:'discovered'});
    expect(db.prepare(`SELECT collection_status FROM movies WHERE tmdb_id=4`).get()).toMatchObject({collection_status:'complete'});
    expect(sent.map(x=>x.key).sort()).toEqual(['enrich:1:v2','fetch:3:v1']);
  });
  it('is idempotent: a second run recovers nothing and sends nothing',async()=>{
    seedFailures();
    const {env,sent}=makeEnv(db);
    const first=await requeueKnownFailures(env);
    expect(first.total).toBe(2);
    const sentAfterFirst=sent.length;
    const second=await requeueKnownFailures(env);
    expect(second).toMatchObject({total:0,requeued:{ENRICH_MOVIE:0,FETCH_MOVIE:0},movies_reset:0});
    expect(sent.length).toBe(sentAfterFirst);
  });
});

describe('recent releases discovery',()=>{
  const result=(id:number)=>({id,title:`Film ${id}`,original_title:`Film ${id}`,overview:'Story',release_date:'2020-01-01',original_language:'en',popularity:1,vote_average:1,vote_count:1,poster_path:null,backdrop_path:null,adult:false,video:false});
  const pagedFetch=(requested:number[],totalPages:number,failAt?:number)=>vi.fn((input:any)=>{
    const page=Number(new URL(String(input)).searchParams.get('page'));requested.push(page);
    if(page===failAt)return Promise.resolve(new Response('busy',{status:503}));
    return Promise.resolve(new Response(JSON.stringify({results:[result(1000+page)],total_pages:totalPages}),{status:200,headers:{'content-type':'application/json'}}));
  });

  it('processes five historical pages in one job and advances next_page',async()=>{
    db.prepare(`INSERT INTO collection_queries(query_id,label,params_json,is_executable,status,next_page,next_run_at) VALUES('history','History','{}',1,'pending',7,CURRENT_TIMESTAMP)`).run();
    const requested:number[]=[];vi.stubGlobal('fetch',pagedFetch(requested,20));
    const {env}=makeEnv(db);await discover(env,{type:'DISCOVER_QUERY',key:'discover:history:v1',payload:{query_id:'history'}});
    expect(requested).toEqual([7,8,9,10,11]);
    expect(db.prepare(`SELECT next_page,status FROM collection_queries WHERE query_id='history'`).get()).toEqual({next_page:12,status:'pending'});
    vi.unstubAllGlobals();
  });
  it('processes three recent pages in one job',async()=>{
    db.prepare(`INSERT INTO collection_queries(query_id,label,params_json,is_executable,status,next_run_at) VALUES('recent-global-30','Recent','{"lane":"recent"}',1,'pending',CURRENT_TIMESTAMP)`).run();
    const requested:number[]=[];vi.stubGlobal('fetch',pagedFetch(requested,20));
    const {env}=makeEnv(db);await discover(env,{type:'DISCOVER_QUERY',key:'discover:recent-global-30:v1',payload:{query_id:'recent-global-30'}});
    expect(requested).toEqual([1,2,3]);
    expect(db.prepare(`SELECT next_page FROM collection_queries WHERE query_id='recent-global-30'`).get()).toEqual({next_page:4});
    vi.unstubAllGlobals();
  });
  it('wraps to page 1 when total_pages is reached',async()=>{
    db.prepare(`INSERT INTO collection_queries(query_id,label,params_json,is_executable,status,next_run_at) VALUES('short-history','Short','{}',1,'pending',CURRENT_TIMESTAMP)`).run();
    const requested:number[]=[];vi.stubGlobal('fetch',pagedFetch(requested,2));
    const {env}=makeEnv(db);await discover(env,{type:'DISCOVER_QUERY',key:'discover:short-history:v1',payload:{query_id:'short-history'}});
    expect(requested).toEqual([1,2]);
    expect(db.prepare(`SELECT next_page FROM collection_queries WHERE query_id='short-history'`).get()).toEqual({next_page:1});
    vi.unstubAllGlobals();
  });
  it('caps newest-global at five pages per cycle instead of following hundreds of pages',async()=>{
    db.prepare(`INSERT INTO collection_queries(query_id,label,params_json,is_executable,status,next_page,next_run_at) VALUES('newest-global','Newest','{"lane":"recent"}',1,'pending',4,CURRENT_TIMESTAMP)`).run();
    const requested:number[]=[];vi.stubGlobal('fetch',pagedFetch(requested,500));
    const {env}=makeEnv(db);await discover(env,{type:'DISCOVER_QUERY',key:'discover:newest-global:v1',payload:{query_id:'newest-global'}});
    expect(requested).toEqual([4,5]);
    expect(db.prepare(`SELECT next_page FROM collection_queries WHERE query_id='newest-global'`).get()).toEqual({next_page:1});
    vi.unstubAllGlobals();
  });
  it('keeps the failing page as next_page when an error interrupts a block',async()=>{
    db.prepare(`INSERT INTO collection_queries(query_id,label,params_json,is_executable,status,next_run_at) VALUES('error-history','Error','{}',1,'pending',CURRENT_TIMESTAMP)`).run();
    const requested:number[]=[];vi.stubGlobal('fetch',pagedFetch(requested,20,2));
    const {env}=makeEnv(db);
    await expect(discover(env,{type:'DISCOVER_QUERY',key:'discover:error-history:v1',payload:{query_id:'error-history'}})).rejects.toThrow('503');
    expect(requested).toEqual([1,2]);
    expect(db.prepare(`SELECT next_page FROM collection_queries WHERE query_id='error-history'`).get()).toEqual({next_page:2});
    vi.unstubAllGlobals();
  });
  it('queues FETCH_MOVIE for a genuinely new discovery',async()=>{
    db.prepare(`INSERT INTO collection_queries(query_id,label,params_json,is_executable,status,next_run_at) VALUES('new-history','New','{}',1,'pending',CURRENT_TIMESTAMP)`).run();
    const requested:number[]=[];vi.stubGlobal('fetch',pagedFetch(requested,1));
    const {env,sent}=makeEnv(db);await discover(env,{type:'DISCOVER_QUERY',key:'discover:new-history:v1',payload:{query_id:'new-history'}});
    expect(sent).toContainEqual({type:'FETCH_MOVIE',key:'fetch:1001:v1',payload:{tmdb_id:1001}});
    vi.unstubAllGlobals();
  });
  it('computes the date window at runtime while ids and stored params stay date-free',async()=>{
    db.prepare(`INSERT INTO collection_queries(query_id,label,params_json,is_executable,status,next_run_at) VALUES('recent-global-120','RECENT 120d',?,1,'pending',CURRENT_TIMESTAMP)`).run(JSON.stringify({lane:'recent',lookback_days:120,sort_by:'primary_release_date.desc'}));
    const requested:string[]=[];
    vi.stubGlobal('fetch',vi.fn((input:any)=>{requested.push(String(input));return Promise.resolve(new Response(JSON.stringify({results:[],total_pages:1}),{status:200,headers:{'content-type':'application/json'}}));}));
    const {env}=makeEnv(db);
    await discover(env,{type:'DISCOVER_QUERY',key:'discover:recent-global-120:v1',payload:{query_id:'recent-global-120'}});
    const url=new URL(requested[0]);
    const today=new Date().toISOString().slice(0,10);
    const gte=new Date(Date.now()-120*86400000).toISOString().slice(0,10);
    expect(url.searchParams.get('primary_release_date.gte')).toBe(gte);
    expect(url.searchParams.get('primary_release_date.lte')).toBe(today);
    expect(url.searchParams.get('lane')).toBeNull();
    expect(url.searchParams.get('lookback_days')).toBeNull();
    const stored=db.prepare(`SELECT params_json,next_run_at FROM collection_queries WHERE query_id='recent-global-120'`).get() as any;
    expect(JSON.parse(stored.params_json)).toEqual({lane:'recent',lookback_days:120,sort_by:'primary_release_date.desc'});
    expect(stored.params_json).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    const hours=(Date.parse(`${stored.next_run_at.replace(' ','T')}Z`)-Date.now())/3600000;
    expect(hours).toBeGreaterThan(3.5);
    expect(hours).toBeLessThan(4.5);
    vi.unstubAllGlobals();
  });
  it('selects recent and historical due queries independently',()=>{
    db.exec(`INSERT INTO collection_queries(query_id,label,params_json,is_executable,status,last_run_at) VALUES
      ('old-scan','Old','{}',1,'pending',datetime('now','-1 day')),
      ('recent-global-30','Recent','{"lane":"recent","lookback_days":30}',1,'pending',datetime('now')),
      ('upcoming-global-60','Soon','{"lane":"recent","upcoming_days":60}',1,'pending',datetime('now'))`);
    const recentDue=db.prepare(RECENT_DISCOVERY_DUE_SQL).all(10) as any[];
    const historicalDue=db.prepare(HISTORICAL_DISCOVERY_DUE_SQL).all(10) as any[];
    expect(recentDue.map(r=>r.query_id)).toEqual(['recent-global-30','upcoming-global-60']);
    expect(historicalDue.map(r=>r.query_id)).toEqual(['old-scan']);
  });
  it('does not re-enqueue or rewrite a rediscovered completed movie',async()=>{
    db.prepare(`INSERT INTO movies(tmdb_id,title,overview,release_date,release_year,original_language,popularity,vote_average,vote_count,poster_path,backdrop_path,collection_status,enrichment_status,updated_at) VALUES(42,'Existing','Story','2001-02-03',2001,'en',7.5,7.1,100,'/p.jpg','/b.jpg','complete','complete',datetime('now','-2 days'))`).run();
    db.prepare(`INSERT INTO collection_queries(query_id,label,params_json,is_executable,status,next_run_at) VALUES('q-existing','Q','{}',1,'pending',CURRENT_TIMESTAMP)`).run();
    const movieId=(db.prepare(`SELECT id FROM movies WHERE tmdb_id=42`).get() as any).id;
    db.prepare(`INSERT INTO movie_discovery_sources(movie_id,query_id,last_seen_at) VALUES(?,'q-existing',datetime('now','-2 days'))`).run(movieId);
    const before=db.prepare(`SELECT updated_at FROM movies WHERE tmdb_id=42`).get() as any;
    const sourceBefore=db.prepare(`SELECT last_seen_at FROM movie_discovery_sources WHERE movie_id=?`).get(movieId) as any;
    vi.stubGlobal('fetch',vi.fn(()=>Promise.resolve(new Response(JSON.stringify({results:[{id:42,title:'Existing',original_title:'Existing',overview:'Story',release_date:'2001-02-03',original_language:'en',popularity:7.5,vote_average:7.1,vote_count:100,poster_path:'/p.jpg',backdrop_path:'/b.jpg',adult:false,video:false}],total_pages:1}),{status:200,headers:{'content-type':'application/json'}}))));
    const {env,sent}=makeEnv(db);
    const movieWrites=trackChangedRows(env,'movies');
    const sourceWrites=trackChangedRows(env,'movie_discovery_sources');
    await discover(env,{type:'DISCOVER_QUERY',key:'discover:q-existing:v1',payload:{query_id:'q-existing'}});
    // Rediscovery alone never re-enriches, re-fetches or re-embeds a completed movie.
    expect(sent.filter(x=>x.type==='FETCH_MOVIE'||x.type==='ENRICH_MOVIE'||x.type==='EMBED_MOVIE')).toHaveLength(0);
    // And an unchanged rediscovery costs zero row writes.
    expect(movieWrites.count).toBe(0);
    expect(sourceWrites.count).toBe(0);
    expect((db.prepare(`SELECT updated_at FROM movies WHERE tmdb_id=42`).get() as any).updated_at).toBe(before.updated_at);
    expect((db.prepare(`SELECT last_seen_at FROM movie_discovery_sources WHERE movie_id=?`).get(movieId) as any).last_seen_at).toBe(sourceBefore.last_seen_at);
    vi.unstubAllGlobals();
  });
});
