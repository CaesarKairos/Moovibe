import { describe,it,expect } from 'vitest';
import { buildMovieDocument,diversify,recommendationCacheKey,rerank,validateCuration } from '../functions/_lib/recommender.js';
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
