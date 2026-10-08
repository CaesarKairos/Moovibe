import { GeminiClient } from './gemini.js';
import { CANDIDATE_LIMIT, NUMERIC_TOP_K, SEMANTIC_TOP_K, diversify, mergeCandidateChannels, numericCandidateSql, rerank, validateCuration } from './recommender.js';
import { getLanguageConfig } from './languages.js';
import { isTransientPersistenceError, loadProfile, saveProfile, SONG_PROFILE_SCHEMA_VERSION, sha256 } from './song-library.js';
import { writeAudit } from './audit.js';

const parse=value=>{try{return Array.isArray(value)?value:JSON.parse(value||'[]')}catch{return[]}};
const arr=parse;
const num=(value,digits=4)=>value==null?null:Number(Number(value).toFixed(digits));
const truncate=(value,max)=>{const s=String(value||'');return s.length>max?s.slice(0,max-1)+'…':s;};
const profileSchema={type:'object',properties:{moods:{type:'array',items:{type:'string'}},themes:{type:'array',items:{type:'string'}},atmosphere:{type:'array',items:{type:'string'}},pace:{type:'string'},emotional_valence:{type:'number'},energy:{type:'number'},intimacy:{type:'number'},surrealism:{type:'number'},darkness:{type:'number'},humor:{type:'number'},romanticism:{type:'number'},narrative_density:{type:'number'},melancholy_level:{type:'number'},tension_level:{type:'number'}},required:['moods','themes','atmosphere','pace','emotional_valence','energy','intimacy','surrealism','darkness','humor','romanticism','narrative_density','melancholy_level','tension_level']};
const curationSchema={type:'object',properties:{primary_tmdb_id:{type:'integer'},alternative_tmdb_ids:{type:'array',items:{type:'integer'},minItems:2,maxItems:2},justification:{type:'string'},vibe_title:{type:'string'},tags:{type:'array',items:{type:'string'},minItems:4,maxItems:4},alternative_calls:{type:'array',items:{type:'string'},minItems:2,maxItems:2}},required:['primary_tmdb_id','alternative_tmdb_ids','justification','vibe_title','tags','alternative_calls']};
export const D1_ID_CHUNK_SIZE=90;

async function loadMovies(db,ids) {
  if(!ids.length)return[];
  const rows=[];
  for(let offset=0;offset<ids.length;offset+=D1_ID_CHUNK_SIZE) {
    const chunk=ids.slice(offset,offset+D1_ID_CHUNK_SIZE);
    const placeholders=chunk.map(()=>'?').join(',');
    const result=await db.prepare(`SELECT m.*,
    COALESCE(m.genres_json,(SELECT json_group_array(g.name) FROM movie_genres mg JOIN genres g ON g.id=mg.genre_id WHERE mg.movie_id=m.id)) genres,
    COALESCE(m.countries_json,(SELECT json_group_array(c.name) FROM movie_countries mc JOIN countries c ON c.iso_3166_1=mc.country_code WHERE mc.movie_id=m.id)) countries,
    COALESCE(m.languages_json,(SELECT json_group_array(l.name) FROM movie_languages ml JOIN languages l ON l.iso_639_1=ml.language_code WHERE ml.movie_id=m.id)) languages,
    COALESCE(m.keywords_json,(SELECT json_group_array(k.name) FROM movie_keywords mk JOIN keywords k ON k.id=mk.keyword_id WHERE mk.movie_id=m.id)) keywords,
    COALESCE(m.director_name,(SELECT p.name FROM movie_credits mc JOIN people p ON p.id=mc.person_id WHERE mc.movie_id=m.id AND mc.job='Director' LIMIT 1)) director,
    e.moods_json,e.themes_json,e.atmosphere_json,e.visual_style_json,e.pace,e.emotional_valence,e.energy,e.intimacy,e.surrealism,e.darkness,e.humor,e.romanticism,e.narrative_density,e.melancholy_level,e.tension_level,e.confidence
    FROM movies m LEFT JOIN movie_enrichments e ON e.movie_id=m.id WHERE m.tmdb_id IN (${placeholders})`).bind(...chunk).all();
    rows.push(...result.results);
  }
  return rows.map(m=>({...m,genres:parse(m.genres),countries:parse(m.countries),languages:parse(m.languages),keywords:parse(m.keywords),enrichment:{moods:parse(m.moods_json),themes:parse(m.themes_json),atmosphere:parse(m.atmosphere_json),visual_style:parse(m.visual_style_json),pace:m.pace,emotional_valence:m.emotional_valence,energy:m.energy,intimacy:m.intimacy,surrealism:m.surrealism,darkness:m.darkness,humor:m.humor,romanticism:m.romanticism,narrative_density:m.narrative_density,melancholy_level:m.melancholy_level,tension_level:m.tension_level,confidence:m.confidence}}));
}

// Deterministic keyword fallback (never random): merged into the candidate set
// only when the hybrid union yields fewer than 3 candidates.
async function fallbackCandidates(db,profile,limit=100) {
  const terms=[...(profile.themes||[]),...(profile.moods||[]),...(profile.atmosphere||[])].slice(0,12).map(x=>String(x).toLowerCase());
  const result=await db.prepare(`SELECT DISTINCT m.tmdb_id FROM movies m LEFT JOIN movie_keywords mk ON mk.movie_id=m.id LEFT JOIN keywords k ON k.id=mk.keyword_id LEFT JOIN movie_enrichments e ON e.movie_id=m.id WHERE m.collection_status='complete' AND (e.movie_id IS NOT NULL OR m.overview IS NOT NULL) ORDER BY CASE WHEN lower(COALESCE(k.name,'')) IN (${terms.map(()=>'?').join(',')||"''"}) THEN 0 ELSE 1 END, COALESCE(m.vote_count,0) DESC, m.tmdb_id ASC LIMIT ?`).bind(...terms,limit).all();
  return result.results.map(x=>({tmdb_id:Number(x.tmdb_id),channels:['keyword']}));
}

// CANAL B — numeric vibe channel: deterministic D1 scan over movie_enrichments.
// No embedding is required, so enriched movies can compete while the catalog is
// still being embedded.
async function numericCandidates(db,profile,limit=NUMERIC_TOP_K) {
  const {sql,binds}=numericCandidateSql(profile,limit);
  const result=await db.prepare(sql).bind(...binds).all();
  return result.results.map(r=>({tmdb_id:Number(r.tmdb_id),numeric_score:Number(r.numeric_score)}));
}

// Compact per-candidate representation sent to Gemini: enough for curation,
// bounded so 100 candidates stay well within a comfortable context window.
function compactCandidate(movie) {
  const e=movie.enrichment||{};
  const cs=movie.component_scores||{};
  return {
    tmdb_id:movie.tmdb_id,
    title:movie.title,
    year:movie.release_year||null,
    director:movie.director||null,
    genres:arr(movie.genres).slice(0,6),
    countries:arr(movie.countries).slice(0,4),
    languages:arr(movie.languages).slice(0,4),
    overview:truncate(movie.overview,300),
    moods:arr(e.moods).slice(0,6),
    themes:arr(e.themes).slice(0,6),
    atmosphere:arr(e.atmosphere).slice(0,6),
    pace:e.pace||null,
    numeric_vibe_score:num(cs.numeric),
    semantic_score:num(cs.semantic),
    concept_score:num(cs.concepts),
    final_score:num(cs.final)
  };
}

const normalizedTitle=value=>String(value||'').normalize('NFKD').replace(/[\u0300-\u036f]/g,'').toLocaleLowerCase().replace(/[^a-z0-9]+/g,' ').trim();
const mentionsTitle=(text,title)=>{
  const normalized=normalizedTitle(title);
  return Boolean(normalized)&&` ${normalizedTitle(text)} `.includes(` ${normalized} `);
};
const FALLBACKS={
  'pt-BR':['A atmosfera, o ritmo e a trajetória emocional deste filme refletem de forma coesa o perfil emocional e estético das músicas analisadas.','Para uma variação próxima','Para outra textura emocional'],
  en:['This film’s atmosphere, rhythm, and emotional arc cohesively reflect the emotional and aesthetic profile of the analyzed songs.','For a close variation','For another emotional texture'],
  'zh-CN':['这部电影的氛围、节奏与情感轨迹，完整呼应了这些歌曲的情绪与美学特征。','相近氛围的选择','另一种情感质感'],ru:['Атмосфера, ритм и эмоциональная арка этого фильма созвучны музыкальному профилю выбранных песен.','Близкая вариация','Другая эмоциональная текстура'],es:['La atmósfera, el ritmo y el arco emocional de esta película reflejan el perfil musical de las canciones analizadas.','Una variación cercana','Otra textura emocional'],de:['Atmosphäre, Rhythmus und emotionale Entwicklung dieses Films spiegeln das Musikprofil der analysierten Songs wider.','Eine ähnliche Variante','Eine andere emotionale Textur'],fr:["L’atmosphère, le rythme et l’arc émotionnel de ce film reflètent le profil musical des chansons analysées.",'Une variation proche','Une autre texture émotionnelle'],ja:['この映画の雰囲気、リズム、感情の軌跡は、分析した楽曲の音楽的プロフィールと響き合います。','近い雰囲気の作品','異なる感情の質感']};
const primaryOnlyJustification=lang=>(FALLBACKS[lang]||FALLBACKS.en)[0];

function keepJustificationPrimaryOnly(curation,slate,lang) {
  const byId=new Map(slate.map(movie=>[Number(movie.tmdb_id),movie]));
  const alternatives=curation.alternative_tmdb_ids.map(id=>byId.get(Number(id))).filter(Boolean);
  if(!alternatives.some(movie=>mentionsTitle(curation.justification,movie.title)))return curation;
  return {...curation,justification:primaryOnlyJustification(lang)};
}

export async function recommendFromCatalog({env,songs,lyrics,context,lang='en'}) {
  if(!env.MOOVIBE_LIBRARY) throw new Error('MOOVIBE_LIBRARY D1 binding is missing');
  const gemini=new GeminiClient(env.GEMINI_API_KEY);
  const requestId=crypto.randomUUID(), embeddingModel=env.EMBEDDING_MODEL||'gemini-embedding-2',dimensions=Number(env.EMBEDDING_DIMENSIONS||768);
  const perSong=[];
  for(const song of songs){
    const lyricsHash=song.lyrics_hash||await sha256(song.lyrics||''); let cached=await loadProfile(env.MOOVIBE_LIBRARY,song.song_id,{lyricsHash,schemaVersion:SONG_PROFILE_SCHEMA_VERSION,embeddingModel,dimensions});
    if(cached){perSong.push({profile:cached.profile,embedding:cached.embedding,model:cached.model});continue;}
    const prompt=`Song: ${song.title} — ${song.artist||'unknown'}\nLyrics:\n${String(song.lyrics||'').slice(0,12000)}\nContext:\n${String(song.context||'').slice(0,2000)}`; const started=Date.now();
    let generated;
    try{generated=await gemini.generateJson({system:'Create a language-independent structured music vibe profile grounded in the supplied lyrics. Do not invent lyrics or factual claims. Numeric dimensions must be from 0 to 1.',prompt,schema:profileSchema});await writeAudit(env,{request_id:requestId,timestamp:new Date().toISOString(),stage:'song_profile',model:generated.model,input:prompt,system_prompt:'structured music vibe profile grounded in lyrics',output:generated.data,duration_ms:Date.now()-started,success:true});}catch(error){await writeAudit(env,{request_id:requestId,timestamp:new Date().toISOString(),stage:'song_profile',input:prompt,duration_ms:Date.now()-started,success:false,error:String(error?.message||error)});throw error;}
    const document=`Song: ${song.title} — ${song.artist||''}\nProfile: ${JSON.stringify(generated.data)}\nLyrics: ${String(song.lyrics||'').slice(0,5000)}\nContext: ${String(song.context||'').slice(0,1500)}`; const embeddedAt=Date.now(); let embedding;
    try{embedding=await gemini.embed(document,{model:embeddingModel,dimensions,taskType:'RETRIEVAL_QUERY'});await writeAudit(env,{request_id:requestId,timestamp:new Date().toISOString(),stage:'song_embedding',model:embeddingModel,input:document,input_hash:await sha256(document),dimensions,duration_ms:Date.now()-embeddedAt,success:true});}catch(error){await writeAudit(env,{request_id:requestId,timestamp:new Date().toISOString(),stage:'song_embedding',model:embeddingModel,input:document,input_hash:await sha256(document),dimensions,duration_ms:Date.now()-embeddedAt,success:false,error:String(error?.message||error)});throw error;}
    if(song.song_id)try{await saveProfile(env.MOOVIBE_LIBRARY,song.song_id,{profile:generated.data,model:generated.model,lyricsHash,embedding,embeddingModel,dimensions});}catch(error){
      if(!isTransientPersistenceError(error))throw error;
      console.warn(JSON.stringify({event:'persistence_degraded',request_id:requestId,stage:'song_profile_persist',error_code:'D1_WRITE_QUOTA',error_class:error?.constructor?.name||'Error'}));
    } perSong.push({profile:generated.data,embedding,model:generated.model});
  }
  const numericKeys=['emotional_valence','energy','intimacy','surrealism','darkness','humor','romanticism','narrative_density','melancholy_level','tension_level'];
  /** @type {any} */ const combined={}; for(const key of ['moods','themes','atmosphere'])combined[key]=[...new Set(perSong.flatMap(x=>x.profile[key]||[]))].slice(0,12); combined.pace=perSong.map(x=>x.profile.pace).filter(Boolean).join(' / '); for(const key of numericKeys)combined[key]=perSong.reduce((sum,x)=>sum+Number(x.profile[key]||0),0)/perSong.length;
  const analysis={data:combined};
  const semantic=`Music profile\nSongs: ${songs.map(s=>`${s.title} — ${s.artist||''}\nLyrics: ${String(s.lyrics||'').slice(0,2500)}\nContext: ${String(s.context||'').slice(0,800)}`).join('\n\n')}\nProfile: ${JSON.stringify(analysis.data)}`;
  const vector=songs.length===1?perSong[0].embedding:await gemini.embed(semantic,{model:embeddingModel,dimensions,taskType:'RETRIEVAL_QUERY'});

  // CANAL A — semantic: music-profile embedding against Vectorize (top 100).
  let semanticMatches=[];
  if(env.MOVIE_VECTORS) { const result=await env.MOVIE_VECTORS.query(vector,{topK:SEMANTIC_TOP_K,returnValues:false,returnMetadata:'indexed'}); semanticMatches=result.matches||[]; }
  // CANAL B — numeric vibe: deterministic D1 similarity (top 100), no embedding required.
  const numericRows=await numericCandidates(env.MOOVIBE_LIBRARY,analysis.data);
  // Union + dedupe by tmdb_id: movies in both channels keep both signals.
  let merged=mergeCandidateChannels(semanticMatches,numericRows);
  let keywordFallback=0;
  if(merged.length<3) {
    const extra=await fallbackCandidates(env.MOOVIBE_LIBRARY,analysis.data);
    for(const f of extra) if(!merged.some(m=>m.tmdb_id===f.tmdb_id)) { merged.push(f); keywordFallback++; }
  }
  const channels=new Map(merged.map(m=>[m.tmdb_id,m]));
  const movies=await loadMovies(env.MOOVIBE_LIBRARY,merged.map(m=>m.tmdb_id).filter(Boolean));
  for(const movie of movies) {
    const ch=channels.get(Number(movie.tmdb_id))||{};
    if(ch.vector_score!=null) movie.vector_score=ch.vector_score;
    if(ch.numeric_score!=null) movie.numeric_score=ch.numeric_score;
    movie.channels=ch.channels||[];
  }
  const ranked=rerank(movies,analysis.data);
  const slate=diversify(ranked,CANDIDATE_LIMIT);
  if(slate.length<3) throw new Error('CATALOG_TOO_SMALL');
  const candidates=slate.map(compactCandidate);
  const diagnostics={
    semantic_count:semanticMatches.length,
    numeric_count:numericRows.length,
    union_count:merged.length,
    final_count:slate.length,
    keyword_fallback_count:keywordFallback,
    top:ranked.slice(0,5).map(c=>({tmdb_id:c.tmdb_id,final_score:num(c.deterministic_score),components:{numeric:num(c.component_scores?.numeric),semantic:num(c.component_scores?.semantic),concepts:num(c.component_scores?.concepts),quality:num(c.component_scores?.quality),final:num(c.component_scores?.final)},channels:c.channels}))
  };
  console.log(JSON.stringify({event:'catalog_candidates',lang,semantic_count:diagnostics.semantic_count,numeric_count:diagnostics.numeric_count,union_count:diagnostics.union_count,final_count:diagnostics.final_count,keyword_fallback_count:keywordFallback,ranking:'deterministic',top:diagnostics.top}));
  let curation;
  try {
    const language=getLanguageConfig(lang); const curatorPrompt=`Music profile:\n${JSON.stringify(analysis.data)}\n\nLyrical evidence:\n${songs.map(s=>`${s.title}: ${String(s.lyrics||'').slice(0,1800)}`).join('\n\n')}\n\nAllowed candidates:\n${JSON.stringify(candidates)}`; const curatorSystem=`You are Moovibe's final curator, restricted to the supplied candidate list. Choose ONLY supplied tmdb_id values; exactly 1 primary and 2 distinct alternatives. Ground the connection in the supplied lyrical evidence and profile, without long lyric quotations. Never invent cinematic facts. Discuss only the primary film in justification. Write presentation fields in ${language.aiName}.`;
    const result=await gemini.generateJson({system:curatorSystem,prompt:curatorPrompt,schema:curationSchema}); await writeAudit(env,{request_id:requestId,timestamp:new Date().toISOString(),stage:'final_curation',model:result.model,input:curatorPrompt,system_prompt:curatorSystem,output:result.data,success:true});
    curation=keepJustificationPrimaryOnly(validateCuration(result.data,slate),slate,lang);
  } catch(error) {
    await writeAudit(env,{request_id:requestId,timestamp:new Date().toISOString(),stage:'final_curation',success:false,error:String(error?.message||error)});
    // Deterministic fallback: never search externally for a replacement.
    const fallback=FALLBACKS[lang]||FALLBACKS.en; curation={primary_tmdb_id:Number(slate[0].tmdb_id),alternative_tmdb_ids:slate.slice(1,3).map(x=>Number(x.tmdb_id)),justification:fallback[0],vibe_title:'CINEMATIC ECHO',tags:[...(analysis.data.moods||[]),...(analysis.data.atmosphere||[])].slice(0,4).map(x=>String(x).toUpperCase()),alternative_calls:fallback.slice(1)};
  }
  const byId=new Map(slate.map(m=>[Number(m.tmdb_id),m]));
  const selected=[byId.get(curation.primary_tmdb_id),...curation.alternative_tmdb_ids.map(id=>byId.get(id))].filter(Boolean);
  const hydrated=await Promise.all(selected.map((movie,index)=>hydrateMoviePresentation(env,movie,lang,{includeStills:index===0})));
  return {request_id:requestId,profile:analysis.data,curation,primary:hydrated[0],alternatives:hydrated.slice(1),candidate_ids:slate.map(x=>Number(x.tmdb_id)),candidate_count:slate.length,diagnostics};
}

const IMAGE_CACHE_TTL=60*60*24*14;
const normalizeLanguage=value=>String(value||'').trim().toLowerCase().split('-')[0]||null;
const validImages=images=>(Array.isArray(images)?images:[]).filter(image=>image?.file_path);
const imageQuality=(a,b)=>Number(b.vote_average||0)-Number(a.vote_average||0)||Number(b.vote_count||0)-Number(a.vote_count||0)||(Number(b.width||0)*Number(b.height||0))-(Number(a.width||0)*Number(a.height||0))||String(a.file_path).localeCompare(String(b.file_path));

export function selectBestPoster(posters,{originalLanguage,interfaceLanguage}={}) {
  const original=normalizeLanguage(originalLanguage),ui=normalizeLanguage(interfaceLanguage);
  const priority=language=>language===original&&original?0:language==null?1:language===ui&&ui?2:language==='en'?3:4;
  return validImages(posters).sort((a,b)=>priority(normalizeLanguage(a.iso_639_1))-priority(normalizeLanguage(b.iso_639_1))||imageQuality(a,b))[0]||null;
}

export function selectBestStills(backdrops,limit=3) {
  const stillQuality=(a,b)=>(Number(b.width||0)*Number(b.height||0))-(Number(a.width||0)*Number(a.height||0))||imageQuality(a,b);
  const byPath=new Map();
  for(const image of validImages(backdrops))if(!byPath.has(image.file_path)||stillQuality(image,byPath.get(image.file_path))<0)byPath.set(image.file_path,image);
  const unique=[...byPath.values()];
  return unique.sort(stillQuality).slice(0,limit);
}

const readCache=async(env,key,tmdbId)=>{try{return await env.MOOVIBE_DB?.get(key,'json')||null;}catch{console.warn(JSON.stringify({event:'hydration_cache_read_failed',tmdb_id:tmdbId,key}));return null;}};
const writeCache=async(env,key,value,tmdbId)=>{try{await env.MOOVIBE_DB?.put(key,JSON.stringify(value),{expirationTtl:IMAGE_CACHE_TTL});}catch{console.warn(JSON.stringify({event:'hydration_cache_write_failed',tmdb_id:tmdbId,key}));}};
const posterLanguages=(movie,lang)=>[normalizeLanguage(movie.original_language),'null','en','pt','zh','ru','es','de','fr','ja',normalizeLanguage(lang)].filter(Boolean).filter((value,index,list)=>list.indexOf(value)===index).join(',');

export async function hydrateMoviePresentation(env,movie,lang='en',{includeStills=false}={}) {
  if(!movie?.tmdb_id)return movie;
  const metadataKey=`movie-presentation:${movie.tmdb_id}:${lang}`,imagesKey=`movie-images:${movie.tmdb_id}`;
  let [presentation,images]=await Promise.all([readCache(env,metadataKey,movie.tmdb_id),readCache(env,imagesKey,movie.tmdb_id)]);
  if(!env.TMDB_API_KEY)return {...movie,...presentation,...images,stills:includeStills?(images?.stills||[]):[]};

  if(!presentation)try {
    const url=new URL(`https://api.themoviedb.org/3/movie/${movie.tmdb_id}`);
    url.searchParams.set('api_key',env.TMDB_API_KEY);url.searchParams.set('language',lang);
    url.searchParams.set('append_to_response',includeStills?'credits,external_ids':'credits,external_ids,images');
    if(!includeStills)url.searchParams.set('include_image_language',posterLanguages(movie,lang));
    const response=await fetch(url);if(!response.ok)throw new Error(`TMDB_${response.status}`);
    const data=await response.json();
    presentation={director:data.credits?.crew?.find(x=>x.job==='Director')?.name||movie.director||null,imdb_id:data.external_ids?.imdb_id||data.imdb_id||movie.imdb_id||null,runtime:data.runtime||movie.runtime||null,tagline:data.tagline||movie.tagline||'',title:data.title||movie.title,overview:data.overview||movie.overview};
    await writeCache(env,metadataKey,presentation,movie.tmdb_id);
    if(!images&&!includeStills) {
      const poster=selectBestPoster(data.images?.posters,{originalLanguage:movie.original_language||data.original_language,interfaceLanguage:lang});
      images={poster_path:poster?.file_path||movie.poster_path||null,stills:[],complete:false};
      await writeCache(env,imagesKey,images,movie.tmdb_id);
    }
  } catch { console.warn(JSON.stringify({event:'hydration_failed',tmdb_id:movie.tmdb_id,error_code:'TMDB_UNAVAILABLE'})); }

  if(includeStills&&(!images||!images.complete))try {
    const url=new URL(`https://api.themoviedb.org/3/movie/${movie.tmdb_id}/images`);
    url.searchParams.set('api_key',env.TMDB_API_KEY);
    const response=await fetch(url);if(!response.ok)throw new Error(`TMDB_IMAGES_${response.status}`);
    const data=await response.json();
    const poster=selectBestPoster(data.posters,{originalLanguage:movie.original_language,interfaceLanguage:lang});
    images={poster_path:poster?.file_path||images?.poster_path||movie.poster_path||null,stills:selectBestStills(data.backdrops).map(image=>image.file_path),complete:true};
    await writeCache(env,imagesKey,images,movie.tmdb_id);
  } catch { console.warn(JSON.stringify({event:'image_hydration_failed',tmdb_id:movie.tmdb_id,error_code:'TMDB_IMAGES_UNAVAILABLE'})); }

  const stills=includeStills?(images?.stills?.length?images.stills:(movie.backdrop_path?[movie.backdrop_path]:[])):[];
  return {...movie,...presentation,...images,poster_path:images?.poster_path||movie.poster_path,stills};
}

export function movieToLegacy(movie) {
  const imageUrl=(path,size)=>path?(String(path).startsWith('http')?path:`https://image.tmdb.org/t/p/${size}${path}`):null;
  const stills=Array.isArray(movie.stills)&&movie.stills.length?movie.stills:(movie.backdrop_path?[movie.backdrop_path]:[]);
  return {id_tmdb:movie.tmdb_id,tmdb_url:`https://www.themoviedb.org/movie/${movie.tmdb_id}`,titulo_pt:movie.title,titulo_original:movie.original_title||movie.title,ano:movie.release_year||'',sinopse:movie.overview||'Sinopse indisponível.',poster:imageUrl(movie.poster_path,'w780'),diretor:movie.director||'Não encontrado',imdb_id:movie.imdb_id||null,cenas:[...new Set(stills)].map(path=>imageUrl(path,'original')).filter(Boolean),tagline:movie.tagline||''};
}
