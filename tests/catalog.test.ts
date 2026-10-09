import {beforeEach,describe,expect,it,vi} from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';

const {generateJson,embed}=vi.hoisted(()=>({generateJson:vi.fn(),embed:vi.fn()}));
vi.mock('../functions/_lib/gemini.js',()=>({
  RetryableError:class RetryableError extends Error{retryAfter:number;constructor(message:string,retryAfter=0){super(message);this.retryAfter=retryAfter;}},
  GeminiClient:class{constructor(_key?:string){}async generateJson(...args:any[]){return generateJson(...args);}async embed(...args:any[]){return embed(...args);}}
}));

import {buildCuratorSystem,compactCandidate,curationSchema,D1_ID_CHUNK_SIZE,hydrateMoviePresentation,isWeakJustification,loadMovies,recommendFromCatalog,selectBestPoster,selectBestStills} from '../functions/_lib/catalog.js';
import {persistLyricsBestEffort} from '../functions/_lib/song-library.js';

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
  it('requires migration 0005 for compact catalog columns',async()=>{
    const legacy=new Database(':memory:');
    for(const file of fs.readdirSync('migrations').filter(x=>x.endsWith('.sql')&&x<'0005_catalog_efficiency.sql').sort())legacy.exec(fs.readFileSync(`migrations/${file}`,'utf8'));
    const d1={prepare:(sql:string)=>new Statement(legacy,sql)};
    await expect(loadMovies(d1,[1])).rejects.toThrow(/no such column: m\.genres_json/);
  });
  it('retains in-memory lyrics when D1 rejects their persistence',async()=>{const db:any={prepare:()=>({bind(){return this;},async run(){throw new Error('D1_ERROR: row writes quota exceeded');}})};expect(await persistLyricsBestEffort(db,{title:'A',artist:'X',provider:'spotify',provider_id:'track-id'},'x'.repeat(100),'user')).toBeNull();});
  it('keeps recommending when song profile persistence hits the D1 write quota',async()=>{
    const {env}=makeEnv(db);const prepare=env.MOOVIBE_LIBRARY.prepare;
    env.MOOVIBE_LIBRARY.prepare=(sql:string)=>{if(sql.includes('INSERT INTO song_profiles'))return{bind(){return this;},async run(){throw new Error('D1_ERROR: row writes quota exceeded');}};return prepare(sql);};
    const result=await recommendFromCatalog({env,songs:[{title:'A',artist:'X',song_id:99}],lyrics:'lyrics',context:'',lang:'en'});
    expect(result.primary).toBeDefined();expect(result.alternatives).toHaveLength(2);
  });
  it('hydrates only selected movies, caches them, and falls back on TMDb failure',async()=>{
    const cache=new Map<string,string>();const env:any={TMDB_API_KEY:'x',MOOVIBE_DB:{get:vi.fn(async(k:string)=>cache.has(k)?JSON.parse(cache.get(k)!):null),put:vi.fn(async(k:string,v:string)=>cache.set(k,v))}};
    const fetchMock=vi.fn(async()=>new Response(JSON.stringify({runtime:123,tagline:'T',credits:{crew:[{job:'Director',name:'D'}]},external_ids:{imdb_id:'tt1'}}),{status:200}));vi.stubGlobal('fetch',fetchMock);
    const movie:any={tmdb_id:1,title:'Film',director:'Fallback'};expect((await hydrateMoviePresentation(env,movie,'en')).director).toBe('D');expect((await hydrateMoviePresentation(env,movie,'en')).director).toBe('D');expect(fetchMock).toHaveBeenCalledTimes(1);
    fetchMock.mockResolvedValueOnce(new Response('down',{status:503}));const failed=await hydrateMoviePresentation({...env,MOOVIBE_DB:null},{tmdb_id:2,title:'Fallback',director:'Stored'},'en');expect(failed.director).toBe('Stored');vi.unstubAllGlobals();
  });
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
    expect(prompt).not.toContain('X'.repeat(550));  // overview capped at ~520 chars
    expect(prompt).toContain('X'.repeat(450));
    expect(prompt).toContain('numeric_vibe_score');
    expect(prompt).toContain('final_score');
    expect(prompt).not.toContain('"final_score":null');
    expect(prompt).toContain('Allowed candidates');
    expect(prompt.length).toBeLessThan(60000);
    expect(result.diagnostics.semantic_count+result.diagnostics.numeric_count).toBeGreaterThan(0);
  });
  it('keeps a valid justification that discusses only the primary film',async()=>{
    const {env}=makeEnv(db);
    const valid={primary_tmdb_id:1,alternative_tmdb_ids:[2,3],justification:'Film 1 traduz a melancolia e a atmosfera onírica das músicas em uma experiência cinematográfica íntima.',vibe_title:'V',tags:['a','b','c','d'],alternative_calls:['Film 2 para outra textura','Film 3 para outra energia']};
    generateJson.mockImplementation(async({schema}:any)=>schema?.properties?.primary_tmdb_id?{model:'m',data:valid}:validProfile());
    const result=await recommendFromCatalog({env,songs:[{title:'A',artist:'X'}],lyrics:'l',context:'',lang:'pt'});
    expect(result.curation).toMatchObject({primary_tmdb_id:1,alternative_tmdb_ids:[2,3],justification:valid.justification});
  });
  it('replaces only a justification that names an alternative and preserves all chosen ids',async()=>{
    const {env}=makeEnv(db);
    const contaminated={primary_tmdb_id:1,alternative_tmdb_ids:[2,3],justification:'Film 1 combina com a música; como alternativas, fIlM—2 e Film 3 seguem a mesma vibe.',vibe_title:'V',tags:['a','b','c','d'],alternative_calls:['Film 2 para outra textura','Film 3 para outra energia']};
    generateJson.mockImplementation(async({schema}:any)=>schema?.properties?.primary_tmdb_id?{model:'m',data:contaminated}:validProfile());
    const result=await recommendFromCatalog({env,songs:[{title:'A',artist:'X'}],lyrics:'l',context:'',lang:'pt'});
    expect(result.curation.primary_tmdb_id).toBe(1);
    expect(result.curation.alternative_tmdb_ids).toEqual([2,3]);
    expect(result.curation.justification).not.toBe(contaminated.justification);
    expect(result.curation.justification.toLowerCase()).not.toContain('film 2');
    expect(result.curation.justification.toLowerCase()).not.toContain('film 3');
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
  it('hydrates stills only for the primary selected movie',async()=>{
    const {env}=makeEnv(db);env.TMDB_API_KEY='tmdb';
    const cache=new Map<string,string>();env.MOOVIBE_DB={get:async(k:string)=>cache.has(k)?JSON.parse(cache.get(k)!):null,put:async(k:string,v:string)=>cache.set(k,v)};
    generateJson.mockImplementation(async({schema}:any)=>schema?.properties?.primary_tmdb_id?{model:'m',data:{primary_tmdb_id:1,alternative_tmdb_ids:[2,3],justification:'fit',vibe_title:'V',tags:['a','b','c','d'],alternative_calls:['x','y']}}:validProfile());
    const fetchMock=vi.fn(async(input:RequestInfo|URL)=>{
      const url=new URL(String(input));
      if(url.pathname.endsWith('/images'))return new Response(JSON.stringify({posters:[],backdrops:[{file_path:'/still.jpg',width:1920,height:1080}]}));
      return new Response(JSON.stringify({title:'Film',overview:'Story',credits:{crew:[]},external_ids:{},images:{posters:[{file_path:'/poster.jpg',iso_639_1:'en'}]}}));
    });vi.stubGlobal('fetch',fetchMock);
    const result=await recommendFromCatalog({env,songs:[{title:'A',artist:'X'}],lyrics:'l',context:'',lang:'en'});
    expect(result.primary.stills).toEqual(['/still.jpg']);expect(result.alternatives.every((movie:any)=>movie.stills.length===0)).toBe(true);
    const urls=fetchMock.mock.calls.map(call=>new URL(String(call[0])));
    expect(urls.filter(url=>url.pathname.endsWith('/images'))).toHaveLength(1);
    expect(urls.filter(url=>url.searchParams.get('append_to_response')?.includes('images'))).toHaveLength(2);
    vi.unstubAllGlobals();
  });
});

describe('TMDb image policy',()=>{
  const poster=(file_path:string,iso_639_1:string|null,vote_average=5,vote_count=1,width=1000,height=1500)=>({file_path,iso_639_1,vote_average,vote_count,width,height});
  it('prefers the original Japanese poster over PT, EN and language-neutral posters',()=>expect(selectBestPoster([poster('/pt','pt',9),poster('/en','en',9),poster('/ja','ja',1),poster('/null',null,10)],{originalLanguage:'ja',interfaceLanguage:'pt-BR'})?.file_path).toBe('/ja'));
  it('prefers original Portuguese when the interface is English',()=>expect(selectBestPoster([poster('/en','en',10),poster('/pt','pt',1)],{originalLanguage:'pt',interfaceLanguage:'en-US'})?.file_path).toBe('/pt'));
  it('uses a language-neutral poster before the interface language',()=>expect(selectBestPoster([poster('/en','en',10),poster('/null',null,1)],{originalLanguage:'ja',interfaceLanguage:'en'})?.file_path).toBe('/null'));
  it('allows every backdrop language and returns the best three distinct images',()=>{
    const images=[poster('/null',null,5,1,2000,1000),poster('/en','en',8,2,1900,1000),poster('/ja','ja',7,2,1800,1000),poster('/pt','pt',6,2,1700,1000),poster('/en','en',10,99,100,100),poster('/x','fr',1,1,50,50)];
    expect(selectBestStills(images).map((x:any)=>x.file_path)).toEqual(['/null','/en','/ja']);
    expect(selectBestStills(images.slice(0,2))).toHaveLength(2);expect(selectBestStills([])).toEqual([]);
  });
  it('prefers neutral cinematic candidates over larger language-tagged key art',()=>{
    const images=[poster('/gravity-title-en.jpg','en',10,100,4000,2250),poster('/gravity-title-tr.jpg','tr',10,90,3900,2200),poster('/gravity-clean-keyart.jpg',null,5,1,1920,1080),poster('/gravity-scene-a.jpg',null,9,30,1920,1080),poster('/gravity-scene-b.jpg',null,8,20,1600,900),poster('/gravity-scene-c.jpg',null,7,10,1280,720)];
    const selected=selectBestStills(images).map((x:any)=>x.file_path);
    expect(selected).toHaveLength(3);expect(selected.every((path:string)=>path.includes('scene-'))).toBe(true);
  });
  it('excludes the selected poster, duplicate paths and undersized assets deterministically',()=>{
    const images=[poster('/poster.jpg',null,10,99,2000,1200),poster('/scene-a.jpg',null,7,9,1920,1080),poster('/scene-a.jpg',null,9,20,1920,1080),poster('/tiny.jpg',null,10,100,640,360),poster('/scene-b.jpg',null,8,10,1600,900)];
    const first=selectBestStills(images,3,{posterPath:'/poster.jpg'}).map((x:any)=>x.file_path);
    expect(first).toEqual(['/scene-a.jpg','/scene-b.jpg']);expect(selectBestStills(images,3,{posterPath:'/poster.jpg'}).map((x:any)=>x.file_path)).toEqual(first);
  });
  it('shares the image cache across locales and does not repeat the images request',async()=>{
    const cache=new Map<string,string>();const env:any={TMDB_API_KEY:'x',MOOVIBE_DB:{get:async(k:string)=>cache.has(k)?JSON.parse(cache.get(k)!):null,put:async(k:string,v:string)=>cache.set(k,v)}};
    const fetchMock=vi.fn(async(input:RequestInfo|URL)=>String(input).includes('/images')?new Response(JSON.stringify({posters:[poster('/ja','ja')],backdrops:[poster('/b',null)]})):new Response(JSON.stringify({credits:{crew:[]},external_ids:{}})));vi.stubGlobal('fetch',fetchMock);
    const movie:any={tmdb_id:7,original_language:'ja',poster_path:'/old-p',backdrop_path:'/old-b'};
    await hydrateMoviePresentation(env,movie,'pt-BR',{includeStills:true});await hydrateMoviePresentation(env,movie,'ja',{includeStills:true});
    expect(fetchMock.mock.calls.filter(call=>String(call[0]).includes('/images'))).toHaveLength(1);vi.unstubAllGlobals();
  });
  it('falls back to catalog images when the images endpoint fails',async()=>{
    const env:any={TMDB_API_KEY:'x'};const fetchMock=vi.fn(async(input:RequestInfo|URL)=>String(input).includes('/images')?new Response('down',{status:500}):new Response(JSON.stringify({credits:{crew:[]},external_ids:{}})));vi.stubGlobal('fetch',fetchMock);
    const result:any=await hydrateMoviePresentation(env,{tmdb_id:8,poster_path:'/old-p',backdrop_path:'/old-b'},'en',{includeStills:true});
    expect(result.poster_path).toBe('/old-p');expect(result.stills).toEqual(['/old-b']);vi.unstubAllGlobals();
  });
});

describe('rich final curation contract',()=>{
  it('requires a substantive justification without triggering a rewrite call',()=>{
    expect(curationSchema.properties.justification).toMatchObject({minLength:320,maxLength:950});
    expect(isWeakJustification('A short generic sentence.')).toBe(true);
    expect(isWeakJustification('A specific narrative bridge establishes the central conflict and its emotional pressure in concrete terms. A second distinct bridge considers pacing, intimacy, visual scale, and productive contrast without repeating generic adjectives. '.repeat(2))).toBe(false);
  });
  it('gives the curator bounded visual style and keyword context',()=>{
    const candidate:any=compactCandidate({tmdb_id:1,title:'Film',overview:'x'.repeat(900),keywords:['a','b','c','d','e','f','g'],enrichment:{moods:['m'],themes:['t'],atmosphere:['a'],visual_style:['one','two','three','four','five']}});
    expect(candidate.overview.length).toBeLessThanOrEqual(520);expect(candidate.keywords).toHaveLength(6);expect(candidate.visual_style).toHaveLength(4);expect(JSON.stringify(candidate).length).toBeLessThan(900);
  });
  it('demands two bridges, primary-only discussion, paraphrased lyrics and supplied facts',()=>{
    const system=buildCuratorSystem('Portuguese (Brazil)');
    expect(system).toMatch(/at least two distinct/i);expect(system).toMatch(/ONLY the primary film/);expect(system).toMatch(/Do not quote lyrics verbatim/);expect(system).toMatch(/Use only facts supplied/);expect(system).toContain('Portuguese (Brazil)');
  });
});
