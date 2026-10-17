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
});
