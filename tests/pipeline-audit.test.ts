import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import pipelineWorker, { processJob, schedule, recoverGenerationBacklog, providerStatus, providerStatusFull, __testPilotConsume } from '../workers/pipeline/src/index.js';
import { updatePipelineControl } from '../workers/pipeline/src/pipeline-control.js';
import { ENRICHMENT_BACKLOG_BUDGET } from '../workers/pipeline/src/job-policy.js';
import { openCircuit } from '../workers/pipeline/src/generation-provider';
class Statement {
  values: any[] = [];
  constructor(private db: Database.Database, private sql: string) { }
  bind(...values: any[]) { this.values = values; return this; }
  runSync() { const r = this.db.prepare(this.sql).run(...this.values); return { meta: { changes: r.changes } }; }
  async run() { return this.runSync(); }
  async all<T>() { return { results: this.db.prepare(this.sql).all(...this.values) as T[] }; }
  async first<T>() { return this.db.prepare(this.sql).get(...this.values) as T | null; }
}
const makeEnv = (db: Database.Database, extra: any = {}) => {
  const sent: any[] = [];
  const env: any = { MOOVIBE_LIBRARY: { prepare: (sql: string) => new Statement(db, sql), batch: async (xs: Statement[]) => db.transaction(() => xs.map((x) => x.runSync()))() },
    PIPELINE_QUEUE: { send: async (j: any) => { sent.push(j); } }, MOVIE_VECTORS: { upsert: vi.fn() },
    GEMINI_API_KEY: 'x', XAI_API_KEY: 'x', TMDB_API_KEY: 'x', EMBEDDING_MODEL: 'gemini-embedding-2',
    EMBEDDING_DIMENSIONS: '768', EMBEDDING_SCHEMA_VERSION: 'movie-v1',
    MOVIE_GENERATION_PROVIDER: 'groq', MOVIE_GENERATION_MODEL: 'openai/gpt-oss-120b',
    MOVIE_GENERATION_ENABLED: 'false', MOVIE_GENERATION_PILOT_LIMIT: '25', ...extra };
  return { env, sent };
};
let db: Database.Database;
beforeEach(() => { db = new Database(':memory:'); for (const f of fs.readdirSync('migrations').filter((x) => x.endsWith('.sql')).sort()) db.exec(fs.readFileSync(`migrations/${f}`, 'utf8')); const g: any = globalThis as any; g.__genInflight = 0; g.__genMaxInflight = 0; g.__genFailPlan = []; g.__genMock = undefined; g.__http = 0; });
beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (String(url) === 'https://api.groq.com/openai/v1/chat/completions') {
      const g: any = globalThis;
      g.__genInflight++;
      g.__genMaxInflight = Math.max(g.__genMaxInflight, g.__genInflight);
      g.__http++;
      try {
        await new Promise((r) => setTimeout(r, 5));
        const mode = g.__genFailPlan.shift() || 'ok';
        if (mode === 'fail:http') return new Response('rate limit', { status: 429 });
        if (mode === 'fail:transient') return new Response('busy', { status: 500 });
        if (mode === 'fail:timeout') throw new Error('fetch failed: timeout');
        if (mode === 'invalid:envelope') return new Response('{');
        if (mode === 'invalid:content') return new Response(JSON.stringify({ choices: [{ message: { content: '{' } }] }));
        const data = { moods: ['calm'], themes: ['memory'], atmosphere: ['warm'], pace: 'medium', visual_style: ['natural'], emotional_valence: .5, energy: .5, intimacy: .5, surrealism: .1, darkness: .1, humor: .2, romanticism: .2, narrative_density: .5, melancholy_level: .2, tension_level: .2, confidence: .9 };
        return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(data) } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }));
      } finally { g.__genInflight--; }
    }
    if (String(url).includes('generativelanguage.googleapis.com') && String(url).includes(':embedContent')) {
      return new Response(JSON.stringify({ embedding: { values: Array(768).fill(.01) } }));
    }
    if (String(url).startsWith('https://en.wikipedia.org/')) return new Response('', { status: 404 });
    throw new Error(`Unexpected network request in test: ${url}`);
  }));
});
afterEach(() => { vi.unstubAllGlobals(); db.close(); });
const seedGenerationJob = (id: number) => {
  db.prepare(`INSERT INTO movies(tmdb_id,title,overview,collection_status) VALUES(?,'Groq movie',?,'complete')`).run(id, 'Verified cinematic overview. '.repeat(10));
  const job = { type: 'ENRICH_MOVIE' as const, key: `enrich:${id}:v2`, payload: { tmdb_id: id } };
  db.prepare(`INSERT INTO pipeline_jobs(job_key,type,payload_json) VALUES(?,?,?)`).run(job.key, job.type, JSON.stringify(job.payload));
  return job;
};
describe('Groq migration integration (real clients, mocked HTTP)', () => {
  const groqMessage = (body: any) => ({ body, ack: vi.fn(), retry: vi.fn() });
  it('concurrent jobs are paced globally and leave xAI history intact', async () => {
    const legacy = JSON.stringify({ day: new Date().toISOString().slice(0, 10), count: 3, attempts: 3, failed: 3, success: 0 });
    db.prepare(`INSERT INTO system_state(key,value) VALUES('gen_pilot_count',?)`).run(legacy);
    await openCircuit({ prepare: (sql: string) => new Statement(db, sql) } as any, 'generation-xai', 43200, 'Incorrect API key');
    const jobs = Array.from({ length: 50 }, (_, i) => seedGenerationJob(3000 + i));
    const { env } = makeEnv(db, { MOVIE_GENERATION_ENABLED: 'true', MOVIE_GENERATION_PILOT_LIMIT: '3' });
    (globalThis as any).__genFailPlan = ['invalid:content', 'fail:transient', 'ok'];
    await Promise.all(jobs.map((job) => processJob(env, job)));
    expect((globalThis as any).__http).toBe(1);
    const status = await providerStatusFull(env);
    expect(status.generation).toMatchObject({ provider: 'groq', pilot_limit: 3, pilot_used_today: 1, pilot_attempts_today: 1, pilot_success_today: 0, pilot_failed_today: 1 });
    expect(db.prepare(`SELECT value FROM system_state WHERE key='gen_pilot_count'`).get()).toEqual({ value: legacy });
    expect(db.prepare(`SELECT COUNT(*) n FROM system_state WHERE key='circuit:generation-xai'`).get()).toEqual({ n: 1 });
    expect(db.prepare(`SELECT status,COUNT(*) n FROM pipeline_jobs WHERE type='ENRICH_MOVIE' GROUP BY status ORDER BY status`).all()).toEqual([{ status: 'error', n: 1 }, { status: 'queued', n: 49 }]);
    expect(db.prepare(`SELECT MAX(attempts) n FROM pipeline_jobs WHERE status='queued'`).get()).toEqual({ n: 0 });
    const calls = vi.mocked(fetch).mock.calls;
    expect(calls.filter(([url]) => String(url).includes('api.x.ai'))).toHaveLength(0);
    const before = (globalThis as any).__http;
    await processJob(env, seedGenerationJob(3099));
    expect((globalThis as any).__http).toBe(before);
    await schedule(env);
    expect(db.prepare(`SELECT COUNT(*) n FROM pipeline_jobs WHERE type='ENRICH_MOVIE'`).get()).toEqual({ n: 51 });
  });
  it.each([400, 401, 403, 429])('Groq %s preserves durable jobs and circuit deferral never burns attempts or queue deliveries', async (status) => {
    const first = seedGenerationJob(3100), waiting = seedGenerationJob(3101);
    const { env } = makeEnv(db, { MOVIE_GENERATION_ENABLED: 'true', MOVIE_GENERATION_PILOT_LIMIT: '3' });
    vi.mocked(fetch).mockImplementationOnce(async () => new Response(status === 429 ? 'TPD exhausted' : 'Incorrect API key provided', { status, headers: status === 429 ? { 'retry-after': '80000' } : {} }));
    const initial = groqMessage(first);
    await (pipelineWorker as any).queue({ messages: [initial] }, env);
    expect(initial.ack).toHaveBeenCalledOnce(); expect(initial.retry).not.toHaveBeenCalled();
    const snapshot = await providerStatusFull(env);
    expect(snapshot.generation).toMatchObject({ provider: 'groq', state: 'LIMITADO', pilot_attempts_today: 1, pilot_failed_today: 1 });
    if (status === 429) expect(Date.parse(snapshot.generation.cooldown_until!) - Date.now()).toBeGreaterThan(79000 * 1000);
    for (let i = 0; i < 6; i++) {
      db.prepare(`UPDATE pipeline_jobs SET available_at=CURRENT_TIMESTAMP WHERE job_key=?`).run(waiting.key);
      const message = groqMessage(waiting);
      await (pipelineWorker as any).queue({ messages: [message] }, env);
      expect(message.ack).toHaveBeenCalledOnce(); expect(message.retry).not.toHaveBeenCalled();
    }
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(db.prepare(`SELECT status,attempts,last_error FROM pipeline_jobs WHERE job_key=?`).get(waiting.key)).toMatchObject({ status: 'queued', attempts: 0, last_error: expect.stringContaining('[GENERATION_DEFERRED] Groq') });
    expect(db.prepare(`SELECT last_error FROM pipeline_jobs WHERE last_error LIKE '%UNKNOWN%'`).all()).toHaveLength(0);
  });
  it('successful response with exhausted RPD opens a durable daily cooldown without failing the enrichment', async () => {
    const first = seedGenerationJob(3200), next = seedGenerationJob(3201);
    const { env } = makeEnv(db, { MOVIE_GENERATION_ENABLED: 'true' });
    const original = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementationOnce(async (...args) => {
      const response = await original(...args);
      return new Response(await response.text(), { headers: { 'x-ratelimit-remaining-requests': '0', 'x-ratelimit-reset-requests': '20h' } });
    });
    await processJob(env, first);
    expect((await providerStatusFull(env)).generation).toMatchObject({ state: 'LIMITADO', pilot_success_today: 1, pilot_failed_today: 0 });
    expect(await processJob(env, next)).toMatchObject({ deferred: true });
    expect((globalThis as any).__http).toBe(1);
    await Promise.all([openCircuit(env.MOOVIBE_LIBRARY, 'generation-groq', 60, 'minute'), openCircuit(env.MOOVIBE_LIBRARY, 'generation-groq', 120, 'token')]);
    expect(Date.parse((await providerStatusFull(env)).generation.cooldown_until!) - Date.now()).toBeGreaterThan(19 * 3600 * 1000);
  });
  it('recovers old xAI credential errors explicitly in bounded batches; cron and dry-run do not recover them', async () => {
    const jobs = [3300, 3301, 3302].map(seedGenerationJob);
    db.exec(`UPDATE pipeline_jobs SET status='error',attempts=5,last_error='[INVALID_CREDENTIAL] xAI 400 Incorrect API key provided'`);
    const { env, sent } = makeEnv(db, { MOVIE_GENERATION_ENABLED: 'true', MOVIE_GENERATION_PILOT_LIMIT: '3' });
    await schedule(env);
    expect(db.prepare(`SELECT COUNT(*) n FROM pipeline_jobs WHERE status='error'`).get()).toEqual({ n: 3 });
    sent.splice(0);
    const before = db.prepare(`SELECT * FROM pipeline_jobs ORDER BY job_key`).all();
    expect(await recoverGenerationBacklog(env, 1, true)).toMatchObject({ eligible: 1, dry_run: true });
    expect(db.prepare(`SELECT * FROM pipeline_jobs ORDER BY job_key`).all()).toEqual(before); expect(sent).toHaveLength(0);
    expect(await recoverGenerationBacklog(env, 1, false)).toMatchObject({ requeued: 1 });
    expect(sent).toHaveLength(1);
    const recovered = jobs.find((j) => j.key === sent[0].key)!;
    await processJob(env, recovered);
    expect(db.prepare(`SELECT status FROM pipeline_jobs WHERE job_key=?`).get(recovered.key)).toEqual({ status: 'done' });
    expect(db.prepare(`SELECT COUNT(*) n FROM pipeline_jobs WHERE status='error'`).get()).toEqual({ n: 2 });
    expect((globalThis as any).__http).toBe(1);
    const enrichment: any = db.prepare(`SELECT model,provenance_json FROM movie_enrichments`).get();
    expect(enrichment.model).toBe('openai/gpt-oss-120b'); expect(JSON.parse(enrichment.provenance_json).provider).toBe('groq');
  });
  it('GET /admin/providers reflects the checked-in pilot and does not claim authentication was validated', async () => {
    const vars = JSON.parse(fs.readFileSync('workers/pipeline/wrangler.jsonc', 'utf8')).vars;
    const { env } = makeEnv(db, { ...vars, ADMIN_TOKEN: 'admin', XAI_API_KEY: 'never-show-this' });
    const response = await pipelineWorker.fetch(new Request('https://worker.test/admin/providers', { headers: { authorization: 'Bearer admin' } }), env);
    const result: any = await response.json();
    expect(result.generation).toMatchObject({ provider: 'groq', model: 'openai/gpt-oss-120b', enabled: vars.MOVIE_GENERATION_ENABLED === 'true', pilot_limit: Number(vars.MOVIE_GENERATION_PILOT_LIMIT), pilot_used_today: 0, circuit: 'generation-groq', authentication: 'not_verified_by_status_endpoint' });
    expect(result.embedding).toMatchObject({ provider: 'gemini', model: 'gemini-embedding-2', dimensions: 768 });
    expect(JSON.stringify(result)).not.toContain('never-show-this');
    expect(fetch).not.toHaveBeenCalled();
  });
});
describe('auditoria-a', () => {
  it.each(['invalid:envelope', 'invalid:content'])('%s termina sem UNKNOWN/retry e registra a tentativa', async (mode) => {
    db.prepare(`INSERT INTO movies(tmdb_id,title,overview,collection_status) VALUES(991,'Invalid',?,'complete')`).run('Verified overview. '.repeat(10));
    const job = { type: 'ENRICH_MOVIE' as const, key: 'enrich:991:v2', payload: { tmdb_id: 991 } };
    db.prepare(`INSERT INTO pipeline_jobs(job_key,type,payload_json) VALUES(?,?,?)`).run(job.key, job.type, JSON.stringify(job.payload));
    (globalThis as any).__genFailPlan = [mode];
    const { env } = makeEnv(db, { MOVIE_GENERATION_ENABLED: 'true' });
    expect(await processJob(env, job)).toEqual({ retry: false });
    expect(db.prepare(`SELECT status,last_error FROM pipeline_jobs WHERE job_key=?`).get(job.key)).toMatchObject({ status: 'error', last_error: expect.stringContaining('[INVALID_GENERATION_OUTPUT]') });
    expect(JSON.parse((db.prepare(`SELECT value FROM system_state WHERE key='gen_pilot_count:groq'`).get() as any).value)).toMatchObject({ attempts: 1, failed: 1, success: 0 });
    expect(db.prepare(`SELECT COUNT(*) n FROM system_state WHERE key LIKE 'enrichment-lock:%'`).get()).toEqual({ n: 0 });
    expect(db.prepare(`SELECT COUNT(*) n FROM movie_enrichments`).get()).toEqual({ n: 0 });
  });
  it.each(['abandoned', 'lost-before-save', 'save-failed'])('protege persistencia e retomada do bloqueio: %s', async (mode) => {
    db.prepare(`INSERT INTO movies(tmdb_id,title,overview,collection_status) VALUES(992,'Lock',?,'complete')`).run('Verified overview. '.repeat(10));
    const job = { type: 'ENRICH_MOVIE' as const, key: 'enrich:992:v2', payload: { tmdb_id: 992 } };
    db.prepare(`INSERT INTO pipeline_jobs(job_key,type,payload_json) VALUES(?,?,?)`).run(job.key, job.type, JSON.stringify(job.payload));
    if (mode === 'abandoned') db.prepare(`INSERT INTO system_state(key,value) VALUES('enrichment-lock:992',?)`).run(JSON.stringify({ token: 'old', job: job.key, attempt: 0, started: null }));
    const { env } = makeEnv(db, { MOVIE_GENERATION_ENABLED: 'true' });
    const batch = env.MOOVIBE_LIBRARY.batch;
    env.MOOVIBE_LIBRARY.batch = async (xs: Statement[]) => {
      if (mode === 'lost-before-save') db.exec(`UPDATE system_state SET value=json_set(value,'$.token','successor') WHERE key='enrichment-lock:992'`);
      if (mode === 'save-failed') db.exec(`CREATE TRIGGER reject_save BEFORE UPDATE OF enrichment_status ON movies BEGIN SELECT RAISE(ABORT,'save failed'); END`);
      return batch(xs);
    };
    await processJob(env, job);
    expect((globalThis as any).__http).toBe(1);
    expect(db.prepare(`SELECT COUNT(*) n FROM movie_enrichments`).get()).toEqual({ n: mode === 'abandoned' ? 1 : 0 });
    expect(db.prepare(`SELECT enrichment_status FROM movies WHERE tmdb_id=992`).get()).toEqual({ enrichment_status: mode === 'abandoned' ? 'complete' : 'pending' });
    const lock: any = db.prepare(`SELECT value FROM system_state WHERE key='enrichment-lock:992'`).get();
    if (mode === 'lost-before-save') expect(JSON.parse(lock.value).token).toBe('successor');
    else expect(lock).toBeUndefined();
    if (mode !== 'abandoned') expect(db.prepare(`SELECT status FROM pipeline_jobs WHERE job_key=?`).get(job.key)).toEqual({ status: 'queued' });
  });
  it.each([['INDEX_MOVIE', 'ENRICH_MOVIE'], ['ENRICH_MOVIE', 'INDEX_MOVIE']] as const)('serializa enriquecimento do mesmo filme: %s + %s', async (first, second) => {
    db.prepare(`INSERT INTO movies(tmdb_id,title,overview,collection_status,enrichment_status) VALUES(990,'Concurrent',?,'complete','pending')`).run('A verified movie overview. '.repeat(10));
    const jobs = [first, second].map((type) => ({ type, key: `${type}:990`, payload: { tmdb_id: 990 } }));
    for (const j of jobs) db.prepare(`INSERT INTO pipeline_jobs(job_key,type,payload_json,status) VALUES(?,?,?,'queued')`).run(j.key, j.type, JSON.stringify(j.payload));
    const { env } = makeEnv(db, { MOVIE_GENERATION_ENABLED: 'true' });
    const outcomes = await Promise.all(jobs.map((j) => processJob(env, j)));
    expect((globalThis as any).__http).toBe(1);
    expect(outcomes.filter((o) => o.deferred)).toHaveLength(1);
    const pending: any = db.prepare(`SELECT job_key,status,attempts FROM pipeline_jobs WHERE status='queued' AND job_key IN (?,?)`).get(...jobs.map((j) => j.key));
    expect(pending).toMatchObject({ attempts: 0 });
    db.prepare(`UPDATE pipeline_jobs SET available_at=CURRENT_TIMESTAMP WHERE job_key=?`).run(pending.job_key);
    await processJob(env, jobs.find((j) => j.key === pending.job_key)!);
    expect((globalThis as any).__http).toBe(1);
    expect(db.prepare(`SELECT COUNT(*) n FROM pipeline_jobs WHERE job_key IN (?,?) AND status='done'`).get(...jobs.map((j) => j.key))).toEqual({ n: 2 });
    expect(db.prepare(`SELECT COUNT(*) n FROM movie_enrichments`).get()).toEqual({ n: 1 });
    expect(db.prepare(`SELECT enrichment_status,embedding_status FROM movies WHERE tmdb_id=990`).get()).toEqual({ enrichment_status: 'complete', embedding_status: 'complete' });
  });
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
  it('5/6. modo seguro: cron nao agenda, enrich nao chama Groq, nada se perde', async () => {
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
    expect(st.generation.model).toBe('openai/gpt-oss-120b');
  });
  it('7. piloto global limita geracoes pre-enfileiradas', async () => {
    for (let i = 31; i <= 34; i++) {
      db.prepare(`INSERT INTO movies(tmdb_id,title,collection_status,enrichment_status) VALUES(?,'P','complete','pending')`).run(i);
      db.prepare(`INSERT INTO pipeline_jobs(job_key,type,payload_json,status) VALUES(?, 'ENRICH_MOVIE', ?, 'queued')`).run(`enrich:${i}:v2`, JSON.stringify({ tmdb_id: i }));
    }
    const { env } = makeEnv(db, { MOVIE_GENERATION_ENABLED: 'true', MOVIE_GENERATION_PILOT_LIMIT: '2' });
    for (let i = 31; i <= 34; i++) { db.exec('UPDATE groq_capacity SET next_at=0'); await processJob(env, { type: 'ENRICH_MOVIE', key: `enrich:${i}:v2`, payload: { tmdb_id: i } }); }
    expect((db.prepare(`SELECT COUNT(*) n FROM pipeline_jobs WHERE status='done' AND type='ENRICH_MOVIE'`).get() as any).n).toBe(2);
  });
  it('9. embeddings Gemini 768d compativeis', async () => {
    db.exec(`INSERT INTO movies(tmdb_id,title,collection_status,enrichment_status,embedding_status) VALUES(41,'V','complete','complete','pending')`);
    db.prepare(`INSERT INTO movie_enrichments(movie_id,model,schema_version) VALUES((SELECT id FROM movies WHERE tmdb_id=41),'grok-4-3','style-v2')`).run();
    db.exec(`INSERT INTO pipeline_jobs(job_key,type,payload_json,status) VALUES('embed:41:movie-v1','EMBED_MOVIE','{"tmdb_id":41}','queued')`);
    const { env } = makeEnv(db);
    expect((await processJob(env, { type: 'EMBED_MOVIE', key: 'embed:41:movie-v1', payload: { tmdb_id: 41 } })).retry).toBe(false);
    expect((env.MOVIE_VECTORS.upsert.mock.calls[0][0][0].values as number[])).toHaveLength(768);
    const embeddingCalls = vi.mocked(fetch).mock.calls.filter(([url]) => String(url).includes(':embedContent'));
    expect(embeddingCalls).toHaveLength(1);
    expect(String(embeddingCalls[0][0])).toContain('/models/gemini-embedding-2:embedContent');
    expect(JSON.parse(String(embeddingCalls[0][1]?.body))).toMatchObject({ model: 'models/gemini-embedding-2', outputDimensionality: 768, taskType: 'RETRIEVAL_DOCUMENT' });
  });
  it('10/11. circuito aberto nao gera storm', async () => {
    db.exec(`INSERT INTO movies(tmdb_id,title,collection_status,enrichment_status) VALUES(51,'Q','complete','pending')`);
    db.exec(`INSERT INTO pipeline_jobs(job_key,type,payload_json,status) VALUES('enrich:51:v2','ENRICH_MOVIE','{"tmdb_id":51}','queued')`);
    const { env } = makeEnv(db, { MOVIE_GENERATION_ENABLED: 'true' });
    await env.MOOVIBE_LIBRARY.prepare(`INSERT INTO system_state(key,value) VALUES('circuit:generation-groq',?)`).bind(JSON.stringify({ until: new Date(Date.now() + 3600e3).toISOString(), reason: 'RATE_LIMITED' })).run();
    const out: any = await processJob(env, { type: 'ENRICH_MOVIE', key: 'enrich:51:v2', payload: { tmdb_id: 51 } });
    expect(out.retry).toBe(true);
    expect(out.delaySeconds).toBeGreaterThanOrEqual(60);
  });
});
describe('auditoria-c (defeitos restantes)', () => {
  it('1b. centenas de jobs error (available_at passado) nao bloqueiam milhares de pendentes', async () => {
    for (let i = 1; i <= 300; i++) {
      db.prepare(`INSERT INTO movies(tmdb_id,title,collection_status,enrichment_status) VALUES(?,'E','complete','error')`).run(i);
      db.prepare(`INSERT INTO pipeline_jobs(job_key,type,payload_json,status,available_at,updated_at) VALUES(?,?,?, 'error', datetime('now','-1 day'), datetime('now','-2 day'))`).run(`enrich:${i}:v2`, 'ENRICH_MOVIE', JSON.stringify({ tmdb_id: i }));
    }
    for (let i = 1001; i <= 2000; i++) db.prepare(`INSERT INTO movies(tmdb_id,title,collection_status,enrichment_status) VALUES(?,'P','complete','pending')`).run(i);
    const { env, sent } = makeEnv(db, { MOVIE_GENERATION_ENABLED: 'true' });
    await schedule(env);
    const keys = sent.filter((s: any) => s.type === 'ENRICH_MOVIE').map((s: any) => Number(s.key.split(':')[1]));
    expect(keys).toHaveLength(ENRICHMENT_BACKLOG_BUDGET);
    expect(keys.every((k: number) => k >= 1001)).toBe(true);
  });
  it('12. modo seguro adia sem consumir tentativas; >5 ciclos seguem retomaveis', async () => {
    db.prepare(`INSERT INTO movies(tmdb_id,title,collection_status,enrichment_status) VALUES(61,'S','complete','pending')`).run();
    db.prepare(`INSERT INTO pipeline_jobs(job_key,type,payload_json,status) VALUES('enrich:61:v2','ENRICH_MOVIE','{"tmdb_id":61}','queued')`).run();
    const { env } = makeEnv(db); // ENABLED=false (default)
    // 1a entrega adia com cooldown longo sem consumir tentativa...
    const first: any = await processJob(env, { type: 'ENRICH_MOVIE', key: 'enrich:61:v2', payload: { tmdb_id: 61 } });
    expect(first).toMatchObject({ retry: true, deferred: true });
    const cooldown: any = db.prepare(`SELECT available_at FROM pipeline_jobs WHERE job_key='enrich:61:v2'`).get();
    // ...e redeliveries em cooldown nao estendem o prazo nem degradam o job.
    for (let i = 0; i < 8; i++) {
      const out: any = await processJob(env, { type: 'ENRICH_MOVIE', key: 'enrich:61:v2', payload: { tmdb_id: 61 } });
      expect(out).toEqual({ retry: false });
    }
    expect(db.prepare(`SELECT available_at FROM pipeline_jobs WHERE job_key='enrich:61:v2'`).get()).toEqual(cooldown);
    const row: any = db.prepare(`SELECT status,attempts,last_error FROM pipeline_jobs WHERE job_key='enrich:61:v2'`).get();
    expect(row).toMatchObject({ status: 'queued', attempts: 0 });
    expect(row.last_error).toContain('GENERATION_DEFERRED');
    // Retomada: cooldown expira e administrador ativa a geracao.
    db.prepare(`UPDATE pipeline_jobs SET available_at=CURRENT_TIMESTAMP WHERE job_key='enrich:61:v2'`).run();
    env.MOVIE_GENERATION_ENABLED = 'true';
    const out2: any = await processJob(env, { type: 'ENRICH_MOVIE', key: 'enrich:61:v2', payload: { tmdb_id: 61 } });
    expect(out2).toEqual({ retry: false });
    expect(db.prepare(`SELECT status,attempts FROM pipeline_jobs WHERE job_key='enrich:61:v2'`).get()).toMatchObject({ status: 'done', attempts: 1 });
  });
  it('13. piloto atomico: 50 concorrentes reservam exatamente o limite de 25', async () => {
    for (let i = 71; i <= 120; i++) {
      db.prepare(`INSERT INTO movies(tmdb_id,title,collection_status,enrichment_status) VALUES(?,'C','complete','pending')`).run(i);
      db.prepare(`INSERT INTO pipeline_jobs(job_key,type,payload_json,status) VALUES(?, 'ENRICH_MOVIE', ?, 'queued')`).run(`enrich:${i}:v2`, JSON.stringify({ tmdb_id: i }));
    }
    const { env } = makeEnv(db, { MOVIE_GENERATION_ENABLED: 'true', MOVIE_GENERATION_PILOT_LIMIT: '25' });
    const results = await Promise.all(Array.from({length:50},()=>__testPilotConsume(env.MOOVIBE_LIBRARY,25)));
    expect(results.filter(Boolean)).toHaveLength(25);
    const counter = db.prepare(`SELECT value FROM system_state WHERE key='gen_pilot_count:groq'`).get() as any;
    expect(JSON.parse(counter.value).count).toBe(25);
  });
  it('14. piloto nao reservado quando nao ha chamada de provedor (circuito, modo seguro, job pronto)', async () => {
    // a) modo seguro: nenhuma linha de contador.
    db.prepare(`INSERT INTO movies(tmdb_id,title,collection_status,enrichment_status) VALUES(81,'A','complete','pending')`).run();
    db.prepare(`INSERT INTO pipeline_jobs(job_key,type,payload_json,status) VALUES('enrich:81:v2','ENRICH_MOVIE','{"tmdb_id":81}','queued')`).run();
    await processJob(makeEnv(db).env, { type: 'ENRICH_MOVIE', key: 'enrich:81:v2', payload: { tmdb_id: 81 } });
    expect(db.prepare(`SELECT COUNT(*) n FROM system_state WHERE key='gen_pilot_count:groq'`).get()).toEqual({ n: 0 });
    // b) circuito aberto: defere sem reservar piloto.
    db.prepare(`INSERT INTO movies(tmdb_id,title,collection_status,enrichment_status) VALUES(82,'B','complete','pending')`).run();
    db.prepare(`INSERT INTO pipeline_jobs(job_key,type,payload_json,status) VALUES('enrich:82:v2','ENRICH_MOVIE','{"tmdb_id":82}','queued')`).run();
    const b = makeEnv(db, { MOVIE_GENERATION_ENABLED: 'true' });
    await b.env.MOOVIBE_LIBRARY.prepare(`INSERT INTO system_state(key,value) VALUES('circuit:generation-groq',?)`).bind(JSON.stringify({ until: new Date(Date.now() + 3600e3).toISOString(), reason: 'RATE_LIMITED' })).run();
    await processJob(b.env, { type: 'ENRICH_MOVIE', key: 'enrich:82:v2', payload: { tmdb_id: 82 } });
    expect(db.prepare(`SELECT COUNT(*) n FROM system_state WHERE key='gen_pilot_count:groq'`).get()).toEqual({ n: 0 });
    // c) job ja pronto: enriquecimento completo nao reserva piloto.
    db.prepare(`INSERT INTO movies(tmdb_id,title,collection_status,enrichment_status) VALUES(83,'C','complete','complete')`).run();
    db.prepare(`INSERT INTO movie_enrichments(movie_id,model,schema_version) VALUES((SELECT id FROM movies WHERE tmdb_id=83),'grok-4-3','style-v2')`).run();
    db.prepare(`INSERT INTO pipeline_jobs(job_key,type,payload_json,status) VALUES('enrich:83:v2','ENRICH_MOVIE','{"tmdb_id":83}','queued')`).run();
    const c = makeEnv(db, { MOVIE_GENERATION_ENABLED: 'true' });
    await processJob(c.env, { type: 'ENRICH_MOVIE', key: 'enrich:83:v2', payload: { tmdb_id: 83 } });
    expect(db.prepare(`SELECT COUNT(*) n FROM system_state WHERE key='gen_pilot_count:groq'`).get()).toEqual({ n: 0 });
  });
  it('15. recover idempotente: rerun nao reenvia; done intocado; ENRICH 25 nao bloqueia INDEX', async () => {
    for (let i = 1; i <= 12; i++) {
      db.prepare(`INSERT INTO movies(tmdb_id,title,collection_status,enrichment_status) VALUES(?,'E','complete','error')`).run(i);
      db.prepare(`INSERT INTO pipeline_jobs(job_key,type,payload_json,status,last_error) VALUES(?,'ENRICH_MOVIE',?,'error','xAI 429')`).run(`enrich:${i}:v2`, JSON.stringify({ tmdb_id: i }));
    }
    db.prepare(`INSERT INTO movies(tmdb_id,title,collection_status,enrichment_status,embedding_status) VALUES(91,'I1','complete','complete','pending')`).run();
    db.prepare(`INSERT INTO pipeline_jobs(job_key,type,payload_json,status,last_error) VALUES('index:91:v1','INDEX_MOVIE','{"tmdb_id":91}','error','xAI 429')`).run();
    db.prepare(`INSERT INTO movies(tmdb_id,title,collection_status,enrichment_status,embedding_status) VALUES(92,'I2','complete','pending','pending')`).run();
    db.prepare(`INSERT INTO pipeline_jobs(job_key,type,payload_json,status,last_error) VALUES('index:92:v1','INDEX_MOVIE','{"tmdb_id":92}','error','xAI 429')`).run();
    const { env, sent } = makeEnv(db);
    const dry: any = await recoverGenerationBacklog(env, 25, true);
    // Plano real: 12 ENRICH diretos + derivados (embed:91 + enrich:92) — INDEX
    // nao e bloqueado pelo lote de ENRICH (budgets por tipo).
    expect(dry.dry_run).toBe(true);
    expect(dry.eligible).toBe(14);
    expect(dry.by_type).toMatchObject({ ENRICH_MOVIE: 13, EMBED_MOVIE: 1 });
    expect(sent).toHaveLength(0);
    const real: any = await recoverGenerationBacklog(env, 25, false);
    expect(real.requeued).toBe(dry.eligible);
    expect(sent).toHaveLength(dry.eligible);
    // Rerun: ENRICH esgotados (viraram queued); derivados ja existem (queued) => zero reenvios.
    const again: any = await recoverGenerationBacklog(env, 25, false);
    expect(again.requeued).toBe(0);
    expect(again.skipped).toBe(2);
    expect(sent).toHaveLength(dry.eligible);
    // Job 'done' nao e refeito: derive embed para filme com job embed done.
    db.prepare(`INSERT INTO movies(tmdb_id,title,collection_status,enrichment_status,embedding_status) VALUES(93,'D','complete','complete','pending')`).run();
    db.prepare(`INSERT INTO pipeline_jobs(job_key,type,payload_json,status,last_error) VALUES('index:93:v1','INDEX_MOVIE','{"tmdb_id":93}','error','xAI 429')`).run();
    db.prepare(`INSERT INTO pipeline_jobs(job_key,type,payload_json,status) VALUES('embed:93:movie-v1','EMBED_MOVIE','{"tmdb_id":93}','done')`).run();
    const before = sent.length;
    const skip: any = await recoverGenerationBacklog(env, 25, false);
    expect(skip.requeued).toBe(0);
    expect(skip.skipped).toBeGreaterThanOrEqual(3);
    expect(sent.length).toBe(before);
  });
});
describe('auditoria-d (orquestracao de fila e piloto)', () => {
  const msg = (body: any) => ({ body, ack: vi.fn(), retry: vi.fn() });
  const longOverview = 'A long overview used to skip the Wikipedia fallback path deterministically in tests. '.repeat(2);
  it('16. adiamento acka a mensagem da fila e mantem o job durvel em D1', async () => {
    db.prepare(`INSERT INTO movies(tmdb_id,title,collection_status,enrichment_status) VALUES(61,'S','complete','pending')`).run();
    db.prepare(`INSERT INTO pipeline_jobs(job_key,type,payload_json,status) VALUES('enrich:61:v2','ENRICH_MOVIE','{\"tmdb_id\":61}','queued')`).run();
    const { env } = makeEnv(db); // ENABLED=false
    const m: any = msg({ type: 'ENRICH_MOVIE', key: 'enrich:61:v2', payload: { tmdb_id: 61 } });
    await (pipelineWorker as any).queue({ messages: [m] }, env);
    expect(m.ack).toHaveBeenCalledTimes(1);
    expect(m.retry).not.toHaveBeenCalled();
    const row: any = db.prepare(`SELECT status,attempts,last_error,available_at FROM pipeline_jobs WHERE job_key='enrich:61:v2'`).get();
    expect(row).toMatchObject({ status: 'queued', attempts: 0 });
    expect(row.last_error).toContain('GENERATION_DEFERRED');
    const floor: any = db.prepare(`SELECT datetime('now','+43100 seconds') x`).get();
    expect(row.available_at >= floor.x).toBe(true);
  });
  it('17. cooldown respeitado: redelivery precoce acka sem estender o prazo', async () => {
    db.prepare(`INSERT INTO movies(tmdb_id,title,collection_status,enrichment_status) VALUES(62,'S','complete','pending')`).run();
    db.prepare(`INSERT INTO pipeline_jobs(job_key,type,payload_json,status) VALUES('enrich:62:v2','ENRICH_MOVIE','{\"tmdb_id\":62}','queued')`).run();
    const { env } = makeEnv(db);
    await (pipelineWorker as any).queue({ messages: [msg({ type: 'ENRICH_MOVIE', key: 'enrich:62:v2', payload: { tmdb_id: 62 } })] }, env);
    const cooldown: any = db.prepare(`SELECT available_at FROM pipeline_jobs WHERE job_key='enrich:62:v2'`).get();
    const m2: any = msg({ type: 'ENRICH_MOVIE', key: 'enrich:62:v2', payload: { tmdb_id: 62 } });
    await (pipelineWorker as any).queue({ messages: [m2] }, env);
    expect(m2.ack).toHaveBeenCalledTimes(1);
    expect(m2.retry).not.toHaveBeenCalled();
    expect(db.prepare(`SELECT available_at,attempts,status FROM pipeline_jobs WHERE job_key='enrich:62:v2'`).get())
      .toEqual({ available_at: cooldown.available_at, attempts: 0, status: 'queued' });
    db.prepare(`UPDATE pipeline_jobs SET available_at=CURRENT_TIMESTAMP WHERE job_key='enrich:62:v2'`).run();
    const m3: any = msg({ type: 'ENRICH_MOVIE', key: 'enrich:62:v2', payload: { tmdb_id: 62 } });
    await (pipelineWorker as any).queue({ messages: [m3] }, env);
    expect(m3.ack).toHaveBeenCalledTimes(1);
    expect(m3.retry).not.toHaveBeenCalled();
    expect((db.prepare(`SELECT attempts,status FROM pipeline_jobs WHERE job_key='enrich:62:v2'`).get() as any)).toEqual({ attempts: 0, status: 'queued' });
  });
  it('18. lote concorrente: pacing global adia sem consumir retries', async () => {
    for (let i = 201; i <= 205; i++) {
      db.prepare(`INSERT INTO movies(tmdb_id,title,overview,collection_status,enrichment_status) VALUES(?,'C',?,'complete','pending')`).run(i, longOverview);
      db.prepare(`INSERT INTO pipeline_jobs(job_key,type,payload_json,status) VALUES(?, 'ENRICH_MOVIE', ?, 'queued')`).run(`enrich:${i}:v2`, JSON.stringify({ tmdb_id: i }));
    }
    const { env } = makeEnv(db, { MOVIE_GENERATION_ENABLED: 'true' });
    const msgs: any[] = [201, 202, 203, 204, 205].map((i) => msg({ type: 'ENRICH_MOVIE', key: `enrich:${i}:v2`, payload: { tmdb_id: i } }));
    await (pipelineWorker as any).queue({ messages: msgs }, env);
    for (const m of msgs) { expect(m.ack).toHaveBeenCalledTimes(1); expect(m.retry).not.toHaveBeenCalled(); }
    expect((db.prepare(`SELECT COUNT(*) n FROM pipeline_jobs WHERE type='ENRICH_MOVIE' AND status='done'`).get() as any).n).toBe(1);
    expect((globalThis as any).__genMaxInflight).toBe(1);
  });
  it('19. falha inesperada isola a mensagem e nao derruba o lote', async () => {
    db.prepare(`INSERT INTO movies(tmdb_id,title,overview,collection_status,enrichment_status,embedding_status) VALUES(301,'G',?,'complete','complete','pending')`).run(longOverview);
    db.prepare(`INSERT INTO movie_enrichments(movie_id,model,schema_version) VALUES((SELECT id FROM movies WHERE tmdb_id=301),'grok-4-3','style-v2')`).run();
    db.prepare(`INSERT INTO pipeline_jobs(job_key,type,payload_json,status) VALUES('embed:301:movie-v1','EMBED_MOVIE','{\"tmdb_id\":301}','queued')`).run();
    db.prepare(`INSERT INTO movies(tmdb_id,title,overview,collection_status,enrichment_status) VALUES(302,'B',?,'complete','pending')`).run(longOverview);
    db.prepare(`INSERT INTO pipeline_jobs(job_key,type,payload_json,status) VALUES('enrich:302:v2','ENRICH_MOVIE','{\"tmdb_id\":302}','queued')`).run();
    const { env } = makeEnv(db, { MOVIE_GENERATION_ENABLED: 'true' });
    const base = env.MOOVIBE_LIBRARY.prepare;
    env.MOOVIBE_LIBRARY.prepare = (sql: string) => {
      const st: any = base(sql);
      const bind = st.bind.bind(st);
      st.bind = (...v: any[]) => {
        if (sql.includes(`SET status='running',attempts=attempts+1`) && v[0] === 'enrich:302:v2') throw new Error('D1 unavailable');
        return bind(...v);
      };
      return st;
    };
    const mBad: any = msg({ type: 'ENRICH_MOVIE', key: 'enrich:302:v2', payload: { tmdb_id: 302 } });
    const mGood: any = msg({ type: 'EMBED_MOVIE', key: 'embed:301:movie-v1', payload: { tmdb_id: 301 } });
    await (pipelineWorker as any).queue({ messages: [mBad, mGood] }, env);
    expect(mBad.retry).toHaveBeenCalledTimes(1);
    expect(mBad.ack).not.toHaveBeenCalled();
    expect(mGood.ack).toHaveBeenCalledTimes(1);
    expect(mGood.retry).not.toHaveBeenCalled();
    expect(db.prepare(`SELECT status FROM pipeline_jobs WHERE job_key='embed:301:movie-v1'`).get()).toEqual({ status: 'done' });
    expect(db.prepare(`SELECT status,attempts FROM pipeline_jobs WHERE job_key='enrich:302:v2'`).get()).toEqual({ status: 'queued', attempts: 0 });
  });
  it('20. pausa prolongada nao agenda nem retoma sozinha; retomada envia uma unica mensagem', async () => {
    db.exec(`INSERT INTO collection_queries(query_id,label,params_json,is_executable,status,next_page,next_run_at) VALUES('recent-v2:000-pause','P','{}',1,'pending',2,CURRENT_TIMESTAMP)`);
    db.exec(`INSERT INTO pipeline_jobs(job_key,type,payload_json,status) VALUES('discover:recent-v2:000-pause:v1','DISCOVER_QUERY','{\"query_id\":\"recent-v2:000-pause\"}','queued')`);
    const { env, sent } = makeEnv(db);
    await updatePipelineControl(env.MOOVIBE_LIBRARY, { historical_enabled: false, recent_enabled: false });
    const out: any = await processJob(env, { type: 'DISCOVER_QUERY', key: 'discover:recent-v2:000-pause:v1', payload: { query_id: 'recent-v2:000-pause' } });
    expect(out).toEqual({ retry: false });
    expect(db.prepare(`SELECT status,attempts FROM pipeline_jobs WHERE job_key='discover:recent-v2:000-pause:v1'`).get()).toEqual({ status: 'paused', attempts: 0 });
    for (let i = 0; i < 3; i++) await schedule(env);
    db.prepare(`UPDATE pipeline_jobs SET updated_at=datetime('now','-2 day') WHERE job_key='discover:recent-v2:000-pause:v1'`).run();
    await schedule(env);
    expect(sent).toHaveLength(0);
    expect(db.prepare(`SELECT status,next_page FROM collection_queries WHERE query_id='recent-v2:000-pause'`).get()).toEqual({ status: 'pending', next_page: 2 });
    await updatePipelineControl(env.MOOVIBE_LIBRARY, { recent_enabled: true });
    await schedule(env);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ type: 'DISCOVER_QUERY', key: 'discover:recent-v2:000-pause:v1' });
    expect(db.prepare(`SELECT status FROM pipeline_jobs WHERE job_key='discover:recent-v2:000-pause:v1'`).get()).toEqual({ status: 'queued' });
    await schedule(env);
    expect(sent).toHaveLength(1);
  });
  it('21. INDEX_MOVIE seguro: cron nao agenda trabalho pago desligado; outbox retoma apos ativacao', async () => {
    db.prepare(`INSERT INTO movies(tmdb_id,title,overview,collection_status,enrichment_status) VALUES(901,'U',?,'discovered','pending')`).run(longOverview);
    db.prepare(`INSERT INTO movies(tmdb_id,title,overview,collection_status,enrichment_status,embedding_status) VALUES(902,'E',?,'discovered','complete','pending')`).run(longOverview);
    db.prepare(`INSERT INTO movie_enrichments(movie_id,model,schema_version) VALUES((SELECT id FROM movies WHERE tmdb_id=902),'grok-4-3','style-v2')`).run();
    const { env, sent } = makeEnv(db); // ENABLED=false
    await schedule(env);
    expect(sent.some((s: any) => s.key === 'index:901:v1')).toBe(false);
    expect(sent.some((s: any) => s.key === 'index:902:v1')).toBe(true);
    db.prepare(`INSERT INTO pipeline_jobs(job_key,type,payload_json,status) VALUES('index:901:v1','INDEX_MOVIE','{\"tmdb_id\":901}','queued')`).run();
    const m: any = msg({ type: 'INDEX_MOVIE', key: 'index:901:v1', payload: { tmdb_id: 901 } });
    await (pipelineWorker as any).queue({ messages: [m] }, env);
    expect(m.ack).toHaveBeenCalledTimes(1);
    expect(m.retry).not.toHaveBeenCalled();
    expect(db.prepare(`SELECT status,attempts FROM pipeline_jobs WHERE job_key='index:901:v1'`).get()).toMatchObject({ status: 'queued', attempts: 0 });
    env.MOVIE_GENERATION_ENABLED = 'true';
    db.prepare(`UPDATE pipeline_jobs SET available_at=CURRENT_TIMESTAMP,updated_at=datetime('now','-10 minutes') WHERE job_key='index:901:v1'`).run();
    const before = sent.length;
    await schedule(env);
    expect(sent.slice(before).filter((s: any) => s.key === 'index:901:v1')).toHaveLength(1);
  });
  it('22. fluxo real enrich+GroqClient: 1 HTTP = 1 vaga; falha conta sem devolver', async () => {
    db.prepare(`INSERT INTO movies(tmdb_id,title,overview,collection_status,enrichment_status) VALUES(911,'P',?,'complete','pending')`).run(longOverview);
    db.prepare(`INSERT INTO pipeline_jobs(job_key,type,payload_json,status) VALUES('enrich:911:v2','ENRICH_MOVIE','{\"tmdb_id\":911}','queued')`).run();
    const { env } = makeEnv(db, { MOVIE_GENERATION_ENABLED: 'true', MOVIE_GENERATION_PILOT_LIMIT: '5' });
    (globalThis as any).__genFailPlan = ['fail:transient', 'fail:timeout', 'ok'];
    const job = { type: 'ENRICH_MOVIE', key: 'enrich:911:v2', payload: { tmdb_id: 911 } };
    const first = msg(job);
    await (pipelineWorker as any).queue({messages:[first]},env);
    expect(first.ack).toHaveBeenCalledOnce();
    expect(first.retry).not.toHaveBeenCalled();
    expect((globalThis as any).__http).toBe(1); // immediate internal retry is paced
    expect(db.prepare(`SELECT attempts,status FROM pipeline_jobs WHERE job_key=?`).get(job.key)).toEqual({attempts:0,status:'queued'});
    for(let i=0;i<2;i++) {
      db.exec('UPDATE groq_capacity SET next_at=0');
      db.prepare(`UPDATE pipeline_jobs SET available_at=CURRENT_TIMESTAMP WHERE job_key=?`).run(job.key);
      await (pipelineWorker as any).queue({messages:[msg(job)]},env);
    }
    expect((globalThis as any).__http).toBe(3);
    expect(JSON.parse((db.prepare(`SELECT value FROM system_state WHERE key='gen_pilot_count:groq'`).get() as any).value)).toMatchObject({count:3,attempts:3,success:1,failed:2});
    expect(db.prepare(`SELECT status FROM pipeline_jobs WHERE job_key=?`).get(job.key)).toEqual({status:'done'});
  });

  it('22b. geracao desativada = zero HTTP e zero vagas; limite esgotado nega sem rede', async () => {
    db.prepare(`INSERT INTO movies(tmdb_id,title,overview,collection_status,enrichment_status) VALUES(912,'D',?,'complete','pending')`).run(longOverview);
    db.prepare(`INSERT INTO pipeline_jobs(job_key,type,payload_json,status) VALUES('enrich:912:v2','ENRICH_MOVIE','{\"tmdb_id\":912}','queued')`).run();
    const { env } = makeEnv(db); // ENABLED=false
    const m: any = msg({ type: 'ENRICH_MOVIE', key: 'enrich:912:v2', payload: { tmdb_id: 912 } });
    await (pipelineWorker as any).queue({ messages: [m] }, env);
    expect(m.ack).toHaveBeenCalledTimes(1);
    expect((globalThis as any).__http).toBe(0);
    expect(db.prepare(`SELECT COUNT(*) n FROM system_state WHERE key='gen_pilot_count:groq'`).get()).toEqual({ n: 0 });
    // Limite esgotado: nenhuma chamada apos atingir o teto.
    const { env: env2 } = makeEnv(db, { MOVIE_GENERATION_ENABLED: 'true', MOVIE_GENERATION_PILOT_LIMIT: '2' });
    db.prepare(`INSERT INTO movies(tmdb_id,title,overview,collection_status,enrichment_status) VALUES(913,'L',?,'complete','pending')`).run(longOverview);
    db.prepare(`INSERT INTO pipeline_jobs(job_key,type,payload_json,status) VALUES('enrich:913:v2','ENRICH_MOVIE','{\"tmdb_id\":913}','queued')`).run();
    db.prepare(`INSERT INTO movies(tmdb_id,title,overview,collection_status,enrichment_status) VALUES(914,'L',?,'complete','pending')`).run(longOverview);
    db.prepare(`INSERT INTO pipeline_jobs(job_key,type,payload_json,status) VALUES('enrich:914:v2','ENRICH_MOVIE','{\"tmdb_id\":914}','queued')`).run();
    await (pipelineWorker as any).queue({ messages: [msg({ type: 'ENRICH_MOVIE', key: 'enrich:913:v2', payload: { tmdb_id: 913 } })] }, env2);
    expect((globalThis as any).__http).toBe(1);
    db.exec('UPDATE groq_capacity SET next_at=0');
    await (pipelineWorker as any).queue({ messages: [msg({ type: 'ENRICH_MOVIE', key: 'enrich:914:v2', payload: { tmdb_id: 914 } })] }, env2);
    expect((globalThis as any).__http).toBe(2);
    // 3o job: teto atingido — deferido antes da rede, attempts do job intactos.
    db.prepare(`INSERT INTO movies(tmdb_id,title,overview,collection_status,enrichment_status) VALUES(915,'L',?,'complete','pending')`).run(longOverview);
    db.prepare(`INSERT INTO pipeline_jobs(job_key,type,payload_json,status) VALUES('enrich:915:v2','ENRICH_MOVIE','{\"tmdb_id\":915}','queued')`).run();
    const m3: any = msg({ type: 'ENRICH_MOVIE', key: 'enrich:915:v2', payload: { tmdb_id: 915 } });
    await (pipelineWorker as any).queue({ messages: [m3] }, env2);
    expect(m3.ack).toHaveBeenCalledTimes(1);
    expect((globalThis as any).__http).toBe(2);
    expect(db.prepare(`SELECT status,attempts FROM pipeline_jobs WHERE job_key='enrich:915:v2'`).get()).toMatchObject({ status: 'queued', attempts: 0 });
  });
  it('23. processamento completo via fila: INDEX enriquece, vetoriza e marca o filme completo', async () => {
    db.prepare(`INSERT INTO movies(tmdb_id,title,overview,collection_status,enrichment_status,embedding_status) VALUES(921,'F',?,'discovered','pending','pending')`).run(longOverview);
    db.prepare(`INSERT INTO pipeline_jobs(job_key,type,payload_json,status) VALUES('index:921:v1','INDEX_MOVIE','{\"tmdb_id\":921}','queued')`).run();
    const { env, sent } = makeEnv(db, { MOVIE_GENERATION_ENABLED: 'true' });
    const m: any = msg({ type: 'INDEX_MOVIE', key: 'index:921:v1', payload: { tmdb_id: 921 } });
    await (pipelineWorker as any).queue({ messages: [m] }, env);
    expect(m.ack).toHaveBeenCalledTimes(1);
    expect(m.retry).not.toHaveBeenCalled();
    expect(db.prepare(`SELECT collection_status,enrichment_status,embedding_status FROM movies WHERE tmdb_id=921`).get())
      .toEqual({ collection_status: 'complete', enrichment_status: 'complete', embedding_status: 'complete' });
    expect(db.prepare(`SELECT status FROM pipeline_jobs WHERE job_key='index:921:v1'`).get()).toEqual({ status: 'done' });
    expect((env.MOVIE_VECTORS.upsert.mock.calls[0][0][0].values as number[])).toHaveLength(768);
    const counter: any = db.prepare(`SELECT value FROM system_state WHERE key='gen_pilot_count:groq'`).get();
    expect(JSON.parse(counter.value)).toMatchObject({ count: 1 });
    expect(sent.filter((s: any) => s.type === 'EMBED_MOVIE')).toHaveLength(0);
  });
  it('24. recover INDEX avanca: 100 erros em lotes de 25 alcançam todos sem reprocessar', async () => {
    for (let i = 1001; i <= 1100; i++) {
      db.prepare(`INSERT INTO movies(tmdb_id,title,collection_status,enrichment_status,embedding_status) VALUES(?,'R','discovered','pending','pending')`).run(i);
      db.prepare(`INSERT INTO pipeline_jobs(job_key,type,payload_json,status,last_error,updated_at) VALUES(?,'INDEX_MOVIE',?,'error','xAI 429 rate limit',datetime('now','-1 day'))`).run(`index:${i}:v1`, JSON.stringify({ tmdb_id: i }));
    }
    const { env, sent } = makeEnv(db);
    const seen = new Set<string>();
    let batches = 0, requeuedTotal = 0, advancedTotal = 0;
    for (let b = 0; b < 8; b++) {
      const r: any = await recoverGenerationBacklog(env, 25, false);
      batches++;
      requeuedTotal += r.requeued;
      advancedTotal += r.advanced || 0;
      for (const s of sent.splice(0)) seen.add(`${s.type}:${s.key}`);
      if (r.requeued === 0) break;
    }
    // 100 INDEX diretos planejados (25/lote x 4 lotes), cada chave 1x.
    expect(Array.from(seen).filter((k) => k.startsWith('INDEX_MOVIE:index:')).length).toBe(100);
    expect(requeuedTotal).toBe(100);
    expect(advancedTotal).toBe(0); // INDEX direto reativa (sai de error); toque e so p/ derivado
    expect((db.prepare(`SELECT COUNT(*) n FROM pipeline_jobs WHERE type='INDEX_MOVIE' AND status='error'`).get() as any).n).toBe(0);
    expect((db.prepare(`SELECT COUNT(DISTINCT job_key) n FROM pipeline_jobs WHERE type='INDEX_MOVIE' AND status='queued'`).get() as any).n).toBe(100);
    // Nenhum INDEX marcado done sem etapas concluidas.
    expect((db.prepare(`SELECT COUNT(*) n FROM pipeline_jobs WHERE type='INDEX_MOVIE' AND status='done'`).get() as any).n).toBe(0);
    // Lote extra apos drenar: nada reenviado, nada duplicado.
    const tail: any = await recoverGenerationBacklog(env, 25, false);
    expect(tail.requeued).toBe(0);
    expect(sent).toHaveLength(0);
    expect(batches).toBeLessThanOrEqual(6);
  });
  it('25. recover INDEX com derivados existentes avanca sem duplicar mensagens', async () => {
    for (let i = 2001; i <= 2030; i++) {
      db.prepare(`INSERT INTO movies(tmdb_id,title,collection_status,enrichment_status,embedding_status) VALUES(?,'R','complete','pending','pending')`).run(i);
      db.prepare(`INSERT INTO pipeline_jobs(job_key,type,payload_json,status,last_error,updated_at) VALUES(?,'INDEX_MOVIE',?,'error','xAI 500 provider unavailable',datetime('now','-1 day'))`).run(`index:${i}:v1`, JSON.stringify({ tmdb_id: i }));
    }
    // Metade ja tem derivado queued (trabalho anterior nao concluido): o
    // recover nao deve reenvia-los, mas deve visitar as fontes e avancar.
    for (let i = 2001; i <= 2015; i++)
      db.prepare(`INSERT INTO pipeline_jobs(job_key,type,payload_json,status,available_at) VALUES(?,'ENRICH_MOVIE',?,'queued',CURRENT_TIMESTAMP)`).run(`enrich:${i}:v2`, JSON.stringify({ tmdb_id: i }));
    const { env, sent } = makeEnv(db);
    const first: any = await recoverGenerationBacklog(env, 25, false);
    expect(first.eligible).toBeLessThanOrEqual(25);
    const resent = sent.filter((s: any) => s.type === 'ENRICH_MOVIE' && Number(s.key.split(':')[1]) <= 2015);
    expect(resent).toHaveLength(0); // derivados existentes: sem duplicata
    const second: any = await recoverGenerationBacklog(env, 25, false);
    const fresh = sent.filter((s: any) => s.type === 'ENRICH_MOVIE' && Number(s.key.split(':')[1]) > 2015);
    expect(fresh.length).toBeGreaterThan(0);
    expect(second.requeued).toBeGreaterThan(0);
    // Idempotencia total: nenhum par type:key repetido em todos os sends.
    const all = sent.map((s: any) => `${s.type}:${s.key}`);
    expect(new Set(all).size).toBe(all.length);
  });
  it('26. scheduler nao deixa queued bloquear orcamento: novos filmes sao agendados', async () => {
    // 8 primeiros candidatos (por updated_at) com jobs queued VENCIDOS mas
    // com publicacao confirmada: o outbox respeita a retencao da Queue, e o
    // backlog NAO pode consumi-los — prova que queued nao bloqueia orcamento.
    for (let i = 3001; i <= 3008; i++) {
      db.prepare(`INSERT INTO movies(tmdb_id,title,collection_status,enrichment_status,updated_at) VALUES(?,'Q','complete','pending',datetime('now','-2 day'))`).run(i);
      db.prepare(`INSERT INTO pipeline_jobs(job_key,type,payload_json,status,available_at,updated_at) VALUES(?,'ENRICH_MOVIE',?,'queued',CURRENT_TIMESTAMP,datetime('now','-1 minute'))`).run(`enrich:${i}:v2`, JSON.stringify({ tmdb_id: i }));
    }
    db.exec(`UPDATE pipeline_jobs SET queue_lease_until=datetime('now','+25 hours') WHERE job_key LIKE 'enrich:30%'`);
    for (let i = 4001; i <= 4300; i++)
      db.prepare(`INSERT INTO movies(tmdb_id,title,collection_status,enrichment_status,updated_at) VALUES(?,'N','complete','pending',CURRENT_TIMESTAMP)`).run(i);
    const { env, sent } = makeEnv(db, { MOVIE_GENERATION_ENABLED: 'true' });
    await schedule(env);
    const enrichKeys = sent.filter((s: any) => s.type === 'ENRICH_MOVIE').map((s: any) => Number(s.key.split(':')[1]));
    // Budget de enrichment preenchido com trabalho NOVO (sem job): os 8
    // queued nao ocupam vaga do backlog (nao sao reenviados aqui).
    expect(enrichKeys.length).toBeGreaterThan(0);
    expect(enrichKeys.every((k: number) => k >= 4001)).toBe(true);
    expect(enrichKeys.some((k: number) => k <= 3008)).toBe(false);
    // Recuperação dos queued e EXCLUSIVA do outbox: apos o threshold (5min),
    // o cron os reenvia — sem duplicar com o backlog (que nunca os toca).
    db.prepare(`UPDATE pipeline_jobs SET queue_lease_until=datetime('now','-1 minute') WHERE job_key LIKE 'enrich:30%'`).run();
    const before = sent.length;
    await schedule(env);
    const fresh = sent.slice(before).filter((s: any) => s.type === 'ENRICH_MOVIE').map((s: any) => s.key);
    expect(fresh.filter((k: string) => Number(k.split(':')[1]) <= 3008)).toHaveLength(8);
    expect(new Set(sent.filter((s: any) => s.type === 'ENRICH_MOVIE').map((s: any) => s.key)).size)
      .toBe(sent.filter((s: any) => s.type === 'ENRICH_MOVIE').length);
  });
});

