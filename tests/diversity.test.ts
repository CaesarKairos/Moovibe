import {describe,expect,it,vi} from 'vitest';
import fs from 'node:fs';
import {applyRecommendationHistory,GLOBAL_HISTORY_LIMIT,GLOBAL_REPEAT_PENALTY,musicHistoryKey,readRecommendationHistory,SPECIFIC_HISTORY_LIMIT} from '../functions/_lib/recommendation-history.js';
import {SCORE_WEIGHTS,validateCuration} from '../functions/_lib/recommender.js';

const ranked=(count=30):any[]=>Array.from({length:count},(_,index)=>({tmdb_id:index+1,title:`Movie ${index+1}`,deterministic_score:1-index*.01}));
const apply=(movies:any[],history:any={})=>applyRecommendationHistory(movies,history as never) as any;

describe('canonical recommendation history identity',()=>{
  it('uses the same identity for equivalent provider records joined to one song row',async()=>{expect(await musicHistoryKey([{song_id:42,provider:'spotify',provider_id:'s'}])).toBe(await musicHistoryKey([{song_id:42,provider:'lrclib',provider_id:'l'}]));});
  it('keeps distinct recordings and text titles separate',async()=>{expect(await musicHistoryKey([{song_id:1,title:'Same',artist:'A'}])).not.toBe(await musicHistoryKey([{song_id:2,title:'Same',artist:'B'}]));});
  it('normalizes combination order but separates a solo song',async()=>{const a={song_id:1},b={song_id:2};expect(await musicHistoryKey([a,b])).toBe(await musicHistoryKey([b,a]));expect(await musicHistoryKey([a])).not.toBe(await musicHistoryKey([a,b]));});
});

describe('historical diversity policy',()=>{
  it('keeps normal ranking without history',()=>expect(apply(ranked()).ranked.map((x:any)=>x.tmdb_id)).toEqual(ranked().map(x=>x.tmdb_id)));
  it('strongly excludes the last ten specific primary ids',()=>{const result=apply(ranked(),{specific:[1,2,3,4,5,6,7,8,9,10]});expect(result.ranked.slice(0,3).map((x:any)=>x.tmdb_id)).toEqual([11,12,13]);expect(result.excluded_count).toBe(10);});
  it('lets a movie return after it leaves the rotating window',()=>{const result=apply(ranked(),{specific:[2,3,4,5,6,7,8,9,10,11]});expect(result.ranked[0].tmdb_id).toBe(1);});
  it('uses tmdb ids independently of translated titles',()=>{const movies:any[]=[{tmdb_id:7,title:'Alien',deterministic_score:.9},{tmdb_id:8,title:'O Oitavo Passageiro',deterministic_score:.8},{tmdb_id:9,title:'Outro',deterministic_score:.7},{tmdb_id:10,title:'Mais um',deterministic_score:.6}];expect(apply(movies,{specific:[7]}).ranked.map((x:any)=>x.tmdb_id)).toEqual([8,9,10]);});
  it('softly penalizes but never excludes globally recent films',()=>{const movies=[{tmdb_id:1,deterministic_score:.94},{tmdb_id:2,deterministic_score:.93},{tmdb_id:3,deterministic_score:.8}];const result=apply(movies,{global:[1]});expect(result.ranked.map((x:any)=>x.tmdb_id)).toEqual([2,1,3]);expect(result.ranked.find((x:any)=>x.tmdb_id===1)?.history_penalty).toBe(GLOBAL_REPEAT_PENALTY);expect(result.ranked).toHaveLength(3);});
  it('allows sufficiently stronger relevance to overcome the global penalty',()=>{const movies=[{tmdb_id:1,deterministic_score:.97},{tmdb_id:2,deterministic_score:.93},{tmdb_id:3,deterministic_score:.8}];expect(apply(movies,{global:[1]}).ranked[0].tmdb_id).toBe(1);});
  it('relaxes oldest specific exclusions first and avoids the latest primary',()=>{const result=apply(ranked(3),{specific:[1,2,3]});expect(result.relaxed).toBe(true);expect(result.ranked.map((x:any)=>x.tmdb_id)).toEqual([2,3,1]);expect(result.forbidden_primary_ids.has(1)).toBe(true);});
  it('does not mutate base scores or matching weights',()=>{const movies=ranked(3),before=movies.map(x=>x.deterministic_score);apply(movies,{global:[1,2]});expect(movies.map(x=>x.deterministic_score)).toEqual(before);expect(SCORE_WEIGHTS).toEqual({numericVibe:.5,semantic:.35,concepts:.1,quality:.05});});
});

describe('history persistence queries',()=>{
  it('reads bounded indexed history and retains ten specific plus twenty global distinct ids',async()=>{const calls:any[]=[];const db={prepare:(sql:string)=>({bind:(...binds:any[])=>({all:async()=>{calls.push({sql,binds});const count=sql.includes('music_key=?')?15:30;return {results:Array.from({length:count},(_,i)=>({primary_tmdb_id:i+1}))};}})})};const result=await readRecommendationHistory(db as any,'music:key');expect(result.specific).toHaveLength(SPECIFIC_HISTORY_LIMIT);expect(result.global).toHaveLength(GLOBAL_HISTORY_LIMIT);expect(calls.every(call=>call.sql.includes('ORDER BY created_at DESC LIMIT ?'))).toBe(true);expect(calls[0].sql).toContain('music_key=?');});
  it('degrades safely when history cannot be read',async()=>{const warn=vi.spyOn(console,'warn').mockImplementation(()=>{});const db={prepare:()=>({bind:()=>({all:async()=>{throw Error('D1 unavailable')}})})};expect(await readRecommendationHistory(db as any,'x')).toMatchObject({specific:[],global:[],available:false,error_code:'D1_HISTORY_READ_FAILED'});warn.mockRestore();});
});

describe('curation and cache safety',()=>{
  const candidates=[1,2,3,4].map(tmdb_id=>({tmdb_id}));
  it('rejects a forbidden primary and accepts distinct eligible alternatives',()=>{expect(()=>validateCuration({primary_tmdb_id:1,alternative_tmdb_ids:[2,3]},candidates,[1])).toThrow(/recently recommended/);expect(validateCuration({primary_tmdb_id:2,alternative_tmdb_ids:[3,4]},candidates,[1]).primary_tmdb_id).toBe(2);});
  it('still rejects invented and duplicated ids',()=>{expect(()=>validateCuration({primary_tmdb_id:9,alternative_tmdb_ids:[2,3]},candidates)).toThrow(/outside/);expect(()=>validateCuration({primary_tmdb_id:2,alternative_tmdb_ids:[2,3]},candidates)).toThrow(/distinct/);});
  it('contains no final recommendation cache, shuffle, random ranking, or new UI control',()=>{const backend=fs.readFileSync('functions/recommend.js','utf8')+fs.readFileSync('functions/_lib/recommendation-history.js','utf8');const frontend=fs.readFileSync('js/script.js','utf8')+fs.readFileSync('index.html','utf8');expect(backend).not.toContain('cachedRecommendation');expect(backend).not.toContain('finalCacheKey');expect(backend).not.toMatch(/shuffle|Math\.random/);expect(frontend).not.toMatch(/OUTRA INTERPRETAÇÃO|ENCONTRE OUTRO FILME|RECOMENDAR NOVAMENTE/i);});
  it('uses an incremental indexed migration without a historical backfill',()=>{const sql=fs.readFileSync('migrations/0006_recommendation_diversity.sql','utf8');expect(sql).toContain('ADD COLUMN music_key');expect(sql).toContain('idx_recommendations_music_history');expect(sql).not.toMatch(/UPDATE|INSERT|DELETE/i);});
});
