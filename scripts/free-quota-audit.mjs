import Database from 'better-sqlite3';
import path from 'node:path';
// Local SQLite snapshot only. This script has no network or Wrangler dependency.
const file = process.argv[2];
if (!file || /^(https?:|remote:)/i.test(file)) throw new Error('Usage: node scripts/free-quota-audit.mjs <local-sqlite-snapshot>');
const db = new Database(path.resolve(file), { readonly: true, fileMustExist: true });
const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(x=>x.name));
const queries = {
  movies: "SELECT collection_status,enrichment_status,embedding_status,COUNT(*) n FROM movies GROUP BY collection_status,enrichment_status,embedding_status",
  pipeline_jobs: "SELECT type,status,COUNT(*) n FROM pipeline_jobs GROUP BY type,status",
  groq_capacity: "SELECT day,attempts,reserved_tokens,measured,total_tokens,cached_tokens FROM groq_capacity ORDER BY day DESC LIMIT 7"
};
for(const [table,sql] of Object.entries(queries)) {
  if (!tables.has(table)) { console.log(JSON.stringify({table,available:false})); continue; }
  try { console.log(JSON.stringify({table,plan:db.prepare('EXPLAIN QUERY PLAN '+sql).all(),counts:db.prepare(sql).all()})); }
  catch(error) { console.log(JSON.stringify({table,error:error.message})); }
}
console.log(JSON.stringify({scope:'local snapshot; cannot identify Cloudflare alert, account plan, remote usage, or invoice'}));
db.close();
