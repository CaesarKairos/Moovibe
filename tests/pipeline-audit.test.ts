import { beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
vi.mock('../workers/pipeline/src/generation-factory', () => ({
  DEFAULT_XAI_MODEL: 'grok-4-3',
  isMovieGenerationEnabled: (env: any) => String(env?.MOVIE_GENERATION_ENABLED || 'false').toLowerCase() === 'true',
  createMovieGenerationProvider: () => ({
    name: 'xai',
    generateJson: async () => ({ provider: 'xai', model: 'grok-4-3',
      data: { moods: ['calm'], themes: ['memory'], atmosphere: ['warm'], pace: 'medium', visual_style: ['natural'], emotional_valence: .5, energy: .5, intimacy: .5, surrealism: .1, darkness: .1, humor: .2, romanticism: .2, narrative_density: .5, melancholy_level: .2, tension_level: .2, confidence: .9 } })
  })
}));
vi.mock('../functions/_lib/gemini.js', () => ({
  RetryableError: class RetryableError extends Error { retryAfter: number; constructor(m: string, r = 0) { super(m); this.retryAfter = r; } },
  GeminiClient: class { async generateJson() { throw new Error('no-call'); } async embed() { return Array(768).fill(0.01); } }
}));
import { processJob, schedule, recoverGenerationBacklog, providerStatus } from '../workers/pipeline/src/index.js';
class Statement {
  values: any[] = [];
  constructor(private db: Database.Database, private sql: string) { }
  bind(...values: any[]) { this.values = values; return this; }
  async run() { const r = this.db.prepare(this.sql).run(...this.values); return { meta: { changes: r.changes } }; }
  async all<T>() { return { results: this.db.prepare(this.sql).all(...this.values) as T[] }; }
  async first<T>() { return this.db.prepare(this.sql).get(...this.values) as T | null; }
}
const makeEnv = (db: Database.Database, extra: any = {}) => {
  const sent: any[] = [];
  const env: any = { MOOVIBE_LIBRARY: { prepare: (sql: string) => new Statement(db, sql), batch: async (xs: Statement[]) => Promise.all(xs.map((x) => x.run())) },
    PIPELINE_QUEUE: { send: async (j: any) => { sent.push(j); } }, MOVIE_VECTORS: { upsert: vi.fn() },
    GEMINI_API_KEY: 'x', TMDB_API_KEY: 'x', EMBEDDING_MODEL: 'gemini-embedding-2',
    EMBEDDING_DIMENSIONS: '768', EMBEDDING_SCHEMA_VERSION: 'movie-v1',
    MOVIE_GENERATION_PROVIDER: 'xai', MOVIE_GENERATION_MODEL: 'grok-4-3',
    MOVIE_GENERATION_ENABLED: 'false', MOVIE_GENERATION_PILOT_LIMIT: '25', ...extra };
  return { env, sent };
};
let db: Database.Database;
beforeEach(() => { db = new Database(':memory:'); for (const f of fs.readdirSync('migrations').filter((x) => x.endsWith('.sql')).sort()) db.exec(fs.readFileSync(`migrations/${f}`, 'utf8')); });
describe('auditoria-a', () => {
  it('1. jobs error nao bloqueiam backlog elegivel', async () => {
    for (let i = 1; i <= 60; i++) {
      db.prepare(`INSERT INTO movies(tmdb_id,title,collection_status,enrichment_status) VALUES(?,'E','complete','error')`).run(i);
      db.prepare(`INSERT INTO pipeline_jobs(job_key,type,payload_json,status,available_at,updated_at) VALUES(?,?,?,?,datetime('now','+1 day'),datetime('now','-1 day'))`).run(`enrich:${i}:v2`, 'ENRICH_MOVIE', JSON.stringify({ tmdb_id: i }), 'error');
    }
    for (let i = 61; i <= 70; i++) db.prepare(`INSERT INTO movies(tmdb_id,title,collection_status,enrichment_status) VALUES(?,'E','complete','pending')`).run(i);
    const { env, sent } = makeEnv(db, { MOVIE_GENERATION_ENABLED: 'true' });
    await schedule(env);
    const keys = sent.filter((s: any) => s.type === 'ENRICH_MOVIE').map((s: any) => s.key);
    expect(keys.length).toBeGreaterThan(0);
    expect(keys.every((k: string) => Number(k.split(':')[1]) >= 61)).toBe(true);
  });
  it('2. dry-run nao altera D1 nem Queue', async () => {
    db.exec(`INSERT INTO movies(tmdb_id,title,collection_status,enrichment_status,embedding_status) VALUES(1,'A','complete','error','pending'),(2,'B','complete','complete','complete')`);
    db.exec(`INSERT INTO pipeline_jobs(job_key,type,payload_json,status,last_error) VALUES('enrich:1:v2','ENRICH_MOVIE','{"tmdb_id":1}','error','Gemini transient 429'),('enrich:2:v2','ENRICH_MOVIE','{"tmdb_id":2}','error','Gemini 429')`);
    const { env, sent } = makeEnv(db);
    const dry: any = await recoverGenerationBacklog(env, 25, true);
    expect(dry.dry_run).toBe(true);
    expect(dry.eligible).toBe(1);
    expect(sent).toHaveLength(0);
  });
  it('3. INDEX_MOVIE enriquecido mapeia para EMBED', async () => {
    db.exec(`INSERT INTO movies(tmdb_id,title,collection_status,enrichment_status,embedding_status) VALUES(11,'C','complete','complete','pending')`);
    db.exec(`INSERT INTO pipeline_jobs(job_key,type,payload_json,status,last_error) VALUES('index:11:v1','INDEX_MOVIE','{"tmdb_id":11}','error','xAI 429 rate limit')`);
    const { env, sent } = makeEnv(db);
    const dry: any = await recoverGenerationBacklog(env, 25, true);
    expect(dry.by_type).toMatchObject({ EMBED_MOVIE: 1 });
    expect(sent).toHaveLength(0);
  });
});
describe('auditoria-b', () => {
  it('5/6. modo seguro: cron nao agenda, enrich nao chama xAI, nada se perde', async () => {
    db.prepare(`INSERT INTO movies(tmdb_id,title,collection_status,enrichment_status) VALUES(21,'S','complete','pending')`).run();
    db.exec(`INSERT INTO pipeline_jobs(job_key,type,payload_json,status) VALUES('enrich:21:v2','ENRICH_MOVIE','{"tmdb_id":21}','queued')`);
    const { env, sent } = makeEnv(db);
    await schedule(env);
    expect(sent.filter((s: any) => s.type === 'ENRICH_MOVIE')).toHaveLength(0);
    const out: any = await processJob(env, { type: 'ENRICH_MOVIE', key: 'enrich:21:v2', payload: { tmdb_id: 21 } });
    expect(out.retry).toBe(true);
    const row: any = db.prepare(`SELECT status,last_error FROM pipeline_jobs WHERE job_key='enrich:21:v2'`).get();
    expect(row.status).toBe('queued');
    expect(row.last_error).toContain('disabled');
    const st: any = await providerStatus(env);
    expect(st.generation.enabled).toBe(false);
    expect(st.generation.model).toBe('grok-4-3');
  });
  it('7. piloto global limita geracoes pre-enfileiradas', async () => {
    for (let i = 31; i <= 34; i++) {
      db.prepare(`INSERT INTO movies(tmdb_id,title,collection_status,enrichment_status) VALUES(?,'P','complete','pending')`).run(i);
      db.prepare(`INSERT INTO pipeline_jobs(job_key,type,payload_json,status) VALUES(?, 'ENRICH_MOVIE', ?, 'queued')`).run(`enrich:${i}:v2`, JSON.stringify({ tmdb_id: i }));
    }
    const { env } = makeEnv(db, { MOVIE_GENERATION_ENABLED: 'true', MOVIE_GENERATION_PILOT_LIMIT: '2' });
    for (let i = 31; i <= 34; i++) await processJob(env, { type: 'ENRICH_MOVIE', key: `enrich:${i}:v2`, payload: { tmdb_id: i } });
    expect((db.prepare(`SELECT COUNT(*) n FROM pipeline_jobs WHERE status='done' AND type='ENRICH_MOVIE'`).get() as any).n).toBe(2);
  });
  it('9. embeddings Gemini 768d compativeis', async () => {
    db.exec(`INSERT INTO movies(tmdb_id,title,collection_status,enrichment_status,embedding_status) VALUES(41,'V','complete','complete','pending')`);
    db.prepare(`INSERT INTO movie_enrichments(movie_id,model,schema_version) VALUES((SELECT id FROM movies WHERE tmdb_id=41),'grok-4-3','style-v2')`).run();
    db.exec(`INSERT INTO pipeline_jobs(job_key,type,payload_json,status) VALUES('embed:41:movie-v1','EMBED_MOVIE','{"tmdb_id":41}','queued')`);
    const { env } = makeEnv(db);
    expect((await processJob(env, { type: 'EMBED_MOVIE', key: 'embed:41:movie-v1', payload: { tmdb_id: 41 } })).retry).toBe(false);
    expect((env.MOVIE_VECTORS.upsert.mock.calls[0][0][0].values as number[])).toHaveLength(768);
  });
  it('10/11. circuito aberto nao gera storm', async () => {
    db.exec(`INSERT INTO movies(tmdb_id,title,collection_status,enrichment_status) VALUES(51,'Q','complete','pending')`);
    db.exec(`INSERT INTO pipeline_jobs(job_key,type,payload_json,status) VALUES('enrich:51:v2','ENRICH_MOVIE','{"tmdb_id":51}','queued')`);
    const { env } = makeEnv(db, { MOVIE_GENERATION_ENABLED: 'true' });
    await env.MOOVIBE_LIBRARY.prepare(`INSERT INTO system_state(key,value) VALUES('circuit:generation-xai',?)`).bind(JSON.stringify({ until: new Date(Date.now() + 3600e3).toISOString(), reason: 'RATE_LIMITED' })).run();
    const out: any = await processJob(env, { type: 'ENRICH_MOVIE', key: 'enrich:51:v2', payload: { tmdb_id: 51 } });
    expect(out.retry).toBe(true);
    expect(out.delaySeconds).toBeGreaterThanOrEqual(60);
  });
});

