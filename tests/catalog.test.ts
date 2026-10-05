import {beforeEach,describe,expect,it,vi} from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';

const {generateJson,embed}=vi.hoisted(()=>({generateJson:vi.fn(),embed:vi.fn()}));
vi.mock('../functions/_lib/gemini.js',()=>({
  RetryableError:class RetryableError extends Error{retryAfter:number;constructor(message:string,retryAfter=0){super(message);this.retryAfter=retryAfter;}},
  GeminiClient:class{constructor(_key?:string){}async generateJson(...args:any[]){return generateJson(...args);}async embed(...args:any[]){return embed(...args);}}
}));

import {D1_ID_CHUNK_SIZE,recommendFromCatalog} from '../functions/_lib/catalog.js';

class Statement {
  values:any[]=[];
  constructor(private db:Database.Database,private sql:string){}
  bind(...values:any[]){this.values=values;return this;}
  async run(){const r=this.db.prepare(this.sql).run(...this.values);return {meta:{changes:r.changes}};}
  async all<T>(){return {results:this.db.prepare(this.sql).all(...this.values) as T[]};}
  async first<T>(){return this.db.prepare(this.sql).get(...this.values) as T|null;}
}

const profileData={moods:['melancholic'],themes:['memory'],atmosphere:['dreamlike'],pace:'slow',emotional_valence:.3,energy:.4,intimacy:.8,surrealism:.4,darkness:.5,humor:.1,romanticism:.4,narrative_density:.6,melancholy_level:.8,tension_level:.3,confidence:.9};
const invalidCuration={primary_tmdb_id:999999,alternative_tmdb_ids:[999998,999997],justification:'external invention',vibe_title:'T',tags:['a','b','c','d'],alternative_calls:['x','y']};
const validProfile=()=>({model:'m',data:profileData});

const makeEnv=(db:Database.Database)=>{
  const MOVIE_VECTORS={query:vi.fn(async()=>({matches:[{id:'1',score:.9}]})),upsert:vi.fn()};
  const env:any={MOOVIBE_LIBRARY:{prepare:(sql:string)=>new Statement(db,sql),batch:async(xs:Statement[])=>Promise.all(xs.map(x=>x.run()))},MOVIE_VECTORS,GEMINI_API_KEY:'x',EMBEDDING_MODEL:'gemini-embedding-2',EMBEDDING_DIMENSIONS:'768',EMBEDDING_SCHEMA_VERSION:'movie-v1'};
  return {env,MOVIE_VECTORS};
};

const seedMovies=(db:Database.Database,count=5,start=1)=>{
  const movie=db.prepare(`INSERT INTO movies(tmdb_id,title,overview,release_year,original_language,popularity,vote_average,vote_count,poster_path,collection_status) VALUES(?,?,?,?,'en',5,7,50,'/p.jpg','complete')`);
  const enrichment=db.prepare(`INSERT INTO movie_enrichments(movie_id,moods_json,themes_json,atmosphere_json,visual_style_json,pace,emotional_valence,energy,intimacy,surrealism,darkness,humor,romanticism,narrative_density,melancholy_level,tension_level,confidence,model,schema_version) VALUES(?,'["melancholic"]','["memory"]','["dreamlike"]','["natural"]','slow',.3,.4,.8,.4,.5,.1,.4,.6,.8,.3,.9,'m','movie-v1')`);
  for(let i=start;i<start+count;i++){
    const overview=i===1?'X'.repeat(2000):`Story ${i}`;
    movie.run(i,`Film ${i}`,overview,2000+i);
    const row=db.prepare(`SELECT id FROM movies WHERE tmdb_id=?`).get(i) as any;
    enrichment.run(row.id);
  }
};

let db:Database.Database;
beforeEach(()=>{
  db=new Database(':memory:');
  for(const file of fs.readdirSync('migrations').filter(x=>x.endsWith('.sql')).sort())db.exec(fs.readFileSync(`migrations/${file}`,'utf8'));
  seedMovies(db,5);
  generateJson.mockReset(); embed.mockReset();
  embed.mockResolvedValue(Array(768).fill(0.01));
  generateJson.mockImplementation(async({schema}:any)=>{
    if(schema?.properties?.primary_tmdb_id) return {model:'m',data:invalidCuration};
    return validProfile();
  });
});

describe('hybrid recommendation flow',()=>{
  it('loads a 200-id hybrid union in D1-safe chunks and keeps a 100-film shortlist',async()=>{
    seedMovies(db,195,6);
    const {env,MOVIE_VECTORS}=makeEnv(db);
    MOVIE_VECTORS.query.mockResolvedValueOnce({matches:Array.from({length:100},(_,i)=>({id:String(101+i),score:1}))});
    const loadChunkSizes:number[]=[];
    const prepare=env.MOOVIBE_LIBRARY.prepare;
    env.MOOVIBE_LIBRARY.prepare=(sql:string)=>{
      const statement=prepare(sql);
      if(sql.includes('FROM movies m LEFT JOIN movie_enrichments e')&&sql.includes('WHERE m.tmdb_id IN')) {
        const bind=statement.bind.bind(statement);
        statement.bind=(...values:any[])=>{
          if(values.length>100)throw new Error(`too many SQL variables: ${values.length}`);
          loadChunkSizes.push(values.length);
          return bind(...values);
        };
      }
      return statement;
    };
    const result=await recommendFromCatalog({env,songs:[{title:'A',artist:'X'}],lyrics:'l',context:'',lang:'en'});
    expect(result.diagnostics.union_count).toBe(200);
    expect(loadChunkSizes).toEqual([D1_ID_CHUNK_SIZE,D1_ID_CHUNK_SIZE,20]);
    expect(result.candidate_count).toBe(100);
    expect(result.candidate_ids).toContain(101);
    expect(result.candidate_ids).toContain(200);
  });
  it('queries 100 Vectorize candidates without full metadata or vector values',async()=>{
    const {env,MOVIE_VECTORS}=makeEnv(db);
    await recommendFromCatalog({env,songs:[{title:'A',artist:'X'}],lyrics:'l',context:'',lang:'en'});
    expect(MOVIE_VECTORS.query).toHaveBeenCalledWith(expect.any(Array),{
      topK:100,
      returnValues:false,
      returnMetadata:'indexed'
    });
  });
  it('restricts Gemini to the candidate set and falls back deterministically on an external id',async()=>{
    const {env}=makeEnv(db);
    const result=await recommendFromCatalog({env,songs:[{title:'A',artist:'X'}],lyrics:'l',context:'',lang:'en'});
    // All ids come from the catalog, never invented.
    expect(result.candidate_ids.every(id=>id>=1&&id<=5)).toBe(true);
    // Gemini proposed 999999 (outside the set) → deterministic fallback.
    expect(result.primary.tmdb_id).toBe(result.candidate_ids[0]);
    expect(result.alternatives.map((a:any)=>a.tmdb_id)).toEqual(result.candidate_ids.slice(1,3));
    expect(result.candidate_ids.length).toBeLessThanOrEqual(100);
    expect(result.diagnostics.final_count).toBe(result.candidate_count);
  });
  it('works with one, two and three songs',async()=>{
    const {env}=makeEnv(db);
    for(const songs of [[{title:'A',artist:'X'}],[{title:'A',artist:'X'},{title:'B',artist:'Y'}],[{title:'A',artist:'X'},{title:'B',artist:'Y'},{title:'C',artist:'Z'}]]){
      const result=await recommendFromCatalog({env,songs,lyrics:'l',context:'',lang:'en'});
      expect(result.primary).toBeDefined();
      expect(result.alternatives).toHaveLength(2);
      expect(result.candidate_count).toBeGreaterThanOrEqual(3);
      expect(result.profile.moods).toEqual(profileData.moods);
    }
  });
  it('lets an enriched movie without embedding join via the numeric channel',async()=>{
    const {env,MOVIE_VECTORS}=makeEnv(db);
    MOVIE_VECTORS.query.mockResolvedValueOnce({matches:[{id:'1',score:.9}]});
    const result=await recommendFromCatalog({env,songs:[{title:'A',artist:'X'}],lyrics:'l',context:'',lang:'en'});
    expect(result.diagnostics.semantic_count).toBe(1);
    expect(result.diagnostics.numeric_count).toBe(5);   // all enriched+complete movies compete numerically
    expect(result.diagnostics.union_count).toBeGreaterThanOrEqual(5);
    expect(result.candidate_ids).toContain(2);          // movie 2 has no embedding yet
    expect(result.diagnostics.top[0].components).toHaveProperty('numeric');
    expect(typeof result.diagnostics.top[0].components.numeric).toBe('number');
    expect(typeof result.diagnostics.top[0].components.final).toBe('number');
  });
  it('sends a compact payload with truncated overviews and score signals',async()=>{
    const {env}=makeEnv(db);
    const result=await recommendFromCatalog({env,songs:[{title:'A',artist:'X'}],lyrics:'l',context:'',lang:'en'});
    const curationCall=generateJson.mock.calls.find(c=>c[0]?.schema?.properties?.primary_tmdb_id)!;
    const prompt=curationCall[0].prompt as string;
    expect(prompt).not.toContain('X'.repeat(400));  // overview capped at ~300 chars
    expect(prompt).toContain('X'.repeat(250));
    expect(prompt).toContain('numeric_vibe_score');
    expect(prompt).toContain('final_score');
    expect(prompt).not.toContain('"final_score":null');
    expect(prompt).toContain('Allowed candidates');
    expect(prompt.length).toBeLessThan(60000);
    expect(result.diagnostics.semantic_count+result.diagnostics.numeric_count).toBeGreaterThan(0);
  });
  it('accepts a valid curation whose ids are inside the generated set',async()=>{
    const {env}=makeEnv(db);
    const first=await recommendFromCatalog({env,songs:[{title:'A',artist:'X'}],lyrics:'l',context:'',lang:'en'});
    const chosen=[first.candidate_ids[3],first.candidate_ids[1],first.candidate_ids[2]];
    generateJson.mockImplementation(async({schema}:any)=>{
      if(schema?.properties?.primary_tmdb_id) return {model:'m',data:{primary_tmdb_id:chosen[0],alternative_tmdb_ids:[chosen[1],chosen[2]],justification:'fit',vibe_title:'V',tags:['a','b','c','d'],alternative_calls:['x','y']}};
      return validProfile();
    });
    const second=await recommendFromCatalog({env,songs:[{title:'A',artist:'X'}],lyrics:'l',context:'',lang:'en'});
    expect(second.curation.primary_tmdb_id).toBe(chosen[0]);
    expect(second.primary.tmdb_id).toBe(chosen[0]);
    expect(second.alternatives.map((a:any)=>a.tmdb_id)).toEqual([chosen[1],chosen[2]]);
  });
});
