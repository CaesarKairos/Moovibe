import Database from 'better-sqlite3';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const source=process.env.MOOVIBE_SQLITE_PATH||'moovibe_library.db';
if(!fs.existsSync(source))throw new Error(`SQLite not found: ${source}`);
const remote=process.argv.includes('--remote');
const db=new Database(source,{readonly:true,fileMustExist:true});
const esc=v=>v==null?'NULL':`'${String(v).replaceAll("'","''")}'`;
const num=v=>Number.isFinite(Number(v))?String(Number(v)):'NULL';
const parse=v=>{try{return JSON.parse(v||'[]')}catch{return[]}};
const synthetic=(prefix,value)=>-parseInt(crypto.createHash('sha1').update(`${prefix}:${value}`).digest('hex').slice(0,7),16);
const statements=[];
const limitArg=process.argv.find(x=>x.startsWith('--limit='));
const limit=limitArg?Math.max(1,Number(limitArg.split('=')[1])):null;
const rows=limit?db.prepare('SELECT * FROM movies ORDER BY tmdb_id LIMIT ?').all(limit):db.prepare('SELECT * FROM movies ORDER BY tmdb_id').all();
for(const m of rows){
  statements.push(`INSERT INTO movies(tmdb_id,title,original_title,overview,release_date,release_year,original_language,runtime,popularity,vote_average,vote_count,poster_path,backdrop_path,tagline,tmdb_status,homepage,imdb_id,adult,video,collection_status,enrichment_status,embedding_status,created_at,updated_at) VALUES(${num(m.tmdb_id)},${esc(m.title||m.original_title||`TMDb ${m.tmdb_id}`)},${esc(m.original_title)},${esc(m.overview)},${esc(m.release_date)},${num(m.release_year)},${esc(m.original_language)},${num(m.runtime)},${num(m.popularity)},${num(m.vote_average)},${num(m.vote_count)},${esc(m.poster_path)},${esc(m.backdrop_path)},${esc(m.tagline)},${esc(m.status)},${esc(m.homepage)},${esc(m.imdb_id)},${m.adult?1:0},${m.video?1:0},'complete',${m.estilo?"'complete'":"'pending'"},'pending',COALESCE(${esc(m.created_at)},CURRENT_TIMESTAMP),COALESCE(${esc(m.updated_at)},CURRENT_TIMESTAMP)) ON CONFLICT(tmdb_id) DO UPDATE SET title=excluded.title,overview=excluded.overview,updated_at=excluded.updated_at;`);
  const mid=`(SELECT id FROM movies WHERE tmdb_id=${num(m.tmdb_id)})`;
  for(const name of parse(m.genres)){const id=synthetic('genre',name);statements.push(`INSERT OR IGNORE INTO genres(id,name) VALUES(${id},${esc(name)});`,`INSERT OR IGNORE INTO movie_genres(movie_id,genre_id) VALUES(${mid},${id});`)}
  for(const code of parse(m.origin_country)){const normalized=String(code).slice(0,2).toUpperCase();statements.push(`INSERT OR IGNORE INTO countries(iso_3166_1,name) VALUES(${esc(normalized)},${esc(normalized)});`,`INSERT OR IGNORE INTO movie_countries(movie_id,country_code) VALUES(${mid},${esc(normalized)});`)}
  if(m.original_language){const code=String(m.original_language).slice(0,2);statements.push(`INSERT OR IGNORE INTO languages(iso_639_1,name) VALUES(${esc(code)},${esc(code)});`,`INSERT OR IGNORE INTO movie_languages(movie_id,language_code) VALUES(${mid},${esc(code)});`)}
  for(const name of parse(m.keywords)){const id=synthetic('keyword',name);statements.push(`INSERT OR IGNORE INTO keywords(id,name) VALUES(${id},${esc(name)});`,`INSERT OR IGNORE INTO movie_keywords(movie_id,keyword_id) VALUES(${mid},${id});`)}
  if(m.director){const id=synthetic('person',m.director);statements.push(`INSERT OR IGNORE INTO people(id,name,known_for_department) VALUES(${id},${esc(m.director)},'Directing');`,`INSERT INTO movie_credits(movie_id,person_id,department,job,character,credit_order) SELECT ${mid},${id},'Directing','Director','',0 WHERE NOT EXISTS (SELECT 1 FROM movie_credits WHERE movie_id=${mid} AND person_id=${id} AND department='Directing' AND job='Director');`)}
  for(const label of parse(m.collected_from)){const qid=`legacy-${crypto.createHash('sha1').update(String(label)).digest('hex').slice(0,16)}`;statements.push(`INSERT OR IGNORE INTO collection_queries(query_id,label,params_json,is_executable,status) VALUES(${esc(qid)},${esc(label)},'{}',0,'imported');`,`INSERT OR IGNORE INTO movie_discovery_sources(movie_id,query_id) VALUES(${mid},${esc(qid)});`)}
  if(m.estilo){const e=typeof m.estilo==='string'?JSON.parse(m.estilo):m.estilo;const level=x=>({low:.2,medium:.5,high:.8}[String(x||'').toLowerCase()]??null);statements.push(`INSERT INTO movie_enrichments(movie_id,moods_json,themes_json,atmosphere_json,visual_style_json,pace,melancholy_level,tension_level,confidence,model,schema_version,provenance_json) VALUES(${mid},${esc(JSON.stringify(e.moods||[]))},${esc(JSON.stringify(e.themes||[]))},${esc(JSON.stringify(e.atmosphere||[]))},${esc(JSON.stringify(e.visual_style||[]))},${esc(e.pace)},${num(level(e.melancholy_level))},${num(level(e.tension_level))},0.6,'legacy-ollama','style-v1','["legacy-sqlite"]') ON CONFLICT(movie_id) DO NOTHING;`)}
}
db.close();
const chunks=[];for(let i=0;i<statements.length;i+=10000){const chunk=statements.slice(i,i+10000).filter(Boolean);if(chunk.length)chunks.push(chunk)}
console.log(`Prepared ${rows.length} movies as ${chunks.length} idempotent batches.`);
const wranglerBin=path.resolve('node_modules/wrangler/bin/wrangler.js');
for(let i=0;i<chunks.length;i++){
  const temp=path.join(os.tmpdir(),`moovibe-d1-bootstrap-${process.pid}-${i}.sql`);
  // D1 manages execution of the file; transaction-control SQL is rejected remotely.
  const transactionControl=/^\s*(?:BEGIN(?:\s+TRANSACTION)?|COMMIT|SAVEPOINT|RELEASE|ROLLBACK)\b/i;
  if(chunks[i].some(statement=>transactionControl.test(statement)))throw new Error(`Batch ${i+1} contains transaction-control SQL`);
  const batch=chunks[i].join('\n');
  fs.writeFileSync(temp,batch);
  console.log(`Importing batch ${i+1}/${chunks.length}...`);
  const args=['d1','execute','MOOVIBE_LIBRARY',remote?'--remote':'--local','--config','workers/pipeline/wrangler.jsonc','--file',temp];
  const r=spawnSync(process.execPath,[wranglerBin,...args],{encoding:'utf8',stdio:'pipe'});
  if(r.error) throw r.error;
  if(r.status!==0){process.stderr.write(r.stderr||r.stdout||'Wrangler failed\n');process.exit(r.status||1);}
  fs.rmSync(temp);
}
console.log(`Imported ${rows.length} movies. Validate with: npx wrangler d1 execute MOOVIBE_LIBRARY ${remote?'--remote':'--local'} --config workers/pipeline/wrangler.jsonc --command "SELECT COUNT(*) FROM movies"`);
