import { GeminiClient } from './gemini.js';
import { CANDIDATE_LIMIT, NUMERIC_TOP_K, SEMANTIC_TOP_K, diversify, mergeCandidateChannels, numericCandidateSql, rerank, validateCuration } from './recommender.js';
import { getLanguageConfig } from './languages.js';
import { isTransientPersistenceError, loadProfile, saveProfile, SONG_PROFILE_SCHEMA_VERSION, SONG_EMBEDDING_DOCUMENT_VERSION, sha256 } from './song-library.js';
import { writeAudit } from './audit.js';
import { applyRecommendationHistory } from './recommendation-history.js';
import { createRecommendationGenerator } from './generation-router.js';
import { circuitState, openCircuit, closeCircuit } from '../../workers/pipeline/src/generation-provider.ts';
import { classifyProviderError } from '../../workers/pipeline/src/provider-errors.ts';

const parse=value=>{try{return Array.isArray(value)?value:JSON.parse(value||'[]')}catch{return[]}};
const arr=parse;
const num=(value,digits=4)=>value==null?null:Number(Number(value).toFixed(digits));
const truncate=(value,max)=>{const s=String(value||'');return s.length>max?s.slice(0,max-1)+'…':s;};
const profileSchema={type:'object',properties:{moods:{type:'array',items:{type:'string'}},themes:{type:'array',items:{type:'string'}},atmosphere:{type:'array',items:{type:'string'}},pace:{type:'string'},emotional_valence:{type:'number'},energy:{type:'number'},intimacy:{type:'number'},surrealism:{type:'number'},darkness:{type:'number'},humor:{type:'number'},romanticism:{type:'number'},narrative_density:{type:'number'},melancholy_level:{type:'number'},tension_level:{type:'number'}},required:['moods','themes','atmosphere','pace','emotional_valence','energy','intimacy','surrealism','darkness','humor','romanticism','narrative_density','melancholy_level','tension_level'],additionalProperties:false};
export const curationSchema={type:'object',properties:{primary_tmdb_id:{type:'integer'},alternative_tmdb_ids:{type:'array',items:{type:'integer'},minItems:2,maxItems:2},justification:{type:'string',minLength:320,maxLength:950},vibe_title:{type:'string'},tags:{type:'array',items:{type:'string'},minItems:4,maxItems:4},alternative_calls:{type:'array',items:{type:'string'},minItems:2,maxItems:2}},required:['primary_tmdb_id','alternative_tmdb_ids','justification','vibe_title','tags','alternative_calls'],additionalProperties:false};
export function validateProfile(data){
  if(!data||typeof data!=='object'||Array.isArray(data))return{ok:false,error:'profile must be an object'};
  for(const key of ['moods','themes','atmosphere'])if(!Array.isArray(data[key])||data[key].some(value=>typeof value!=='string'))return{ok:false,error:'invalid array: '+key};
  if(typeof data.pace!=='string')return{ok:false,error:'invalid pace'};
  for(const key of ['emotional_valence','energy','intimacy','surrealism','darkness','humor','romanticism','narrative_density','melancholy_level','tension_level'])if(typeof data[key]!=='number'||!Number.isFinite(data[key])||data[key]<0||data[key]>1)return{ok:false,error:'invalid dimension: '+key};
  return{ok:true};
}
export const D1_ID_CHUNK_SIZE=90;

export async function loadMovies(db,ids) {
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
export function compactCandidate(movie) {
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
    overview:truncate(movie.overview,520),
    keywords:arr(movie.keywords).slice(0,6),
    moods:arr(e.moods).slice(0,6),
    themes:arr(e.themes).slice(0,6),
    atmosphere:arr(e.atmosphere).slice(0,6),
    visual_style:arr(e.visual_style).slice(0,4),
    pace:e.pace||null,
    numeric_vibe_score:num(cs.numeric),
    semantic_score:num(cs.semantic),
    concept_score:num(cs.concepts),
    final_score:num(cs.final)
  };
}

const GENERIC_JUSTIFICATION_PHRASES=['perfectly captures','perfectly translates','echoes the atmosphere','resonates with','captures the essence','this vibe','unique journey','traduz perfeitamente','captura perfeitamente','ecoa a atmosfera','ressoa com','captura a essência','a atmosfera, o ritmo e a trajetória emocional','refletem de forma coesa o perfil emocional','perfil emocional e estético das músicas analisadas'];
export function isWeakJustification(text) {
  const value=String(text||'').trim(),sentences=value.split(/[.!?。！？]+/).filter(part=>part.trim().length>20);
  const genericHits=GENERIC_JUSTIFICATION_PHRASES.filter(phrase=>value.toLocaleLowerCase().includes(phrase)).length;
  return value.length<320||sentences.length<2||genericHits>0;
}

export function buildCuratorSystem(languageName) {
  return `You are Moovibe's final curator: an incisive film critic writing for a stylish independent cinema magazine, not a recommendation chatbot. Choose ONLY supplied tmdb_id values: exactly 1 primary and exactly 2 distinct alternatives. The justification must discuss ONLY the primary film and explain why this particular film belongs to these songs through at least two distinct, concrete bridges. Start from a specific situation, conflict, or detail in the primary film's supplied synopsis; then connect it to a named song theme or emotional movement and to a separate supported quality such as pacing, intimacy, or visual language. Every sentence must add a film-specific fact or interpretive connection. Do not merely restate matching adjectives or write a general statement that could describe any film. Avoid generic AI phrasing such as "perfectly captures", "perfectly translates", "echoes the atmosphere", "resonates with", "captures the essence", "this vibe", or "unique journey". Use only facts supplied in the candidate data; never invent scenes or cinematic facts. Do not explain the algorithm or mention scores, embeddings, candidates, or AI. Do not quote lyrics verbatim or reproduce long lyric phrases; paraphrase lyrical ideas. Write naturally and confidently, targeting roughly 90–150 words. Write all presentation fields in ${languageName}.`;
}

const normalizedTitle=value=>String(value||'').normalize('NFKD').replace(/[\u0300-\u036f]/g,'').toLocaleLowerCase().replace(/[^a-z0-9]+/g,' ').trim();
const mentionsTitle=(text,title)=>{
  const normalized=normalizedTitle(title);
  return Boolean(normalized)&&` ${normalizedTitle(text)} `.includes(` ${normalized} `);
};
const FALLBACK_ALTERNATIVE_CALLS={
  'pt-BR':['Para uma variação próxima','Para outra textura emocional'],
  en:['For a close variation','For another emotional texture'],
  'zh-CN':['相近氛围的选择','另一种情感质感'],
  ru:['Близкая вариация','Другая эмоциональная текстура'],
  es:['Una variación cercana','Otra textura emocional'],
  de:['Eine ähnliche Variante','Eine andere emotionale Textur'],
  fr:['Une variation proche','Une autre texture émotionnelle'],
  ja:['近い雰囲気の作品','異なる感情の質感']
};
const FALLBACK_JUSTIFICATION={
  'pt-BR':({title,summary,filmTheme,songTheme,filmMood,songMood,filmPace,songPace,sharedTheme})=>`${summary?`A sinopse de ${title} situa a história em ${summary}.`:`${title} é descrito no catálogo por ${filmTheme} e ${filmMood}.`} ${sharedTheme?`O tema de ${songTheme} aparece nos dois perfis, mas ganha forma narrativa no filme por meio de ${filmTheme}.`:`Nas faixas, ${songTheme} se aproxima de ${songMood}; no filme, ${filmTheme} oferece um contraponto concreto a esse eixo.`} Essa conexão não depende apenas do tema em comum: o sentimento das músicas (${songMood}) ganha outra textura no clima ${filmMood} do filme, dentro da situação descrita na sinopse. O ritmo ${filmPace} do filme ${filmPace===songPace?'prolonga':'contrasta com'} o andamento ${songPace} das músicas, mudando a maneira como essa emoção se desenvolve. É essa combinação entre situação, tema e ritmo — e não uma semelhança vaga de atmosfera — que torna a escolha específica.`,
  en:({title,summary,filmTheme,songTheme,filmMood,songMood,filmPace,songPace,sharedTheme})=>`${summary?`The synopsis places ${title} in a story shaped by ${summary}.`:`The catalog describes ${title} through ${filmTheme} and ${filmMood}.`} ${sharedTheme?`The songs' theme of ${songTheme} also appears in the film, where ${filmTheme} gives it a narrative form.`:`In the songs, ${songTheme} sits alongside ${songMood}; the film's ${filmTheme} offers a concrete counterpoint to that tension.`} The film's ${filmPace} pace ${filmPace===songPace?'extends':'contrasts with'} the songs' ${songPace} movement, changing how that emotion unfolds. The connection comes from this specific interplay of situation, theme, and rhythm, not from a vague similarity of atmosphere.`,
  'zh-CN':({title,summary,filmTheme,songTheme,filmMood,songMood,filmPace,songPace,sharedTheme})=>`${summary?`${title}的剧情简介将故事置于${summary}之中。`:`目录将${title}概括为${filmTheme}与${filmMood}。`}${sharedTheme?`歌曲中的${songTheme}主题也出现在影片里，并通过${filmTheme}获得叙事形态。`:`歌曲以${songTheme}和${songMood}为线索，影片中的${filmTheme}则为这种情绪提供了具体的对照。`}影片${filmPace}的节奏${filmPace===songPace?'延续':'对照'}歌曲${songPace}的推进方式，改变了这份情绪展开的路径。两者的联系来自情境、主题与节奏之间的具体作用，而非笼统的氛围相似。`,
  ru:({title,summary,filmTheme,songTheme,filmMood,songMood,filmPace,songPace,sharedTheme})=>`${summary?`Синопсис ${title} помещает историю в контекст: ${summary}.`:`В каталоге ${title} описан через ${filmTheme} и ${filmMood}.`} ${sharedTheme?`Тема ${songTheme} есть и в песнях, и в фильме, где ${filmTheme} придаёт ей сюжетную форму.`:`В песнях ${songTheme} соседствует с ${songMood}, а ${filmTheme} фильма становится конкретным противовесом этому настроению.`} Темп фильма — ${filmPace} — ${filmPace===songPace?'продолжает':'контрастирует с'} движением песен — ${songPace}, меняя развитие эмоции. Связь строится на сочетании ситуации, темы и ритма, а не на расплывчатом сходстве атмосферы.`,
  es:({title,summary,filmTheme,songTheme,filmMood,songMood,filmPace,songPace,sharedTheme})=>`${summary?`La sinopsis de ${title} sitúa la historia en ${summary}.`:`El catálogo describe ${title} a través de ${filmTheme} y ${filmMood}.`} ${sharedTheme?`El tema de ${songTheme} también aparece en las canciones y adquiere forma narrativa mediante ${filmTheme}.`:`En las canciones, ${songTheme} convive con ${songMood}; ${filmTheme} ofrece un contrapunto concreto a esa tensión.`} El ritmo ${filmPace} de la película ${filmPace===songPace?'prolonga':'contrasta con'} el movimiento ${songPace} de las canciones y cambia cómo evoluciona esa emoción. La conexión nace de esa relación específica entre situación, tema y ritmo, no de una vaga semejanza de atmósfera.`,
  de:({title,summary,filmTheme,songTheme,filmMood,songMood,filmPace,songPace,sharedTheme})=>`${summary?`Die Inhaltsangabe zu ${title} verortet die Handlung in ${summary}.`:`Der Katalog beschreibt ${title} durch ${filmTheme} und ${filmMood}.`} ${sharedTheme?`Das Thema ${songTheme} findet sich auch in den Songs und erhält durch ${filmTheme} eine erzählerische Form.`:`In den Songs trifft ${songTheme} auf ${songMood}; ${filmTheme} setzt dieser Spannung einen konkreten Gegenpol entgegen.`} Das ${filmPace} Erzähltempo des Films ${filmPace===songPace?'führt':'kontrastiert mit'} der ${songPace} Bewegung der Songs und verändert so die Entwicklung des Gefühls. Die Verbindung entsteht aus Situation, Thema und Rhythmus statt aus einer vagen Stimmungsähnlichkeit.`,
  fr:({title,summary,filmTheme,songTheme,filmMood,songMood,filmPace,songPace,sharedTheme})=>`${summary?`Le synopsis de ${title} situe le récit autour de ${summary}.`:`Le catalogue associe ${title} à ${filmTheme} et ${filmMood}.`} ${sharedTheme?`Le thème de ${songTheme} traverse aussi les morceaux, tandis que ${filmTheme} lui donne une forme narrative.`:`Dans les morceaux, ${songTheme} côtoie ${songMood} ; ${filmTheme} apporte un contrepoint concret à cette tension.`} Le rythme ${filmPace} du film ${filmPace===songPace?'prolonge':'contraste avec'} le mouvement ${songPace} des chansons et transforme le développement de cette émotion. Le rapprochement repose sur cette interaction précise entre situation, thème et rythme, pas sur une vague ressemblance d’atmosphère.`,
  ja:({title,summary,filmTheme,songTheme,filmMood,songMood,filmPace,songPace,sharedTheme})=>`${summary?`${title}のあらすじは、${summary}という状況から物語を描きます。`:`カタログでは、${title}は${filmTheme}と${filmMood}を軸に紹介されています。`}${sharedTheme?`楽曲の${songTheme}というテーマは映画にもあり、${filmTheme}を通して物語として形になります。`:`楽曲にある${songTheme}と${songMood}に対し、映画の${filmTheme}が具体的な対照をつくります。`}映画の${filmPace}なリズムは楽曲の${songPace}な流れを${filmPace===songPace?'引き継ぎます':'対照させます'}。状況、テーマ、リズムのこの結びつきが、単なる雰囲気の類似ではない推薦の根拠です。`
};
const normalizedSignal=value=>String(value||'').normalize('NFKD').replace(/[\u0300-\u036f]/g,'').trim().toLocaleLowerCase();
export function buildFallbackJustification(profile,movie,lang='en') {
  const enrichment=movie?.enrichment||{};
  const profileThemes=arr(profile?.themes),filmThemes=arr(enrichment.themes),profileMoods=arr(profile?.moods),filmMoods=arr(enrichment.moods);
  const overview=String(movie?.overview||'').replace(/<[^>]*>/g,' ').replace(/\s+/g,' ').trim();
  const values={
    title:String(movie?.title||'this film'),
    summary:overview?truncate(overview,180).replace(/[.!?…]+$/,''):null,
    filmTheme:filmThemes[0]||arr(movie?.keywords)[0]||arr(movie?.genres)[0]||'the film’s central conflict',
    songTheme:profileThemes[0]||profileMoods[0]||arr(profile?.atmosphere)[0]||'the songs’ central theme',
    filmMood:filmMoods[0]||arr(enrichment.atmosphere)[0]||arr(enrichment.visual_style)[0]||'its visual language',
    songMood:profileMoods[0]||arr(profile?.atmosphere)[0]||'the songs’ emotional tone',
    filmPace:String(enrichment.pace||'measured'),
    songPace:String(profile?.pace||'distinctive'),
    sharedTheme:profileThemes.find(theme=>filmThemes.some(candidate=>normalizedSignal(candidate)===normalizedSignal(theme)))||null
  };
  const locale=lang==='pt'?'pt-BR':lang;
  return (FALLBACK_JUSTIFICATION[locale]||FALLBACK_JUSTIFICATION.en)(values);
}

function keepJustificationPrimaryOnly(curation,slate,lang,profile) {
  const byId=new Map(slate.map(movie=>[Number(movie.tmdb_id),movie]));
  const alternatives=curation.alternative_tmdb_ids.map(id=>byId.get(Number(id))).filter(Boolean);
  if(!alternatives.some(movie=>mentionsTitle(curation.justification,movie.title)))return curation;
  return {...curation,justification:buildFallbackJustification(profile,byId.get(Number(curation.primary_tmdb_id)),lang)};
}

/**
 * @param {{env: any, songs: any[], lyrics?: string, context?: string, lang?: string, history?: any, excludedTmdbIds?: number[], requireCuration?: boolean, requestId?: string|null}} options
 */
export async function recommendFromCatalog({env,songs,lyrics,context,lang='en',history={specific:[],global:[],available:false},excludedTmdbIds=[],requireCuration=false,requestId:requestIdInput=null}) {
  if(!env.MOOVIBE_LIBRARY) throw new Error('MOOVIBE_LIBRARY D1 binding is missing');
  const gemini=env.GEMINI_API_KEY?new GeminiClient(env.GEMINI_API_KEY):null;
  const requestId=requestIdInput||crypto.randomUUID(), generator=createRecommendationGenerator(env,{requestId}), embeddingModel=env.EMBEDDING_MODEL||'gemini-embedding-2',dimensions=Number(env.EMBEDDING_DIMENSIONS||768);
  const embeddingCircuit=await circuitState(env.MOOVIBE_LIBRARY,'embedding-gemini');
  let embeddingCircuitOpen=embeddingCircuit.open||embeddingCircuit.unknown||!gemini;
  let embeddingFallback=false;
  const embedOrFallback=async(text,stage)=>{
    if(embeddingCircuitOpen){embeddingFallback=true;return null;}
    const started=Date.now();
    try{
      const values=await gemini.embed(text,{model:embeddingModel,dimensions,taskType:'RETRIEVAL_QUERY'});
      await closeCircuit(env.MOOVIBE_LIBRARY,'embedding-gemini');
      await writeAudit(env,{request_id:requestId,stage,provider:'gemini',model:embeddingModel,dimensions,duration_ms:Date.now()-started,success:true});
      return values;
    }catch(error){
      embeddingFallback=true;embeddingCircuitOpen=true;
      const classified=classifyProviderError(error);
      await writeAudit(env,{request_id:requestId,stage,provider:'gemini',model:embeddingModel,dimensions,duration_ms:Date.now()-started,success:false,error:String(error?.message||error)});
      if(['QUOTA_EXHAUSTED','RATE_LIMITED','PROVIDER_UNAVAILABLE','TIMEOUT','INVALID_CREDENTIAL'].includes(classified.code))
        await openCircuit(env.MOOVIBE_LIBRARY,'embedding-gemini',classified.retryAfterSeconds||600,`${classified.code} ${classified.httpStatus||''}`.trim());
      return null;
    }
  };
  const perSong=[];let profileCacheHits=0,embeddingCacheHits=0;
  for(const song of songs){
    const basis=song.analysis_basis||'LYRICAL';
    const signaturePayload={identity:{provider:song.provider,provider_id:song.provider_id,title:song.title,artist:song.artist},analysis_basis:basis,lyrics_hash:basis==='LYRICAL'?(song.lyrics_hash||await sha256(song.lyrics||'')):null,audio_source:song.acoustic_source||null,audio_features:song.acoustic_features||null,schema:SONG_PROFILE_SCHEMA_VERSION,document:SONG_EMBEDDING_DOCUMENT_VERSION};
    const lyricsHash=await sha256(JSON.stringify(signaturePayload));
    const profileCacheKey=`recommendation-profile:v1:${lyricsHash}:${embeddingModel}:${dimensions}`;
    let cached=await loadProfile(env.MOOVIBE_LIBRARY,song.song_id,{lyricsHash,schemaVersion:SONG_PROFILE_SCHEMA_VERSION,embeddingModel,dimensions});
    if(cached&&!validateProfile(cached.profile).ok)cached=null;
    if(cached&&(!Array.isArray(cached.embedding)||cached.embedding.length!==dimensions||!cached.embedding.every(Number.isFinite)))cached={...cached,embedding:null};
    if(!cached&&env.MOOVIBE_DB)try{
      const saved=await env.MOOVIBE_DB.get(profileCacheKey,'json');
      if(saved&&validateProfile(saved.profile).ok)cached={...saved,embedding:Array.isArray(saved.embedding)&&saved.embedding.length===dimensions&&saved.embedding.every(Number.isFinite)?saved.embedding:null};
    }catch(error){console.warn(JSON.stringify({event:'profile_cache_read_failed',request_id:requestId,stage:'song_profile',error_class:error?.constructor?.name||'Error'}));}
    if(cached){profileCacheHits++;if(Array.isArray(cached.embedding))embeddingCacheHits++;perSong.push({profile:cached.profile,embedding:cached.embedding,model:cached.model,provider:cached.provider});continue;}
    const acoustic=JSON.stringify(song.acoustic_features||{});
    const prompt=basis==='INSTRUMENTAL_ACOUSTIC'
      ?`Instrumental track: ${song.title} — ${song.artist||'unknown'}\nAcoustic estimates: ${acoustic}\nSupported context:\n${String(song.context||'').slice(0,2000)}`
      :`Song: ${song.title} — ${song.artist||'unknown'}\nLyrics:\n${String(song.lyrics||'').slice(0,6000)}\nAcoustic estimates (optional, may contrast with lyrics): ${acoustic}\nContext:\n${String(song.context||'').slice(0,1000)}`; const started=Date.now();
    let generated;
    const system=basis==='INSTRUMENTAL_ACOUSTIC'?'Create a language-independent structured music vibe profile for an instrumental track. Ground it only in the acoustic estimates and supported context. Discuss rhythm, intensity, emotional character, pacing, texture, and tension only when supported. Never invent lyrics, vocals, instrumentation, scenes, transitions, or factual claims. Metrics are estimates and numeric dimensions must be from 0 to 1.':'Create a language-independent structured music vibe profile grounded primarily in the supplied lyrics, cautiously enriched by acoustic estimates. Allow lyrical and sonic character to contrast. Never map acoustic metrics directly to cinematic dimensions or invent factual claims. Numeric dimensions must be from 0 to 1.';
    try{generated=await generator.generateJson({stage:'song_profile',system,prompt,schema:profileSchema,validate:validateProfile,maxCompletionTokens:512});await writeAudit(env,{request_id:requestId,timestamp:new Date().toISOString(),stage:'song_profile',provider:generated.provider,model:generated.model,attempts:generated.attempts,input:prompt,system_prompt:system,output:generated.data,duration_ms:Date.now()-started,success:true});}catch(error){await writeAudit(env,{request_id:requestId,timestamp:new Date().toISOString(),stage:'song_profile',provider:error?.provider||'multiple',attempts:error?.attempts,input:prompt,duration_ms:Date.now()-started,success:false,error:String(error?.message||error)});throw error;}
    const document=basis==='INSTRUMENTAL_ACOUSTIC'?`Instrumental track: ${song.title} — ${song.artist||''}\nMusic profile: ${JSON.stringify(generated.data)}\nAcoustic characteristics: ${acoustic}\nSupported context: ${String(song.context||'').slice(0,1500)}`:`Song identity: ${song.title} — ${song.artist||''}\nLyrics: ${String(song.lyrics||'').slice(0,5000)}\nMusic profile: ${JSON.stringify(generated.data)}\nContext: ${String(song.context||'').slice(0,1500)}\nAcoustic features: ${acoustic}`;
    const embedding=await embedOrFallback(document,'song_embedding');
    if(song.song_id)try{await saveProfile(env.MOOVIBE_LIBRARY,song.song_id,{profile:generated.data,model:generated.model,lyricsHash,embedding,embeddingModel,dimensions});}catch(error){
      if(!isTransientPersistenceError(error))throw error;
      console.warn(JSON.stringify({event:'persistence_degraded',request_id:requestId,stage:'song_profile_persist',error_code:'D1_WRITE_QUOTA',error_class:error?.constructor?.name||'Error'}));
    }
    if(env.MOOVIBE_DB)try{await env.MOOVIBE_DB.put(profileCacheKey,JSON.stringify({profile:generated.data,embedding,model:generated.model,provider:generated.provider}),{expirationTtl:60*60*24*30});}catch(error){console.warn(JSON.stringify({event:'profile_cache_write_failed',request_id:requestId,stage:'song_profile',error_class:error?.constructor?.name||'Error'}));}
    perSong.push({profile:generated.data,embedding,model:generated.model,provider:generated.provider});
  }
  const numericKeys=['emotional_valence','energy','intimacy','surrealism','darkness','humor','romanticism','narrative_density','melancholy_level','tension_level'];
  /** @type {any} */ const combined={}; for(const key of ['moods','themes','atmosphere'])combined[key]=[...new Set(perSong.flatMap(x=>x.profile[key]||[]))].slice(0,12); combined.pace=perSong.map(x=>x.profile.pace).filter(Boolean).join(' / '); for(const key of numericKeys)combined[key]=perSong.reduce((sum,x)=>sum+Number(x.profile[key]||0),0)/perSong.length;
  const analysis={data:combined};
  const semantic=`Music profile\nSongs: ${songs.map(s=>s.analysis_basis==='INSTRUMENTAL_ACOUSTIC'?`${s.title} — ${s.artist||''}\nInstrumental acoustic analysis: ${JSON.stringify(s.acoustic_features||{})}\nContext: ${String(s.context||'').slice(0,800)}`:`${s.title} — ${s.artist||''}\nLyrics: ${String(s.lyrics||'').slice(0,2500)}\nAcoustic features: ${JSON.stringify(s.acoustic_features||{})}\nContext: ${String(s.context||'').slice(0,800)}`).join('\n\n')}\nProfile: ${JSON.stringify(analysis.data)}`;
  let vector=Array.isArray(perSong[0].embedding)?perSong[0].embedding:null;
  if(songs.length>1){
    const combinationKey=`music-combination-embedding:${SONG_EMBEDDING_DOCUMENT_VERSION}:${embeddingModel}:${dimensions}:${await sha256(semantic)}`;
    let cachedCombination=null;try{cachedCombination=await env.MOOVIBE_DB?.get(combinationKey,'json');}catch{}
    if(Array.isArray(cachedCombination?.values)&&cachedCombination.values.length===dimensions&&cachedCombination.values.every(Number.isFinite)){vector=cachedCombination.values;embeddingCacheHits++;}
    else {vector=await embedOrFallback(semantic,'song_combination_embedding');if(vector)try{await env.MOOVIBE_DB?.put(combinationKey,JSON.stringify({values:vector}),{expirationTtl:60*60*24*30});}catch(error){console.warn(JSON.stringify({event:'embedding_cache_write_failed',request_id:requestId,stage:'song_combination_embedding',error_class:error?.constructor?.name||'Error'}));}}
  }

  // CANAL A — semantic: music-profile embedding against Vectorize (top 100).
  let semanticMatches=[];
  if(vector&&env.MOVIE_VECTORS) { const result=await env.MOVIE_VECTORS.query(vector,{topK:SEMANTIC_TOP_K,returnValues:false,returnMetadata:'indexed'}); semanticMatches=result.matches||[]; }
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
  const excluded = new Set(excludedTmdbIds.map(Number));
  const ranked=rerank(movies.filter(movie => !excluded.has(Number(movie.tmdb_id))),analysis.data);
  const historical=applyRecommendationHistory(ranked,history);
  const slate=diversify(historical.ranked,CANDIDATE_LIMIT);
  if(slate.length<3) throw new Error('CATALOG_TOO_SMALL');
  const candidates=slate.map(compactCandidate);
  const diagnostics={
    semantic_count:semanticMatches.length,
    numeric_count:numericRows.length,
    union_count:merged.length,
    final_count:slate.length,
    keyword_fallback_count:keywordFallback,
    history_available:history.available,
    history_specific_count:history.specific.length,
    history_excluded_count:historical.excluded_count,
    history_global_penalized_count:historical.globally_penalized,
    history_relaxed:historical.relaxed,
    profile_cache_hits:profileCacheHits,
    embedding_cache_hits:embeddingCacheHits,
    embedding_fallback:embeddingFallback,
    semantic_retrieval_used:semanticMatches.length>0,
    generation_attempts:generator.getAttempts(),
    new_curation:true,
    top:ranked.slice(0,5).map(c=>({tmdb_id:c.tmdb_id,final_score:num(c.deterministic_score),components:{numeric:num(c.component_scores?.numeric),semantic:num(c.component_scores?.semantic),concepts:num(c.component_scores?.concepts),quality:num(c.component_scores?.quality),final:num(c.component_scores?.final)},channels:c.channels}))
  };
  console.log(JSON.stringify({event:'catalog_candidates',lang,semantic_count:diagnostics.semantic_count,numeric_count:diagnostics.numeric_count,union_count:diagnostics.union_count,final_count:diagnostics.final_count,keyword_fallback_count:keywordFallback,history_specific_count:diagnostics.history_specific_count,history_excluded_count:diagnostics.history_excluded_count,history_global_penalized_count:diagnostics.history_global_penalized_count,history_relaxed:diagnostics.history_relaxed,history_available:diagnostics.history_available,profile_cache_hits:profileCacheHits,embedding_cache_hits:embeddingCacheHits,new_curation:true,ranking:'deterministic',top:diagnostics.top}));
  let curation;
  try {
    const language=getLanguageConfig(lang); const allInstrumental=songs.every(s=>s.analysis_basis==='INSTRUMENTAL_ACOUSTIC'); const evidence=songs.map(s=>s.analysis_basis==='INSTRUMENTAL_ACOUSTIC'?`${s.title}: instrumental acoustic estimates ${JSON.stringify(s.acoustic_features||{})}`:`${s.title}: lyrical evidence ${String(s.lyrics||'').slice(0,900)}`).join('\n\n'); const curationCandidates=candidates.slice(0,12).map(candidate=>({...candidate,overview:truncate(candidate.overview,320)})); const curatorPrompt=`Music profile:\n${JSON.stringify(analysis.data)}\n\nMusic evidence:\n${evidence}\n\nAllowed candidates:\n${JSON.stringify(curationCandidates)}`; const curatorSystem=buildCuratorSystem(language.aiName)+(allInstrumental?' All selected tracks are instrumental. Never mention lyrics, verses, a lyrical speaker, vocals, instruments, tempo changes, or structures not explicitly supported. Connect film through supported rhythm, intensity, scale, quietness, tension, emotional character, or productive contrast.':' Treat each song according to its stated evidence; never attribute lyrics to an instrumental track.');
    const validateCurationOutput=data=>{
      if(!data||typeof data!=='object'||Array.isArray(data))return{ok:false,error:'curation must be an object'};
      if(typeof data.justification!=='string'||data.justification.length<320||data.justification.length>950)return{ok:false,error:'invalid justification length'};
      if(isWeakJustification(data.justification))return{ok:false,error:'justification is generic or not interpretive'};
      if(typeof data.vibe_title!=='string')return{ok:false,error:'invalid vibe title'};
      if(!Array.isArray(data.tags)||data.tags.length!==4||data.tags.some(value=>typeof value!=='string'))return{ok:false,error:'invalid tags'};
      if(!Array.isArray(data.alternative_calls)||data.alternative_calls.length!==2||data.alternative_calls.some(value=>typeof value!=='string'))return{ok:false,error:'invalid alternative calls'};
      try{validateCuration(data,curationCandidates,historical.forbidden_primary_ids);return{ok:true};}catch(error){return{ok:false,error:error.message};}
    };
    const evidenceKeys=await Promise.all(songs.map(async song=>sha256(JSON.stringify({lyrics:song.lyrics_hash||await sha256(song.lyrics||''),acoustic:song.acoustic_features||null,basis:song.analysis_basis||'LYRICAL'}))));
    const curationKey=`recommendation-curation:v1:${await sha256(JSON.stringify({lang,profile:analysis.data,evidenceKeys,candidates:curationCandidates,forbidden:historical.forbidden_primary_ids,contract:'curation-v1'}))}`;
    let result=null,curationCacheHit=false;
    if(env.MOOVIBE_DB)try{
      const cached=await env.MOOVIBE_DB.get(curationKey,'json');
      if(cached&&validateCurationOutput(cached.data).ok&&['gemini','groq'].includes(cached.provider)&&typeof cached.model==='string'){
        result={data:cached.data,provider:cached.provider,model:cached.model,attempts:0};
        curationCacheHit=true;
      }else if(cached){
        console.warn(JSON.stringify({event:'curation_cache_invalid',request_id:requestId,stage:'final_curation'}));
        await env.MOOVIBE_DB.delete(curationKey);
      }
    }catch(error){console.warn(JSON.stringify({event:'curation_cache_read_failed',request_id:requestId,stage:'final_curation',error_class:error?.constructor?.name||'Error'}));}
    if(!result){
      result=await generator.generateJson({stage:'final_curation',system:curatorSystem,prompt:curatorPrompt,schema:curationSchema,validate:validateCurationOutput,maxCompletionTokens:1024});
      if(env.MOOVIBE_DB)try{await env.MOOVIBE_DB.put(curationKey,JSON.stringify({data:result.data,provider:result.provider,model:result.model}),{expirationTtl:60*60*6});}catch(error){console.warn(JSON.stringify({event:'curation_cache_write_failed',request_id:requestId,stage:'final_curation',error_class:error?.constructor?.name||'Error'}));}
    }
    await writeAudit(env,{request_id:requestId,timestamp:new Date().toISOString(),stage:'final_curation',provider:result.provider,model:result.model,attempts:result.attempts,cache_hit:curationCacheHit,input:curatorPrompt,system_prompt:curatorSystem,output:result.data,success:true});
    curation=keepJustificationPrimaryOnly(validateCuration(result.data,curationCandidates,historical.forbidden_primary_ids),slate,lang,analysis.data);
    diagnostics.curation_cache_hit=curationCacheHit;
    if(isWeakJustification(curation.justification))console.warn(JSON.stringify({event:'weak_justification',request_id:requestId,length:String(curation.justification||'').length}));
  } catch(error) {
    await writeAudit(env,{request_id:requestId,timestamp:new Date().toISOString(),stage:'final_curation',provider:error?.provider||'multiple',attempts:error?.attempts,success:false,error:String(error?.message||error)});
    if (requireCuration) throw error;
    // Deterministic fallback: never search externally for a replacement.
    const fallback=FALLBACK_ALTERNATIVE_CALLS[lang]||FALLBACK_ALTERNATIVE_CALLS.en; curation={primary_tmdb_id:Number(slate[0].tmdb_id),alternative_tmdb_ids:slate.slice(1,3).map(x=>Number(x.tmdb_id)),justification:buildFallbackJustification(analysis.data,slate[0],lang),vibe_title:'CINEMATIC ECHO',tags:[...(analysis.data.moods||[]),...(analysis.data.atmosphere||[])].slice(0,4).map(x=>String(x).toUpperCase()),alternative_calls:fallback};
  }
  const byId=new Map(slate.map(m=>[Number(m.tmdb_id),m]));
  const selected=[byId.get(curation.primary_tmdb_id),...curation.alternative_tmdb_ids.map(id=>byId.get(id))].filter(Boolean);
  const hydrated=await Promise.all(selected.map((movie,index)=>hydrateMoviePresentation(env,movie,lang,{includeStills:index===0})));
  diagnostics.generation_attempts=generator.getAttempts();
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

export function selectBestStills(backdrops,limit=3,{posterPath=''}={}) {
  const stillQuality=(a,b)=>Number(b.vote_count||0)-Number(a.vote_count||0)||Number(b.vote_average||0)-Number(a.vote_average||0)||(Number(b.width||0)*Number(b.height||0))-(Number(a.width||0)*Number(a.height||0))||String(a.file_path).localeCompare(String(b.file_path));
  const sufficient=image=>Number(image.width||0)>=1280&&Number(image.height||0)>=720;
  const credibleTagged=image=>sufficient(image)&&Number(image.vote_count||0)>=2&&Number(image.vote_average||0)>=5.5;
  const byPath=new Map();
  for(const image of validImages(backdrops))if(image.file_path!==posterPath){const current=byPath.get(image.file_path);if(!current||(sufficient(image)&&!sufficient(current))||(sufficient(image)===sufficient(current)&&stillQuality(image,current)<0))byPath.set(image.file_path,image);}
  const spread=pool=>{const sorted=pool.sort(stillQuality).slice(0,20);if(sorted.length<=limit)return sorted;const indexes=limit===1?[0]:Array.from({length:limit},(_,index)=>Math.round(index*(sorted.length-1)/(limit-1)));return indexes.map(index=>sorted[index]);};
  const unique=[...byPath.values()],allNeutral=unique.filter(image=>normalizeLanguage(image.iso_639_1)==null&&sufficient(image));
  const credibleNeutral=allNeutral.filter(image=>Number(image.vote_count||0)>=2),neutral=credibleNeutral.length>=limit?credibleNeutral:allNeutral;
  const selected=spread(neutral).slice(0,limit),selectedPaths=new Set(selected.map(image=>image.file_path));
  if(selected.length<limit){const tagged=spread(unique.filter(image=>normalizeLanguage(image.iso_639_1)!=null&&credibleTagged(image)&&!selectedPaths.has(image.file_path)));selected.push(...tagged.slice(0,limit-selected.length));}
  return selected;
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
    const posterPath=poster?.file_path||images?.poster_path||movie.poster_path||null;
    images={poster_path:posterPath,stills:selectBestStills(data.backdrops,3,{posterPath}).map(image=>image.file_path),complete:true};
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
