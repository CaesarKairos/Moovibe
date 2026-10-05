import {beforeEach,describe,expect,it,vi} from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';

vi.mock('../functions/_lib/gemini.js',()=>({
  RetryableError:class RetryableError extends Error {retryAfter:number;constructor(message:string,retryAfter=0){super(message);this.retryAfter=retryAfter;}},
  GeminiClient:class {async generateJson(){return {model:'test-model',data:{moods:['calm'],themes:['memory'],atmosphere:['warm'],pace:'medium',visual_style:['natural'],emotional_valence:.5,energy:.5,intimacy:.5,surrealism:.1,darkness:.1,humor:.2,romanticism:.2,narrative_density:.5,melancholy_level:.2,tension_level:.2,confidence:.9}};} async embed(){return Array(768).fill(0.01);}}
}));

import {processJob,schedule,seedQueries} from '../workers/pipeline/src/index.js';
import {discoveryQueries} from '../workers/pipeline/src/queries.js';
import {DISCOVERY_DUE_SQL,MOVIE_BACKLOG_SQL,stableDiscoveryKey} from '../workers/pipeline/src/job-policy.js';

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
    expect(sent.filter(x=>x.type==='DISCOVER_QUERY')).toHaveLength(2);
    expect(db.prepare(MOVIE_BACKLOG_SQL).all(50)).toHaveLength(1);
  });
  it('eligibility SQL excludes imported rows',()=>{
    db.exec(`INSERT INTO collection_queries(query_id,label,params_json,is_executable,status) VALUES('legacy','L','{}',0,'imported'),('real','R','{}',1,'pending')`);
    expect(db.prepare(DISCOVERY_DUE_SQL).all(10)).toEqual([{query_id:'real'}]);
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
    const {env,sent}=makeEnv(db);expect((await processJob(env,{type:'ENRICH_MOVIE',key:'enrich:1:v2',payload:{tmdb_id:1}})).retry).toBe(false);
    expect(sent).toContainEqual({type:'EMBED_MOVIE',key:'embed:1:movie-v1',payload:{tmdb_id:1}});
    expect((db.prepare('SELECT COUNT(*) n FROM movie_enrichments').get() as any).n).toBe(1);
    db.exec(`UPDATE pipeline_jobs SET status='queued' WHERE job_key='enrich:1:v2'`);
    await processJob(env,{type:'ENRICH_MOVIE',key:'enrich:1:v2',payload:{tmdb_id:1}});
    expect((db.prepare('SELECT COUNT(*) n FROM movie_enrichments').get() as any).n).toBe(1);
    expect((db.prepare(`SELECT COUNT(*) n FROM pipeline_jobs WHERE job_key='embed:1:movie-v1'`).get() as any).n).toBe(1);
  });
});
