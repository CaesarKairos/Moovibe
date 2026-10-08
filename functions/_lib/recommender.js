export const RECOMMENDER_VERSION = 'catalog-v4-song-identity';
export const EMBEDDING_SCHEMA_VERSION = 'movie-v1';

// Candidate generation limits: each channel contributes up to 100 candidates,
// the deduped union is scored, softly diversified and cut to CANDIDATE_LIMIT.
export const SEMANTIC_TOP_K = 100;
export const NUMERIC_TOP_K = 100;
export const CANDIDATE_LIMIT = 100;

// Composite score weights. Numeric vibe similarity deliberately dominates so a
// single embedding can never own the ranking. Popularity/vote_count are NOT
// scoring components: vote_count only breaks ties when ordering the numeric
// channel, and being obscure is neither rewarded nor punished.
export const SCORE_WEIGHTS = { numericVibe: 0.5, semantic: 0.35, concepts: 0.1, quality: 0.05 };

// The shared 0..1 vibe dimensions present on both movies and music profiles.
export const VIBE_DIMENSIONS = ['emotional_valence','energy','intimacy','surrealism','darkness','humor','romanticism','narrative_density','melancholy_level','tension_level'];

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

// similarity = 1 - |movie - song| for a single dimension.
export function dimensionSimilarity(movieValue, songValue) {
  return 1 - Math.abs(clamp(movieValue) - clamp(songValue));
}

// Mean of dimension similarities across the shared vibe dimensions.
export function numericVibeSimilarity(enrichment, profile) {
  const e = enrichment || {};
  let sum = 0;
  for (const dim of VIBE_DIMENSIONS) sum += dimensionSimilarity(e[dim], profile[dim]);
  return sum / VIBE_DIMENSIONS.length;
}

// Composite score: components are computed explicitly (and exposed on
// component_scores for debug/observability) then combined with SCORE_WEIGHTS.
// Missing embeddings use a neutral semantic value for scoring while remaining
// null in component_scores. Fixed weights prevent absence of data from
// improving a candidate through renormalization while keeping numeric-only
// movies eligible during catalog backfill.
export function scoreCandidate(candidate, profile) {
  const e = candidate.enrichment || {};
  const hasEnrichment = e.confidence !== undefined && e.confidence !== null;
  const numeric = numericVibeSimilarity(e, profile);
  const concepts = (overlap(e.moods, profile.moods) + overlap(e.themes, profile.themes) + overlap(e.atmosphere, profile.atmosphere)) / 3;
  const dataQuality = [candidate.overview, candidate.poster_path, candidate.release_year, candidate.director].filter(Boolean).length / 4;
  const quality = clamp(0.5 * (hasEnrichment ? clamp(e.confidence) : 0) + 0.5 * dataQuality);
  const semanticPresent = candidate.vector_score !== undefined && candidate.vector_score !== null;
  const semantic = semanticPresent ? clamp(candidate.vector_score) : null;
  const semanticForScore = semantic ?? 0.5;
  const final = SCORE_WEIGHTS.numericVibe * numeric + SCORE_WEIGHTS.semantic * semanticForScore + SCORE_WEIGHTS.concepts * concepts + SCORE_WEIGHTS.quality * quality;
  candidate.component_scores = { numeric, semantic, concepts, quality, final };
  return final;
}

export function rerank(candidates, profile) {
  // Fully deterministic: score descending, tmdb_id ascending as tie-break.
  // Score first so component_scores is captured by the copy below.
  return candidates.map(c => { const deterministic_score = scoreCandidate(c, profile); return { ...c, deterministic_score }; })
    .sort((a,b) => (b.deterministic_score - a.deterministic_score) || (Number(a.tmdb_id) - Number(b.tmdb_id)));
}

export function diversify(ranked, limit = CANDIDATE_LIMIT) {
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

// Gemini is a curator, never a search engine: every selected id must exist in
// the supplied candidate set, there must be exactly 2 distinct alternatives and
// all ids must be integers. Any violation throws and triggers the
// deterministic fallback in catalog.js.
export function validateCuration(curation, candidates) {
  const allowed = new Set(candidates.map(c => Number(c.tmdb_id)));
  const primary = Number(curation?.primary_tmdb_id);
  const alternatives = Array.isArray(curation?.alternative_tmdb_ids) ? curation.alternative_tmdb_ids.map(Number) : [];
  if (!Number.isInteger(primary) || alternatives.length !== 2 || alternatives.some(a => !Number.isInteger(a)))
    throw new Error('Gemini curation rejected: expected 1 primary and 2 alternative integer ids');
  if (!allowed.has(primary) || alternatives.some(id => !allowed.has(id)))
    throw new Error('Gemini selected a movie outside candidate set');
  if (new Set([primary, ...alternatives]).size !== 3)
    throw new Error('Gemini curation rejected: primary and alternatives must be distinct');
  return { ...curation, primary_tmdb_id: primary, alternative_tmdb_ids: alternatives };
}

// Hybrid candidate union: semantic (Vectorize) matches carry vector_score and
// numeric (D1 vibe scan) matches carry numeric_score; a movie present in both
// channels keeps both signals on a single deduped entry.
export function mergeCandidateChannels(semanticMatches = [], numericRows = []) {
  const byId = new Map();
  for (const match of semanticMatches) {
    const id = Number(match.id ?? match.tmdb_id);
    if (!id) continue;
    byId.set(id, { tmdb_id: id, vector_score: match.score == null ? undefined : clamp(match.score), numeric_score: undefined, channels: ['semantic'] });
  }
  for (const row of numericRows) {
    const id = Number(row.tmdb_id);
    if (!id) continue;
    const current = byId.get(id);
    if (current) {
      current.numeric_score = Number(row.numeric_score);
      if (!current.channels.includes('numeric')) current.channels.push('numeric');
    } else {
      byId.set(id, { tmdb_id: id, vector_score: undefined, numeric_score: Number(row.numeric_score), channels: ['numeric'] });
    }
  }
  return [...byId.values()];
}

// Deterministic numeric channel: pure SQL over movie_enrichments, no embedding
// required. Ordering breaks ties by vote_count then tmdb_id (never random).
export function numericCandidateSql(profile, limit = NUMERIC_TOP_K) {
  const abs = VIBE_DIMENSIONS.map(dim => `ABS(COALESCE(e.${dim},0)-?)`).join('+');
  const sql = `SELECT m.tmdb_id, ROUND(1-(${abs})/${VIBE_DIMENSIONS.length},6) AS numeric_score
    FROM movie_enrichments e JOIN movies m ON m.id=e.movie_id
    WHERE m.collection_status='complete'
    ORDER BY numeric_score DESC, COALESCE(m.vote_count,0) DESC, m.tmdb_id ASC
    LIMIT ?`;
  const binds = [...VIBE_DIMENSIONS.map(dim => clamp(profile[dim])), limit];
  return { sql, binds };
}

export function recommendationCacheKey(songs, lang='en', version=RECOMMENDER_VERSION) {
  const normalized = songs.slice(0,3).map(s => `${s.provider||''}:${s.provider_id||s.lrclib_id||''}::${String(s.title||'').trim().toLowerCase()}::${String(s.artist||'').trim().toLowerCase()}`);
  const source=normalized.join('|'); let h1=0x811c9dc5,h2=0x9e3779b9;
  for(let i=0;i<source.length;i++){h1=Math.imul(h1^source.charCodeAt(i),0x01000193);h2=Math.imul(h2^source.charCodeAt(i),0x85ebca6b);}
  return `recommendation:${version}:${lang}:${(h1>>>0).toString(16)}${(h2>>>0).toString(16)}`;
}
