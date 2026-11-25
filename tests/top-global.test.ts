import { describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { validateRanking } from '../functions/_lib/top-global-source.js';
import { SNAPSHOT, updateTopGlobal } from '../functions/_lib/top-global.js';
import { onRequestGet } from '../functions/top-global.js';
import { letterboxdUrl, rankingMovement } from '../js/top-global.js';
import { LANGUAGES, TOP_GLOBAL_COPY, TOP_GLOBAL_TITLES } from '../js/i18n/locales.js';

const id = (n:number) => String(n).padStart(22,'0');
function feed(numbers=Array.from({length:50},(_,i)=>i+1), date='2026-01-01') {
  return {action:'import', authorized:true, source:'charts', reference_date:date,
    tracks:numbers.map((n,index)=>({position:index+1,spotify_id:id(n),title:`Track ${n}`,artist:'Artist'}))};
}
function setup() {
  const sqlite = new Database(':memory:');
  sqlite.exec(readFileSync('migrations/0011_top_global.sql','utf8'));
  sqlite.exec('CREATE TABLE movies(tmdb_id INTEGER PRIMARY KEY); INSERT INTO movies VALUES(7),(8)');
  function prepare(sql:string, args:any[] = []) {
    const run = () => ({meta:{changes:sqlite.prepare(sql).run(...args).changes}});
    return { bind:(...next:any[])=>prepare(sql,next), run,
      first:()=>sqlite.prepare(sql).get(...args), all:()=>({results:sqlite.prepare(sql).all(...args)}) };
  }
  const cache = new Map<string,string>();
  const env = {
    MOOVIBE_LIBRARY:{prepare,batch:(statements:ReturnType<typeof prepare>[])=>sqlite.transaction(()=>statements.map(statement=>statement.run()))()},
    MOOVIBE_DB:{put:vi.fn(async (key:string,value:string)=>{cache.set(key,value);}),get:async (key:string)=>JSON.parse(cache.get(key)||'null')},
    TOP_GLOBAL_DAILY_ATTEMPTS:'1',
  };
  const snapshot = () => env.MOOVIBE_DB.get(SNAPSHOT);
  return {sqlite,env,snapshot};
}

describe('Top 50 Global',()=>{
  it('requires explicit authorization, all 50 positions, and valid unique Spotify IDs',()=>{
    expect(()=>validateRanking({...feed(),authorized:false})).toThrow('SOURCE_AUTHORIZATION_REQUIRED');
    expect(()=>validateRanking({...feed(),tracks:[]})).toThrow('EXPECTED_50_TRACKS');
    const input=feed();input.tracks[1].spotify_id=id(1);
    expect(()=>validateRanking(input)).toThrow('INVALID_TRACK');
  });

  it('publishes an initial snapshot, persists associations and tracks reentry without calling AI',async()=>{
    const {sqlite,env,snapshot}=setup();
    await updateTopGlobal(env,feed());
    const initial=await snapshot();
    expect(initial.tracks).toHaveLength(50);
    expect(initial.tracks[0].movement).toBeNull();
    sqlite.prepare('UPDATE top_global_tracks SET tmdb_id=7,movie_json=?,pending=0 WHERE spotify_id=?')
      .run(JSON.stringify({tmdb_id:7,title:'Film'}),id(1));
    const next=[2,1,...Array.from({length:47},(_,i)=>i+3),51];
    await updateTopGlobal(env,feed(next,'2026-01-02'));
    const updated=await snapshot();
    expect(updated.tracks[0].delta).toBe(1);
    expect(updated.tracks[1].movie.tmdb_id).toBe(7);
    expect(updated.tracks[49].movement).toBe('NEW');
    await updateTopGlobal(env,feed(next,'2026-01-02'));
    expect(await snapshot()).toEqual(updated);
    await updateTopGlobal(env,feed(undefined,'2026-01-03'));
    expect((await snapshot()).tracks[49].movement).toBe('RE');
    await expect(updateTopGlobal(env,feed(next,'2026-01-02'))).rejects.toThrow('STALE_RANKING');
    expect((await snapshot()).reference_date).toBe('2026-01-03');
  });

  it('allows duplicate films by choice and resolves conflicts without replacing the first owner',async()=>{
    const {sqlite,env,snapshot}=setup();
    await updateTopGlobal(env,feed());
    await updateTopGlobal(env,{action:'duplicates',allow:true});
    sqlite.exec("UPDATE top_global_tracks SET tmdb_id=8, movie_json='{\"tmdb_id\":8}',pending=0 WHERE position IN (1,2)");
    await updateTopGlobal(env,{action:'regenerate',spotify_id:id(1)});
    expect((await snapshot()).tracks.slice(0,2).map((t:any)=>t.movie.tmdb_id)).toEqual([8,8]);
    await updateTopGlobal(env,{action:'duplicates',allow:false});
    expect((await snapshot()).tracks.slice(0,2).map((t:any)=>t.movie?.tmdb_id)).toEqual([8,undefined]);
    await expect(updateTopGlobal(env,{action:'regenerate_all'})).rejects.toThrow('CONFIRMATION_REQUIRED');
  });

  it('serves the last snapshot from KV during D1 unavailability',async()=>{
    const {env}=setup();
    expect((await onRequestGet({env})).status).toBe(503);
    await updateTopGlobal(env,feed());
    const response=await onRequestGet({env:{MOOVIBE_DB:env.MOOVIBE_DB}});
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({tracks:expect.arrayContaining([expect.objectContaining({position:1})])});
  });

  it('retains partial publication after provider failure and respects pause and daily budget',async()=>{
    const {env,snapshot}=setup();
    const input=feed();
    Object.assign(input.tracks[0],{lrclib_id:'100'});
    Object.assign(input.tracks[1],{lrclib_id:'200'});
    await updateTopGlobal(env,input);
    const fetchMock=vi.fn(async ()=>new Response(null,{status:503}));
    vi.stubGlobal('fetch',fetchMock);
    try {
      await updateTopGlobal(env,{action:'pause'});
      await expect(updateTopGlobal(env,{action:'process'})).rejects.toThrow('PROCESSING_PAUSED');
      await updateTopGlobal(env,{action:'resume'});
      const result=await updateTopGlobal(env,{action:'process'});
      if (!('tracks' in result)) throw Error('Missing processing status');
      expect(result.tracks[0].failure).toBe('LRCLIB_UNAVAILABLE');
      expect((await snapshot()).tracks).toHaveLength(50);
      await expect(updateTopGlobal(env,{action:'process'})).rejects.toThrow('DAILY_BUDGET_UNAVAILABLE');
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {vi.unstubAllGlobals();}
  });

  it('localizes all sections and uses exact Letterboxd IDs and movement direction',()=>{
    expect(Object.keys(TOP_GLOBAL_COPY).sort()).toEqual(Object.keys(LANGUAGES).sort());
    expect(Object.keys(TOP_GLOBAL_TITLES).sort()).toEqual(Object.keys(LANGUAGES).sort());
    expect(TOP_GLOBAL_TITLES['pt-BR']).toBe('TOP 50 MUNDIAL');
    expect(TOP_GLOBAL_TITLES.ja).toBe('世界トップ50');
    expect(letterboxdUrl(123)).toBe('https://letterboxd.com/tmdb/123');
    expect(letterboxdUrl(0)).toBeNull();
    expect(rankingMovement({movement:'change',delta:-2})).toEqual(['↓ 2','down']);
  });
});
