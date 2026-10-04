import { GeminiClient } from './gemini.js';
import { diversify, rerank, validateCuration } from './recommender.js';

const parse=value=>{try{return Array.isArray(value)?value:JSON.parse(value||'[]')}catch{return[]}};
const profileSchema={type:'object',properties:{moods:{type:'array',items:{type:'string'}},themes:{type:'array',items:{type:'string'}},atmosphere:{type:'array',items:{type:'string'}},pace:{type:'string'},emotional_valence:{type:'number'},energy:{type:'number'},intimacy:{type:'number'},surrealism:{type:'number'},darkness:{type:'number'},humor:{type:'number'},romanticism:{type:'number'},narrative_density:{type:'number'},melancholy_level:{type:'number'},tension_level:{type:'number'}},required:['moods','themes','atmosphere','pace','emotional_valence','energy','intimacy','surrealism','darkness','humor','romanticism','narrative_density','melancholy_level','tension_level']};
const curationSchema={type:'object',properties:{primary_tmdb_id:{type:'integer'},alternative_tmdb_ids:{type:'array',items:{type:'integer'},minItems:2,maxItems:2},justification:{type:'string'},vibe_title:{type:'string'},tags:{type:'array',items:{type:'string'},minItems:4,maxItems:4},alternative_calls:{type:'array',items:{type:'string'},minItems:2,maxItems:2}},required:['primary_tmdb_id','alternative_tmdb_ids','justification','vibe_title','tags','alternative_calls']};

async function loadMovies(db,ids) {
  if(!ids.length)return[]; const placeholders=ids.map(()=>'?').join(',');
  const result=await db.prepare(`SELECT m.*,
    (SELECT json_group_array(g.name) FROM movie_genres mg JOIN genres g ON g.id=mg.genre_id WHERE mg.movie_id=m.id) genres,
    (SELECT json_group_array(c.name) FROM movie_countries mc JOIN countries c ON c.iso_3166_1=mc.country_code WHERE mc.movie_id=m.id) countries,
    (SELECT json_group_array(l.name) FROM movie_languages ml JOIN languages l ON l.iso_639_1=ml.language_code WHERE ml.movie_id=m.id) languages,
    (SELECT json_group_array(k.name) FROM movie_keywords mk JOIN keywords k ON k.id=mk.keyword_id WHERE mk.movie_id=m.id) keywords,
    (SELECT p.name FROM movie_credits mc JOIN people p ON p.id=mc.person_id WHERE mc.movie_id=m.id AND mc.job='Director' LIMIT 1) director,
    e.moods_json,e.themes_json,e.atmosphere_json,e.visual_style_json,e.pace,e.emotional_valence,e.energy,e.intimacy,e.surrealism,e.darkness,e.humor,e.romanticism,e.narrative_density,e.melancholy_level,e.tension_level,e.confidence
    FROM movies m LEFT JOIN movie_enrichments e ON e.movie_id=m.id WHERE m.tmdb_id IN (${placeholders})`).bind(...ids).all();
  return result.results.map(m=>({...m,genres:parse(m.genres),countries:parse(m.countries),languages:parse(m.languages),keywords:parse(m.keywords),enrichment:{moods:parse(m.moods_json),themes:parse(m.themes_json),atmosphere:parse(m.atmosphere_json),visual_style:parse(m.visual_style_json),pace:m.pace,emotional_valence:m.emotional_valence,energy:m.energy,intimacy:m.intimacy,surrealism:m.surrealism,darkness:m.darkness,humor:m.humor,romanticism:m.romanticism,narrative_density:m.narrative_density,melancholy_level:m.melancholy_level,tension_level:m.tension_level,confidence:m.confidence}}));
}

async function fallbackCandidates(db,profile,limit=100) {
  const terms=[...(profile.themes||[]),...(profile.moods||[]),...(profile.atmosphere||[])].slice(0,12).map(x=>String(x).toLowerCase());
  const result=await db.prepare(`SELECT DISTINCT m.tmdb_id FROM movies m LEFT JOIN movie_keywords mk ON mk.movie_id=m.id LEFT JOIN keywords k ON k.id=mk.keyword_id LEFT JOIN movie_enrichments e ON e.movie_id=m.id WHERE m.collection_status='complete' AND (e.movie_id IS NOT NULL OR m.overview IS NOT NULL) ORDER BY CASE WHEN lower(COALESCE(k.name,'')) IN (${terms.map(()=>'?').join(',')||"''"}) THEN 0 ELSE 1 END, COALESCE(m.vote_count,0)>20 DESC, random() LIMIT ?`).bind(...terms,limit).all();
  return result.results.map(x=>({id:String(x.tmdb_id),score:.35}));
}

export async function recommendFromCatalog({env,songs,lyrics,context,lang='en'}) {
  if(!env.MOOVIBE_LIBRARY) throw new Error('MOOVIBE_LIBRARY D1 binding is missing');
  const gemini=new GeminiClient(env.GEMINI_API_KEY);
  const songText=songs.map((s,i)=>`Song ${i+1}: ${s.title} — ${s.artist||'unknown'}${i===0?`\nLyrics/context:\n${lyrics||''}\n${context||''}`:''}`).join('\n\n');
  const analysis=await gemini.generateJson({system:'Create a unified music vibe profile. Infer aesthetic qualities, but do not invent factual claims. Numeric dimensions must be from 0 to 1.',prompt:songText,schema:profileSchema});
  const semantic=`Music profile\nSongs: ${songs.map(s=>`${s.title} — ${s.artist||''}`).join('; ')}\nMoods: ${analysis.data.moods.join(', ')}\nThemes: ${analysis.data.themes.join(', ')}\nAtmosphere: ${analysis.data.atmosphere.join(', ')}\nPace: ${analysis.data.pace}\nContext: ${String(context||'').slice(0,2500)}\nLyrics: ${String(lyrics||'').slice(0,3000)}`;
  const vector=await gemini.embed(semantic,{model:env.EMBEDDING_MODEL||'gemini-embedding-2',dimensions:Number(env.EMBEDDING_DIMENSIONS||768),taskType:'RETRIEVAL_QUERY'});
  let matches=[];
  if(env.MOVIE_VECTORS) { const result=await env.MOVIE_VECTORS.query(vector,{topK:100,returnMetadata:'all'}); matches=result.matches||[]; }
  if(matches.length<12) matches=await fallbackCandidates(env.MOOVIBE_LIBRARY,analysis.data,100);
  const movies=await loadMovies(env.MOOVIBE_LIBRARY,matches.map(m=>Number(m.id)).filter(Boolean)); const scoreById=new Map(matches.map(m=>[Number(m.id),m.score]));
  for(const movie of movies) movie.vector_score=scoreById.get(Number(movie.tmdb_id))||.3;
  const slate=diversify(rerank(movies,analysis.data),12); if(slate.length<3) throw new Error('CATALOG_TOO_SMALL');
  const candidates=slate.map(m=>({tmdb_id:m.tmdb_id,title:m.title,year:m.release_year,director:m.director,countries:m.countries,languages:m.languages,genres:m.genres,overview:m.overview,themes:m.enrichment.themes,moods:m.enrichment.moods,atmosphere:m.enrichment.atmosphere,score:Number(m.deterministic_score.toFixed(4))}));
  let curation;
  try {
    const result=await gemini.generateJson({system:`You are Moovibe's final curator. Choose ONLY IDs in the candidate list. Write the justification in ${lang==='pt'?'Brazilian Portuguese':'English'}. Never add factual movie claims beyond the supplied candidate facts.`,prompt:`Music profile:\n${JSON.stringify(analysis.data)}\n\nAllowed candidates:\n${JSON.stringify(candidates)}`,schema:curationSchema});
    curation=validateCuration(result.data,slate);
  } catch(error) {
    curation={primary_tmdb_id:Number(slate[0].tmdb_id),alternative_tmdb_ids:slate.slice(1,3).map(x=>Number(x.tmdb_id)),justification:lang==='pt'?'A atmosfera, o ritmo e a trajetória emocional deste filme formam a correspondência mais forte encontrada no catálogo do Moovibe.':'Its atmosphere, rhythm, and emotional arc form the strongest match found in the Moovibe catalog.',vibe_title:'CINEMATIC ECHO',tags:[...(analysis.data.moods||[]),...(analysis.data.atmosphere||[])].slice(0,4).map(x=>String(x).toUpperCase()),alternative_calls:lang==='pt'?['Para uma variação próxima','Para outra textura emocional']:['For a close variation','For another emotional texture']};
  }
  const byId=new Map(slate.map(m=>[Number(m.tmdb_id),m])); return {profile:analysis.data,curation,primary:byId.get(curation.primary_tmdb_id),alternatives:curation.alternative_tmdb_ids.map(id=>byId.get(id)).filter(Boolean),candidate_ids:slate.map(x=>Number(x.tmdb_id))};
}

export function movieToLegacy(movie) {
  return {id_tmdb:movie.tmdb_id,tmdb_url:`https://www.themoviedb.org/movie/${movie.tmdb_id}`,titulo_pt:movie.title,titulo_original:movie.original_title||movie.title,ano:movie.release_year||'',sinopse:movie.overview||'Sinopse indisponível.',poster:movie.poster_path?`https://image.tmdb.org/t/p/w780${movie.poster_path}`:null,diretor:movie.director||'Não encontrado',imdb_id:movie.imdb_id||null,cenas:movie.backdrop_path?[`https://image.tmdb.org/t/p/original${movie.backdrop_path}`]:[],tagline:movie.tagline||''};
}
