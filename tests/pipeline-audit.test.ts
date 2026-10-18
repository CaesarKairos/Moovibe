import { beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
vi.mock('../workers/pipeline/src/generation-factory', () => ({
  DEFAULT_XAI_MODEL: 'grok-4-3',
  isMovieGenerationEnabled: (env: any) => String(env?.MOVIE_GENERATION_ENABLED || 'false').toLowerCase() === 'true',
  createMovieGenerationProvider: () => ({
    name: 'xai',
    // Instrumentado: mede chamadas simultaneas (concorrencia) e permite falhar
    // as proximas chamadas via globalThis.__genMock = { failNext: n }.
    generateJson: async () => {
      const g: any = globalThis as any;
      g.__genInflight = (g.__genInflight || 0) + 1;
      g.__genMaxInflight = Math.max(g.__genMaxInflight || 0, g.__genInflight);
      try {
        await new Promise((r) => setTimeout(r, 5));
        const mock = g.__genMock;
        if (mock && Number(mock.failNext) > 0) { mock.failNext -= 1; throw new Error('xAI 429 rate limited'); }
        return { provider: 'xai', model: 'grok-4-3',
          data: { moods: ['calm'], themes: ['memory'], atmosphere: ['warm'], pace: 'medium', visual_style: ['natural'], emotional_valence: .5, energy: .5, intimacy: .5, surrealism: .1, darkness: .1, humor: .2, romanticism: .2, narrative_density: .5, melancholy_level: .2, tension_level: .2, confidence: .9 } };
      } finally { g.__genInflight -= 1; }
    }
  })
}));
vi.mock('../functions/_lib/gemini.js', () => ({
  RetryableError: class RetryableError extends Error { retryAfter: number; constructor(m: string, r = 0) { super(m); this.retryAfter = r; } },
  GeminiClient: class { async generateJson() { throw new Error('no-call'); } async embed() { return Array(768).fill(0.01); } }
}));
import pipelineWorker, { processJob, schedule, recoverGenerationBacklog, providerStatus, providerStatusFull } from '../workers/pipeline/src/index.js';
import { updatePipelineControl } from '../workers/pipeline/src/pipeline-control.js';
import { ENRICHMENT_BACKLOG_BUDGET } from '../workers/pipeline/src/job-policy.js';
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
    GEMINI_API_KEY: 'x', XAI_API_KEY: 'x', TMDB_API_KEY: 'x', EMBEDDING_MODEL: 'gemini-embedding-2',
    EMBEDDING_DIMENSIONS: '768', EMBEDDING_SCHEMA_VERSION: 'movie-v1',
    MOVIE_GENERATION_PROVIDER: 'xai', MOVIE_GENERATION_MODEL: 'grok-4-3',
    MOVIE_GENERATION_ENABLED: 'false', MOVIE_GENERATION_PILOT_LIMIT: '25', ...extra };
  return { env, sent };
};
let db: Database.Database;
beforeEach(() => { db = new Database(':memory:'); for (const f of fs.readdirSync('migrations').filter((x) => x.endsWith('.sql')).sort()) db.exec(fs.readFileSync(`migrations/${f}`, 'utf8')); const g: any = globalThis as any; g.__genInflight = 0; g.__genMaxInflight = 0; g.__genMock = undefined; });
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
    await Promise.all(Array.from({ length: 50 }, (_, k) => processJob(env, { type: 'ENRICH_MOVIE', key: `enrich:${71 + k}:v2`, payload: { tmdb_id: 71 + k } })));
    const done = db.prepare(`SELECT COUNT(*) n FROM pipeline_jobs WHERE type='ENRICH_MOVIE' AND status='done'`).get() as any;
    const queued = db.prepare(`SELECT COUNT(*) n FROM pipeline_jobs WHERE type='ENRICH_MOVIE' AND status='queued'`).get() as any;
    const counter = db.prepare(`SELECT value FROM system_state WHERE key='gen_pilot_count'`).get() as any;
    expect(done.n).toBe(25);
    expect(queued.n).toBe(25);
    expect(JSON.parse(counter.value).count).toBe(25);
  });
  it('14. piloto nao reservado quando nao ha chamada de provedor (circuito, modo seguro, job pronto)', async () => {
    // a) modo seguro: nenhuma linha de contador.
    db.prepare(`INSERT INTO movies(tmdb_id,title,collection_status,enrichment_status) VALUES(81,'A','complete','pending')`).run();
    db.prepare(`INSERT INTO pipeline_jobs(job_key,type,payload_json,status) VALUES('enrich:81:v2','ENRICH_MOVIE','{"tmdb_id":81}','queued')`).run();
    await processJob(makeEnv(db).env, { type: 'ENRICH_MOVIE', key: 'enrich:81:v2', payload: { tmdb_id: 81 } });
    expect(db.prepare(`SELECT COUNT(*) n FROM system_state WHERE key='gen_pilot_count'`).get()).toEqual({ n: 0 });
    // b) circuito aberto: defere sem reservar piloto.
    db.prepare(`INSERT INTO movies(tmdb_id,title,collection_status,enrichment_status) VALUES(82,'B','complete','pending')`).run();
    db.prepare(`INSERT INTO pipeline_jobs(job_key,type,payload_json,status) VALUES('enrich:82:v2','ENRICH_MOVIE','{"tmdb_id":82}','queued')`).run();
    const b = makeEnv(db, { MOVIE_GENERATION_ENABLED: 'true' });
    await b.env.MOOVIBE_LIBRARY.prepare(`INSERT INTO system_state(key,value) VALUES('circuit:generation-xai',?)`).bind(JSON.stringify({ until: new Date(Date.now() + 3600e3).toISOString(), reason: 'RATE_LIMITED' })).run();
    await processJob(b.env, { type: 'ENRICH_MOVIE', key: 'enrich:82:v2', payload: { tmdb_id: 82 } });
    expect(db.prepare(`SELECT COUNT(*) n FROM system_state WHERE key='gen_pilot_count'`).get()).toEqual({ n: 0 });
    // c) job ja pronto: enriquecimento completo nao reserva piloto.
    db.prepare(`INSERT INTO movies(tmdb_id,title,collection_status,enrichment_status) VALUES(83,'C','complete','complete')`).run();
    db.prepare(`INSERT INTO movie_enrichments(movie_id,model,schema_version) VALUES((SELECT id FROM movies WHERE tmdb_id=83),'grok-4-3','style-v2')`).run();
    db.prepare(`INSERT INTO pipeline_jobs(job_key,type,payload_json,status) VALUES('enrich:83:v2','ENRICH_MOVIE','{"tmdb_id":83}','queued')`).run();
    const c = makeEnv(db, { MOVIE_GENERATION_ENABLED: 'true' });
    await processJob(c.env, { type: 'ENRICH_MOVIE', key: 'enrich:83:v2', payload: { tmdb_id: 83 } });
    expect(db.prepare(`SELECT COUNT(*) n FROM system_state WHERE key='gen_pilot_count'`).get()).toEqual({ n: 0 });
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
  it('18. lote concorrente: um job lento nao bloqueia os demais', async () => {
    for (let i = 201; i <= 205; i++) {
      db.prepare(`INSERT INTO movies(tmdb_id,title,overview,collection_status,enrichment_status) VALUES(?,'C',?,'complete','pending')`).run(i, longOverview);
      db.prepare(`INSERT INTO pipeline_jobs(job_key,type,payload_json,status) VALUES(?, 'ENRICH_MOVIE', ?, 'queued')`).run(`enrich:${i}:v2`, JSON.stringify({ tmdb_id: i }));
    }
    const { env } = makeEnv(db, { MOVIE_GENERATION_ENABLED: 'true' });
    const msgs: any[] = [201, 202, 203, 204, 205].map((i) => msg({ type: 'ENRICH_MOVIE', key: `enrich:${i}:v2`, payload: { tmdb_id: i } }));
    await (pipelineWorker as any).queue({ messages: msgs }, env);
    for (const m of msgs) { expect(m.ack).toHaveBeenCalledTimes(1); expect(m.retry).not.toHaveBeenCalled(); }
    expect((db.prepare(`SELECT COUNT(*) n FROM pipeline_jobs WHERE type='ENRICH_MOVIE' AND status='done'`).get() as any).n).toBe(5);
    expect((globalThis as any).__genMaxInflight).toBeGreaterThanOrEqual(2);
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
  it('22. piloto preciso: falha do provedor devolve a reserva; sucesso conta exatamente 1', async () => {
    db.prepare(`INSERT INTO movies(tmdb_id,title,overview,collection_status,enrichment_status) VALUES(911,'P',?,'complete','pending')`).run(longOverview);
    db.prepare(`INSERT INTO pipeline_jobs(job_key,type,payload_json,status) VALUES('enrich:911:v2','ENRICH_MOVIE','{\"tmdb_id\":911}','queued')`).run();
    const { env } = makeEnv(db, { MOVIE_GENERATION_ENABLED: 'true', MOVIE_GENERATION_PILOT_LIMIT: '5' });
    (globalThis as any).__genMock = { failNext: 1 };
    const m1: any = msg({ type: 'ENRICH_MOVIE', key: 'enrich:911:v2', payload: { tmdb_id: 911 } });
    await (pipelineWorker as any).queue({ messages: [m1] }, env);
    expect(m1.retry).toHaveBeenCalledTimes(1);
    // Sem devolucao: a tentativa admitida conta no teto mesmo falhando.
    const counter1: any = db.prepare(`SELECT value FROM system_state WHERE key='gen_pilot_count'`).get();
    expect(JSON.parse(counter1.value)).toMatchObject({ count: 1, attempts: 1, success: 0, failed: 1 });
    expect(db.prepare(`SELECT status,attempts FROM pipeline_jobs WHERE job_key='enrich:911:v2'`).get()).toMatchObject({ status: 'queued', attempts: 1 });
    db.prepare(`DELETE FROM system_state WHERE key='circuit:generation-xai'`).run();
    db.prepare(`UPDATE pipeline_jobs SET available_at=CURRENT_TIMESTAMP WHERE job_key='enrich:911:v2'`).run();
    const m2: any = msg({ type: 'ENRICH_MOVIE', key: 'enrich:911:v2', payload: { tmdb_id: 911 } });
    await (pipelineWorker as any).queue({ messages: [m2] }, env);
    expect(m2.ack).toHaveBeenCalledTimes(1);
    const counter2: any = db.prepare(`SELECT value FROM system_state WHERE key='gen_pilot_count'`).get();
    expect(JSON.parse(counter2.value)).toMatchObject({ count: 2, attempts: 2, success: 1, failed: 1 });
    expect(db.prepare(`SELECT status FROM pipeline_jobs WHERE job_key='enrich:911:v2'`).get()).toEqual({ status: 'done' });
    const full: any = await providerStatusFull(env);
    expect(full.generation).toMatchObject({ pilot_used_today: 2, pilot_attempts_today: 2, pilot_success_today: 1, pilot_failed_today: 1 });
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
    const counter: any = db.prepare(`SELECT value FROM system_state WHERE key='gen_pilot_count'`).get();
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
    // RECENTES (<5min): o outbox ainda nao os alcancou (threshold 5min), e o
    // backlog NAO pode consumi-los — prova que queued nao bloqueia orcamento.
    for (let i = 3001; i <= 3008; i++) {
      db.prepare(`INSERT INTO movies(tmdb_id,title,collection_status,enrichment_status,updated_at) VALUES(?,'Q','complete','pending',datetime('now','-2 day'))`).run(i);
      db.prepare(`INSERT INTO pipeline_jobs(job_key,type,payload_json,status,available_at,updated_at) VALUES(?,'ENRICH_MOVIE',?,'queued',CURRENT_TIMESTAMP,datetime('now','-1 minute'))`).run(`enrich:${i}:v2`, JSON.stringify({ tmdb_id: i }));
    }
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
    db.prepare(`UPDATE pipeline_jobs SET updated_at=datetime('now','-10 minutes') WHERE job_key LIKE 'enrich:30%'`).run();
    const before = sent.length;
    await schedule(env);
    const fresh = sent.slice(before).filter((s: any) => s.type === 'ENRICH_MOVIE').map((s: any) => s.key);
    expect(fresh.filter((k: string) => Number(k.split(':')[1]) <= 3008)).toHaveLength(8);
    expect(new Set(sent.filter((s: any) => s.type === 'ENRICH_MOVIE').map((s: any) => s.key)).size)
      .toBe(sent.filter((s: any) => s.type === 'ENRICH_MOVIE').length);
  });
});

