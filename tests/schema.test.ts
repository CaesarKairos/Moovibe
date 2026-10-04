import { describe,it,expect,beforeEach,afterEach } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import { movieToLegacy } from '../functions/_lib/catalog.js';

let db:Database.Database;
beforeEach(()=>{db=new Database(':memory:');db.exec(fs.readFileSync('migrations/0001_library.sql','utf8'));});
afterEach(()=>db.close());

describe('D1 schema idempotency',()=>{
  it('deduplicates movies, discovery memberships, relations and queue jobs',()=>{
    db.prepare(`INSERT INTO movies(tmdb_id,title) VALUES(?,?) ON CONFLICT(tmdb_id) DO UPDATE SET title=excluded.title`).run(10,'A');
    db.prepare(`INSERT INTO movies(tmdb_id,title) VALUES(?,?) ON CONFLICT(tmdb_id) DO UPDATE SET title=excluded.title`).run(10,'A updated');
    const id=(db.prepare('SELECT id FROM movies WHERE tmdb_id=10').get() as any).id;
    db.prepare(`INSERT INTO collection_queries(query_id,label,params_json) VALUES('q','Query','{}')`).run();
    db.prepare(`INSERT OR IGNORE INTO movie_discovery_sources(movie_id,query_id) VALUES(?,?)`).run(id,'q');
    db.prepare(`INSERT OR IGNORE INTO movie_discovery_sources(movie_id,query_id) VALUES(?,?)`).run(id,'q');
    db.prepare(`INSERT INTO pipeline_jobs(job_key,type,payload_json) VALUES('fetch:10','FETCH_MOVIE','{}') ON CONFLICT(job_key) DO NOTHING`).run();
    db.prepare(`INSERT INTO pipeline_jobs(job_key,type,payload_json) VALUES('fetch:10','FETCH_MOVIE','{}') ON CONFLICT(job_key) DO NOTHING`).run();
    expect((db.prepare('SELECT COUNT(*) n FROM movies').get() as any).n).toBe(1);
    expect((db.prepare('SELECT COUNT(*) n FROM movie_discovery_sources').get() as any).n).toBe(1);
    expect((db.prepare('SELECT COUNT(*) n FROM pipeline_jobs').get() as any).n).toBe(1);
  });
  it('preserves multiple genres and countries for one film',()=>{
    db.prepare(`INSERT INTO movies(tmdb_id,title) VALUES(1,'Film')`).run();const id=(db.prepare('SELECT id FROM movies').get() as any).id;
    db.exec(`INSERT INTO genres VALUES(18,'Drama'); INSERT INTO genres VALUES(9648,'Mystery'); INSERT INTO countries VALUES('BR','Brazil'); INSERT INTO countries VALUES('AR','Argentina');`);
    for(const genre of [18,9648])db.prepare('INSERT INTO movie_genres VALUES(?,?)').run(id,genre);
    for(const country of ['BR','AR'])db.prepare('INSERT INTO movie_countries VALUES(?,?)').run(id,country);
    expect((db.prepare('SELECT COUNT(*) n FROM movie_genres').get() as any).n).toBe(2);
    expect((db.prepare('SELECT COUNT(*) n FROM movie_countries').get() as any).n).toBe(2);
  });
});

describe('frontend adapter',()=>it('maps catalog facts to the legacy response fields',()=>{const out=movieToLegacy({tmdb_id:10,title:'Film',original_title:'Original',release_year:1999,overview:'Synopsis',poster_path:'/p.jpg',backdrop_path:'/b.jpg',director:'Director',imdb_id:'tt1'});expect(out).toMatchObject({id_tmdb:10,titulo_pt:'Film',titulo_original:'Original',ano:1999,sinopse:'Synopsis',diretor:'Director',imdb_id:'tt1'});expect(out.poster).toContain('/p.jpg');}));
