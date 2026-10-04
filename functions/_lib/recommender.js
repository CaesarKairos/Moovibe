export const RECOMMENDER_VERSION = 'catalog-v2';
export const EMBEDDING_SCHEMA_VERSION = 'movie-v1';

const arr = value => { try { return Array.isArray(value) ? value : JSON.parse(value || '[]'); } catch { return []; } };
const clamp = value => Math.max(0, Math.min(1, Number(value) || 0));

export function buildMovieDocument(movie) {
  const e = movie.enrichment || {};
  const lines = [
    `Film: ${movie.title}${movie.original_title && movie.original_title !== movie.title ? ` / ${movie.original_title}` : ''}`,
    `Year: ${movie.release_year || 'unknown'}`,
    `Countries: ${arr(movie.countries).join(', ') || 'unknown'}`,
    `Languages: ${arr(movie.languages).join(', ') || movie.original_language || 'unknown'}`,
    `Genres: ${arr(movie.genres).join(', ')}`,
    `Keywords: ${arr(movie.keywords).join(', ')}`,
    `Overview: ${movie.overview || ''}`,
    `Themes: ${arr(e.themes).join(', ')}`,
    `Moods: ${arr(e.moods).join(', ')}`,
    `Atmosphere: ${arr(e.atmosphere).join(', ')}`,
    `Pace: ${e.pace || 'unknown'}`,
    `Visual style: ${arr(e.visual_style).join(', ')}`,
    `Emotional dimensions (0..1): valence=${clamp(e.emotional_valence)}, energy=${clamp(e.energy)}, intimacy=${clamp(e.intimacy)}, surrealism=${clamp(e.surrealism)}, darkness=${clamp(e.darkness)}, humor=${clamp(e.humor)}, romanticism=${clamp(e.romanticism)}, narrative density=${clamp(e.narrative_density)}, melancholy=${clamp(e.melancholy_level)}, tension=${clamp(e.tension_level)}`
  ];
  return lines.join('\n').trim();
}

const overlap = (a,b) => {
  const aa = new Set(arr(a).map(x => String(x).toLowerCase()));
  const bb = new Set(arr(b).map(x => String(x).toLowerCase()));
  if (!aa.size || !bb.size) return 0;
  let n=0; for (const x of aa) if (bb.has(x)) n++;
  return n / Math.max(aa.size, bb.size);
};

export function scoreCandidate(candidate, profile) {
  const e = candidate.enrichment || {};
  const dims = ['emotional_valence','energy','intimacy','surrealism','darkness','humor','romanticism','narrative_density','melancholy_level','tension_level'];
  const dimensionScore = dims.reduce((sum,k) => sum + (1 - Math.abs(clamp(e[k]) - clamp(profile[k]))), 0) / dims.length;
  const semantic = clamp(candidate.vector_score);
  const concepts = (overlap(e.moods,profile.moods)+overlap(e.themes,profile.themes)+overlap(e.atmosphere,profile.atmosphere))/3;
  const confidence = clamp(e.confidence || 0.5);
  const dataQuality = [candidate.overview, candidate.poster_path, candidate.release_year, candidate.director].filter(Boolean).length / 4;
  const obscurityBonus = candidate.popularity != null ? Math.max(0, 1 - Math.log10(1 + candidate.popularity) / 3) : .5;
  return semantic*.58 + dimensionScore*.20 + concepts*.12 + confidence*.05 + dataQuality*.04 + obscurityBonus*.01;
}

export function rerank(candidates, profile) {
  return candidates.map(c => ({...c, deterministic_score: scoreCandidate(c,profile)})).sort((a,b)=>b.deterministic_score-a.deterministic_score);
}

export function diversify(ranked, limit = 12) {
  const selected=[];
  for (const candidate of ranked) {
    if (!selected.length) { selected.push(candidate); continue; }
    const decade = candidate.release_year ? Math.floor(candidate.release_year/10) : null;
    let similarity = 0;
    for (const prior of selected) {
      const sameCountry = overlap(candidate.countries, prior.countries);
      const sameGenre = overlap(candidate.genres, prior.genres);
      const sameDirector = candidate.director && candidate.director === prior.director ? 1 : 0;
      const sameDecade = decade && prior.release_year && decade === Math.floor(prior.release_year/10) ? 1 : 0;
      similarity = Math.max(similarity, sameCountry*.3 + sameGenre*.35 + sameDirector*.2 + sameDecade*.15);
    }
    candidate.diversified_score = candidate.deterministic_score - similarity*.12;
    const insertAt = selected.findIndex(x => (x.diversified_score ?? x.deterministic_score) < candidate.diversified_score);
    if (insertAt < 0) selected.push(candidate); else selected.splice(insertAt,0,candidate);
    if (selected.length > limit) selected.pop();
  }
  return selected;
}

export function validateCuration(curation, candidates) {
  const allowed = new Set(candidates.map(c => Number(c.tmdb_id)));
  const primary = Number(curation?.primary_tmdb_id);
  const alternatives = (curation?.alternative_tmdb_ids || []).map(Number);
  if (!allowed.has(primary) || alternatives.some(id => !allowed.has(id)) || new Set([primary,...alternatives]).size !== 1+alternatives.length) throw new Error('Gemini selected a movie outside candidate set');
  return { ...curation, primary_tmdb_id: primary, alternative_tmdb_ids: alternatives.slice(0,2) };
}

export function recommendationCacheKey(songs, lang='en', version=RECOMMENDER_VERSION) {
  const normalized = songs.slice(0,3).map(s => `${String(s.title||'').trim().toLowerCase()}::${String(s.artist||'').trim().toLowerCase()}::${s.lrclib_id||''}`);
  const source=normalized.join('|'); let h1=0x811c9dc5,h2=0x9e3779b9;
  for(let i=0;i<source.length;i++){h1=Math.imul(h1^source.charCodeAt(i),0x01000193);h2=Math.imul(h2^source.charCodeAt(i),0x85ebca6b);}
  return `recommendation:${version}:${lang}:${(h1>>>0).toString(16)}${(h2>>>0).toString(16)}`;
}
