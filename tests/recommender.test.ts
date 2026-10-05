import { describe,it,expect } from 'vitest';
import fs from 'node:fs';
import { buildMovieDocument,diversify,recommendationCacheKey,rerank,validateCuration,CANDIDATE_LIMIT,NUMERIC_TOP_K,SCORE_WEIGHTS,SEMANTIC_TOP_K,VIBE_DIMENSIONS,dimensionSimilarity,numericVibeSimilarity,scoreCandidate,mergeCandidateChannels,numericCandidateSql } from '../functions/_lib/recommender.js';
import { discoveryQueries } from '../workers/pipeline/src/queries';

const movie=(id:number,extra:any={})=>({tmdb_id:id,title:`Movie ${id}`,overview:'Story',release_year:2000+id,genres:['Drama'],countries:['Brazil'],languages:['Portuguese'],keywords:['memory'],director:`Director ${id}`,vector_score:.9-id*.01,enrichment:{moods:['melancholic'],themes:['memory'],atmosphere:['dreamlike'],pace:'slow',emotional_valence:.3,energy:.4,intimacy:.8,surrealism:.4,darkness:.5,humor:.1,romanticism:.4,narrative_density:.6,melancholy_level:.8,tension_level:.3,confidence:.9},...extra});
const profile={moods:['melancholic'],themes:['memory'],atmosphere:['dreamlike'],emotional_valence:.3,energy:.4,intimacy:.8,surrealism:.4,darkness:.5,humor:.1,romanticism:.4,narrative_density:.6,melancholy_level:.8,tension_level:.3};

describe('semantic document',()=>it('is deterministic and rich',()=>{const a=buildMovieDocument(movie(1));expect(a).toBe(buildMovieDocument(movie(1)));expect(a).toContain('Themes: memory');expect(a).toContain('Emotional dimensions');}));
describe('candidate safety',()=>{
  it('accepts only candidate IDs',()=>expect(validateCuration({primary_tmdb_id:1,alternative_tmdb_ids:[2,3]},[movie(1),movie(2),movie(3)])).toBeTruthy());
  it('rejects an invented movie',()=>expect(()=>validateCuration({primary_tmdb_id:999,alternative_tmdb_ids:[2,3]},[movie(1),movie(2),movie(3)])).toThrow(/outside candidate/));
});
describe('ranking and diversity',()=>it('keeps affinity while penalizing a homogeneous slate',()=>{const ranked=rerank([movie(1),movie(2),movie(3,{countries:['Japan'],genres:['Animation'],release_year:1988})],profile);const slate=diversify(ranked,3);expect(slate).toHaveLength(3);expect(slate.every(x=>typeof x.deterministic_score==='number')).toBe(true);}));
describe('cache',()=>it('distinguishes one, two and three song combinations and order',()=>{const a={title:'A',artist:'X'},b={title:'B',artist:'Y'},c={title:'C',artist:'Z'};const keys=[recommendationCacheKey([a]),recommendationCacheKey([a,b]),recommendationCacheKey([a,b,c]),recommendationCacheKey([b,a])];expect(new Set(keys).size).toBe(4);}));
describe('discovery strategy',()=>it('preserves overlapping country, genre, decade and sort memberships without duplicate query ids',()=>{const queries=discoveryQueries();expect(queries.length).toBeGreaterThan(1000);expect(new Set(queries.map(q=>q.id)).size).toBe(queries.length);expect(queries.some(q=>q.id.includes('country-BR-genre-18'))).toBe(true);expect(queries.some(q=>q.id.includes('genre-18-1970'))).toBe(true);}));

describe('numeric vibe similarity',()=>{
  it('is exactly 1 when movie and music dimensions match',()=>{
    expect(dimensionSimilarity(.5,.5)).toBe(1);
    expect(dimensionSimilarity(0,0)).toBe(1);
    expect(numericVibeSimilarity(profile,profile)).toBe(1);
  });
  it('approaches 0 for opposite extremes',()=>{
    expect(dimensionSimilarity(0,1)).toBe(0);
    expect(dimensionSimilarity(1,0)).toBe(0);
    const zero=Object.fromEntries(VIBE_DIMENSIONS.map(d=>[d,0]));
    const one=Object.fromEntries(VIBE_DIMENSIONS.map(d=>[d,1]));
    expect(numericVibeSimilarity(zero,one)).toBe(0);
  });
  it('works with a plain music profile dimension object',()=>{
    const songLike={emotional_valence:.3,energy:.4,intimacy:.8,surrealism:.4,darkness:.5,humor:.1,romanticism:.4,narrative_density:.6,melancholy_level:.8,tension_level:.3};
    expect(numericVibeSimilarity(songLike,profile)).toBe(1);
  });
});

describe('composite score',()=>{
  it('applies the documented weights when every channel is present',()=>{
    const candidate=movie(1,{vector_score:.6});
    const quality=.5*.9+.5*.75; // confidence .9, dataQuality 3/4 (no poster_path in fixture)
    const expected=SCORE_WEIGHTS.numericVibe*1+SCORE_WEIGHTS.semantic*.6+SCORE_WEIGHTS.concepts*1+SCORE_WEIGHTS.quality*quality;
    expect(scoreCandidate(candidate,profile)).toBeCloseTo(expected,6);
    expect(candidate.component_scores.numeric).toBe(1);
    expect(candidate.component_scores.semantic).toBeCloseTo(.6,6);
    expect(candidate.component_scores.concepts).toBe(1);
  });
  it('redistributes weight so a numeric-only candidate competes without an embedding',()=>{
    const candidate=movie(1,{vector_score:undefined});
    const quality=.5*.9+.5*.75;
    const expected=(SCORE_WEIGHTS.numericVibe*1+SCORE_WEIGHTS.concepts*1+SCORE_WEIGHTS.quality*quality)/(1-SCORE_WEIGHTS.semantic);
    expect(scoreCandidate(candidate,profile)).toBeCloseTo(expected,6);
    expect(candidate.component_scores.semantic).toBeNull();
  });
  it('never lets a candidate without enrichment reach an excellent score',()=>{
    const enriched=movie(1,{vector_score:.95});
    const bare={tmdb_id:9,title:'Bare',overview:'Story',release_year:2001,director:'D',vector_score:.95,enrichment:{}};
    const bareScore=scoreCandidate(bare,profile);
    const enrichedScore=scoreCandidate(enriched,profile);
    expect(bareScore).toBeLessThan(enrichedScore);
    expect(bareScore).toBeLessThan(.75);
  });
});

describe('hybrid candidate union',()=>{
  it('deduplicates semantic and numeric hits and keeps both signals',()=>{
    const merged=mergeCandidateChannels([{id:'1',score:.9},{id:'2',score:.8}],[{tmdb_id:2,numeric_score:.95},{tmdb_id:3,numeric_score:.7}]);
    expect(merged.map(m=>m.tmdb_id).sort((a,b)=>a-b)).toEqual([1,2,3]);
    const both=merged.find(m=>m.tmdb_id===2)!;
    expect(both.vector_score).toBeCloseTo(.8,6);
    expect(both.numeric_score).toBeCloseTo(.95,6);
    expect(both.channels).toEqual(['semantic','numeric']);
    const numericOnly=merged.find(m=>m.tmdb_id===3)!;
    expect(numericOnly.vector_score).toBeUndefined();
    expect(numericOnly.channels).toEqual(['numeric']);
    const semanticOnly=merged.find(m=>m.tmdb_id===1)!;
    expect(semanticOnly.numeric_score).toBeUndefined();
    expect(semanticOnly.channels).toEqual(['semantic']);
  });
  it('builds a deterministic numeric channel query that never requires embeddings or random ordering',()=>{
    const {sql,binds}=numericCandidateSql(profile);
    expect(sql).toContain('movie_enrichments');
    expect(sql).toContain('ABS(COALESCE(e.darkness,0)-?)');
    expect(sql).toContain('collection_status');
    expect(sql).not.toMatch(/random\s*\(/i);
    expect(sql).toContain('ORDER BY numeric_score DESC');
    expect(binds).toHaveLength(VIBE_DIMENSIONS.length+1);
    expect(binds[0]).toBeCloseTo(.3,6);
    expect(binds[binds.length-1]).toBe(NUMERIC_TOP_K);
  });
});

describe('final shortlist',()=>{
  it('can reach 100 candidates instead of collapsing to 12',()=>{
    const many=Array.from({length:150},(_,i)=>movie(i+1));
    expect(CANDIDATE_LIMIT).toBe(100);
    expect(SEMANTIC_TOP_K).toBe(100);
    expect(NUMERIC_TOP_K).toBe(100);
    const slate=diversify(rerank(many,profile),CANDIDATE_LIMIT);
    expect(slate).toHaveLength(100);
    expect(slate.every(x=>typeof x.deterministic_score==='number')).toBe(true);
  });
  it('ranks deterministically without random(): same input, same order',()=>{
    const input=[movie(3),movie(1),movie(4),movie(2)];
    const first=rerank(input,profile).map((x:any)=>x.tmdb_id);
    const second=rerank([...input].reverse(),profile).map((x:any)=>x.tmdb_id);
    expect(first).toEqual(second);
    const source=fs.readFileSync('functions/_lib/recommender.js','utf8')+fs.readFileSync('functions/_lib/catalog.js','utf8');
    expect(source).not.toMatch(/random\s*\(/);
  });
});

describe('curation guard',()=>{
  it('accepts only ids inside a 100-film shortlist',()=>{
    const shortlist=Array.from({length:100},(_,i)=>movie(i+1));
    expect(validateCuration({primary_tmdb_id:50,alternative_tmdb_ids:[51,52]},shortlist)).toBeTruthy();
    expect(()=>validateCuration({primary_tmdb_id:101,alternative_tmdb_ids:[2,3]},shortlist)).toThrow(/outside candidate/);
  });
  it('requires exactly two distinct integer alternatives',()=>{
    expect(()=>validateCuration({primary_tmdb_id:1,alternative_tmdb_ids:[2]},[movie(1),movie(2),movie(3)])).toThrow();
    expect(()=>validateCuration({primary_tmdb_id:1,alternative_tmdb_ids:[1,2]},[movie(1),movie(2),movie(3)])).toThrow();
    expect(()=>validateCuration({primary_tmdb_id:1.5,alternative_tmdb_ids:[2,3]},[movie(1),movie(2),movie(3)])).toThrow();
  });
});

describe('recent release definitions',()=>{
  const recentIds=['newest-global','recent-global-120','recent-global-30','recent-popular-30','upcoming-global-60'];
  it('keeps stable ids and date-free static params so the seed version never churns daily',()=>{
    const queries=discoveryQueries();
    const recent=queries.filter(q=>/^(recent|upcoming|newest)-/.test(q.id));
    expect(recent.map(q=>q.id).sort()).toEqual(recentIds);
    for(const q of recent){
      expect(q.params).toHaveProperty('lane','recent');
      expect(q.params).not.toHaveProperty('primary_release_date.gte');
      expect(q.params).not.toHaveProperty('primary_release_date.lte');
      expect(JSON.stringify(q.params)).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    }
    expect(recent.find(q=>q.id==='recent-global-120')!.params.lookback_days).toBe(120);
    expect(recent.find(q=>q.id==='upcoming-global-60')!.params.upcoming_days).toBe(60);
    // Static definitions are identical across calls regardless of the day,
    // so discoverySeedVersion() cannot change without a code change.
    expect(JSON.stringify(queries)).toBe(JSON.stringify(discoveryQueries()));
  });
});
