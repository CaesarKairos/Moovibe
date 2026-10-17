import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import { COLLECTION_BACKLOG_SQL, EMBEDDING_BACKLOG_SQL, ENRICHMENT_BACKLOG_SQL, MOVIE_BACKLOG_SQL } from '../workers/pipeline/src/job-policy.js';
describe('sql-audit', () => {
  it('compara planos e tempos: legado CTE vs 3 consultas por estagio', () => {
    const db = new Database(':memory:');
    for (const f of fs.readdirSync('migrations').filter((x) => x.endsWith('.sql')).sort()) db.exec(fs.readFileSync(`migrations/${f}`, 'utf8'));
    const ins = db.prepare(`INSERT INTO movies(tmdb_id,title,collection_status,enrichment_status,embedding_status,updated_at) VALUES(?,?,'complete',?,?,'2026-01-01 00:00:00')`);
    for (let i = 1; i <= 3000; i++) ins.run(i, 'F' + i, i % 3 === 0 ? 'error' : 'pending', 'pending');
    const err = db.prepare(`INSERT INTO pipeline_jobs(job_key,type,payload_json,status,available_at) VALUES(?, 'ENRICH_MOVIE', ?, 'error', datetime('now','+1 day'))`);
    for (let i = 1; i <= 1200; i++) err.run(`enrich:${i}:v2`, JSON.stringify({ tmdb_id: i }));
    const plans: Record<string, string> = {};
    const binds: Record<string, any[]> = { legacy: [4, 8, 8, 20], enrich: [32], embed: [32], coll: [16] };
    for (const [k, sql] of Object.entries({ legacy: MOVIE_BACKLOG_SQL, enrich: ENRICHMENT_BACKLOG_SQL, embed: EMBEDDING_BACKLOG_SQL, coll: COLLECTION_BACKLOG_SQL }))
      plans[k] = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...binds[k]).map((r: any) => r.detail).join(' | ');
    console.log(JSON.stringify(plans, null, 1).slice(0, 3000));
    const t0 = Date.now();
    db.prepare(MOVIE_BACKLOG_SQL).all(4, 8, 8, 20);
    const tLegacy = Date.now() - t0;
    const t1 = Date.now();
    db.prepare(ENRICHMENT_BACKLOG_SQL).all(32);
    db.prepare(EMBEDDING_BACKLOG_SQL).all(32);
    db.prepare(COLLECTION_BACKLOG_SQL).all(16);
    const tNew = Date.now() - t1;
    console.log(JSON.stringify({ tLegacyMs: tLegacy, tNewMs: tNew }));
    expect(plans.enrich).toContain('movies');
    expect(tNew).toBeLessThanOrEqual(Math.max(tLegacy, 50) + 200);
  });
  it('backlog usa indices existentes e documenta a limitacao de rows_read', () => {
    const db = new Database(':memory:');
    for (const f of fs.readdirSync('migrations').filter((x) => x.endsWith('.sql')).sort()) db.exec(fs.readFileSync(`migrations/${f}`, 'utf8'));
    const ins = db.prepare(`INSERT INTO movies(tmdb_id,title,collection_status,enrichment_status,embedding_status,updated_at) VALUES(?,?,'complete',?,?,'2026-01-01 00:00:00')`);
    for (let i = 1; i <= 3000; i++) ins.run(i, 'F' + i, i % 3 === 0 ? 'error' : 'pending', 'pending');
    const err = db.prepare(`INSERT INTO pipeline_jobs(job_key,type,payload_json,status,available_at) VALUES(?, 'ENRICH_MOVIE', ?, 'error', datetime('now','+1 day'))`);
    for (let i = 1; i <= 1200; i++) err.run(`enrich:${i}:v2`, JSON.stringify({ tmdb_id: i }));
    // Índices prometidos na migração precisam existir fisicamente.
    const idx = db.prepare(`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='pipeline_jobs'`).all().map((r: any) => r.name);
    expect(idx).toContain('idx_pipeline_jobs_status');
    expect(idx).toContain('idx_pipeline_jobs_recovery');
    // Os planos das 3 consultas por estágio acessam pipeline_jobs por índice
    // (SEARCH ... USING INDEX) em vez de varrer a tabela inteira.
    const binds: Record<string, any[]> = { enrich: [32], embed: [32], coll: [16] };
    for (const [k, sql] of Object.entries({ enrich: ENRICHMENT_BACKLOG_SQL, embed: EMBEDDING_BACKLOG_SQL, coll: COLLECTION_BACKLOG_SQL })) {
      const plan = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...binds[k]).map((r: any) => r.detail).join(' | ');
      expect(plan, k).toContain('pipeline_jobs');
      expect(plan, k).toMatch(/SEARCH .*USING (COVERING )?INDEX \S*pipeline_jobs/i);
    }
    // rows_read: better-sqlite3 não expõe sqlite3_stmt_scanstatus nem o
    // counters do SQLite CLI, então a contagem de linhas lidas por stmt não
    // é mensurável aqui. A validação local é por forma de plano (índice vs
    // scan) + tempo de parede; o counters real (rows_read) fica para
    // inspeção no worker em produção (wrangler tail / console.metrics).
    console.log('rows_read medido via EXPLAIN QUERY PLAN (plano) — contagem real indisponível em better-sqlite3');
  });
});
