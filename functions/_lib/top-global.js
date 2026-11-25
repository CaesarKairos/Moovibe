import { SOURCES, trackMovement, validateRanking } from './top-global-source.js';
import { recommendFromCatalog, movieToLegacy } from './catalog.js';
import { findSong } from './song-library.js';
import { LRCLIB_URL, lrclibHeaders } from './lrclib.js';
import { getSpotifyAccessToken } from './spotify.js';
import { normalizeMusicText } from './music-match.js';

export const SNAPSHOT = 'top-global:public:v1';
const query = (db, sql, ...values) => db.prepare(sql).bind(...values);
const dailyLimit = env => Math.max(0, Math.min(5, Number(env.TOP_GLOBAL_DAILY_ATTEMPTS ?? 0) || 0));

async function activeTracks(db) {
  return (await query(db, 'SELECT * FROM top_global_tracks WHERE position IS NOT NULL ORDER BY position').all()).results;
}

export async function topGlobalStatus(env) {
  const db = env.MOOVIBE_LIBRARY;
  const state = await query(db, 'SELECT * FROM top_global_state WHERE id=1').first();
  const tracks = await activeTracks(db);
  return {
    source:state.source, reference_date:state.reference_date, updated_at:state.updated_at,
    source_status:'authorized_import', next_update:null,
    paused:Boolean(state.paused), allow_duplicates:Boolean(state.allow_duplicates),
    attempts:state.budget_day === new Date().toISOString().slice(0,10) ? state.attempts : 0,
    daily_limit:dailyLimit(env), pending:tracks.filter(track => track.pending).length,
    associated:tracks.filter(track => track.tmdb_id).length,
    tracks:tracks.map(({spotify_id, position, title, artist, pending, failure, attempted_at}) =>
      ({spotify_id, position, title, artist, pending, failure, attempted_at})),
  };
}

async function publish(env) {
  const db = env.MOOVIBE_LIBRARY;
  const state = await query(db, 'SELECT source,reference_date,updated_at FROM top_global_state WHERE id=1').first();
  if (!state.source) return;
  const tracks = (await activeTracks(db)).map(({spotify_id, position, title, artist, cover, movement, delta, movie_json}) =>
    ({spotify_id, position, title, artist, cover, movement, delta, movie:movie_json ? JSON.parse(movie_json) : null}));
  if (tracks.length !== 50) throw Error('INCOMPLETE_RANKING');
  await env.MOOVIBE_DB.put(SNAPSHOT, JSON.stringify({...state, source_url:SOURCES[state.source], tracks}));
}

async function importRanking(env, input, state) {
  const ranking = validateRanking(input);
  if (state.reference_date && ranking.reference_date < state.reference_date) throw Error('STALE_RANKING');
  const db = env.MOOVIBE_LIBRARY;
  const rows = (await query(db, `SELECT spotify_id,position,tmdb_id,title,artist,cover,lrclib_id FROM top_global_tracks WHERE spotify_id IN (${ranking.tracks.map(() => '?').join(',')})`,
    ...ranking.tracks.map(track => track.spotify_id)).all()).results;
  const previous = new Map(rows.map(row => [row.spotify_id, row]));
  const sameOrder = ranking.tracks.every(track => previous.get(track.spotify_id)?.position === track.position);
  const sameEdition = sameOrder && state.reference_date === ranking.reference_date && state.source === ranking.source;
  const statements = [];
  if (!sameOrder) statements.push(query(db, 'UPDATE top_global_tracks SET position=NULL WHERE position IS NOT NULL'));
  for (const track of ranking.tracks) {
    const old = previous.get(track.spotify_id);
    if (sameEdition && old.title===track.title && old.artist===track.artist && old.cover===track.cover &&
        (!track.lrclib_id || old.lrclib_id===track.lrclib_id)) continue;
    const [movement, delta] = trackMovement(old, track.position, Boolean(state.source));
    statements.push(query(db, `INSERT INTO top_global_tracks(spotify_id,position,title,artist,cover,lrclib_id,movement,delta)
      VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(spotify_id) DO UPDATE SET position=excluded.position,title=excluded.title,
      artist=excluded.artist,cover=excluded.cover,lrclib_id=COALESCE(excluded.lrclib_id,top_global_tracks.lrclib_id),
      movement=CASE WHEN ? THEN top_global_tracks.movement ELSE excluded.movement END,
      delta=CASE WHEN ? THEN top_global_tracks.delta ELSE excluded.delta END`,
    track.spotify_id,track.position,track.title,track.artist,track.cover,track.lrclib_id,movement,delta,Number(sameEdition),Number(sameEdition)));
  }
  if (!state.allow_duplicates) {
    const owners = new Set();
    for (const row of rows.sort((a,b) => (a.position ?? 51) - (b.position ?? 51))) {
      if (!row.tmdb_id) continue;
      if (owners.has(row.tmdb_id)) statements.push(clearConflict(db,row.spotify_id));
      owners.add(row.tmdb_id);
    }
  }
  if (!sameEdition) statements.push(query(db, 'UPDATE top_global_state SET source=?,reference_date=?,updated_at=? WHERE id=1',
    ranking.source,ranking.reference_date,new Date().toISOString()));
  if (statements.length) await db.batch(statements);
}

const clearConflict = (db,id) => query(db, 'UPDATE top_global_tracks SET tmdb_id=NULL,movie_json=NULL,pending=1,failure=NULL WHERE spotify_id=?',id);

async function retireMissingMovies(db) {
  const {results} = await query(db, `SELECT t.spotify_id FROM top_global_tracks t
    LEFT JOIN movies m ON m.tmdb_id=t.tmdb_id
    WHERE t.position IS NOT NULL AND t.tmdb_id IS NOT NULL AND m.tmdb_id IS NULL
    ORDER BY t.position`).all();
  if (results.length) await db.batch(results.map(row => clearConflict(db,row.spotify_id)));
}

async function independentEvidence(db, id) {
  if (!id) throw Error('LRCLIB_ID_REQUIRED');
  const response = await fetch(`${LRCLIB_URL}/get/${id}`, {headers:lrclibHeaders(),signal:AbortSignal.timeout(8000)});
  if (!response.ok) throw Error('LRCLIB_UNAVAILABLE');
  const data = await response.json();
  const lyrics = data.plainLyrics?.trim();
  if (String(data.id) !== id || !data.trackName || !data.artistName || !lyrics) throw Error('LRCLIB_EVIDENCE_UNAVAILABLE');
  const identity = {provider:'lrclib', provider_id:id, lrclib_id:id, title:data.trackName, artist:data.artistName};
  const cached = await findSong(db, identity);
  return {...identity, lyrics, song_id:cached?.id, analysis_basis:'LYRICAL'};
}

async function processOne(env, state, tracks) {
  if (state.paused) throw Error('PROCESSING_PAUSED');
  const db = env.MOOVIBE_LIBRARY;
  const day = new Date().toISOString().slice(0,10);
  const attempts = state.budget_day === day ? state.attempts : 0;
  if (attempts >= dailyLimit(env)) throw Error('DAILY_BUDGET_UNAVAILABLE');
  const row = tracks.filter(track => track.pending && track.lrclib_id && !track.attempted_at?.startsWith(day))
    .sort((a,b) => a.spotify_id.localeCompare(b.spotify_id))[0];
  if (!row) return;
  await db.batch([
    query(db, 'UPDATE top_global_state SET budget_day=?,attempts=? WHERE id=1',day,attempts+1),
    query(db, 'UPDATE top_global_tracks SET attempted_at=?,failure=NULL WHERE spotify_id=?',new Date().toISOString(),row.spotify_id),
  ]);
  let movie;
  try {
    const song = await independentEvidence(db,row.lrclib_id);
    if (normalizeMusicText(song.title,{stripVersion:false})!==normalizeMusicText(row.title,{stripVersion:false}) ||
        normalizeMusicText(song.artist)!==normalizeMusicText(row.artist)) throw Error('LRCLIB_IDENTITY_MISMATCH');
    const excludedTmdbIds = state.allow_duplicates ? [] : tracks.filter(track => track.spotify_id !== row.spotify_id && track.tmdb_id).map(track => track.tmdb_id);
    const result = await recommendFromCatalog({env,songs:[song],excludedTmdbIds,requireCuration:true});
    movie = movieToLegacy(result.primary);
  } catch (error) {
    const code = ['LRCLIB_UNAVAILABLE','LRCLIB_EVIDENCE_UNAVAILABLE','LRCLIB_IDENTITY_MISMATCH','CATALOG_TOO_SMALL'].includes(error?.message) ? error.message : 'RECOMMENDATION_FAILED';
    await query(db, 'UPDATE top_global_tracks SET failure=? WHERE spotify_id=?',code,row.spotify_id).run();
    return;
  }
  await query(db, 'UPDATE top_global_tracks SET tmdb_id=?,movie_json=?,pending=0,failure=NULL WHERE spotify_id=?',
    movie.id_tmdb,JSON.stringify({tmdb_id:movie.id_tmdb,title:movie.titulo_pt,original_title:movie.titulo_original,year:movie.ano,poster:movie.poster}),row.spotify_id).run();
}

export async function probeSpotifyPlaylist(env) {
  const token = await getSpotifyAccessToken(env);
  const statuses = {};
  for (const endpoint of ['items','tracks']) {
    const response = await fetch(`https://api.spotify.com/v1/playlists/37i9dQZEVXbMDoHDwVN2tF/${endpoint}?limit=1`,
      {headers:{authorization:`Bearer ${token}`},signal:AbortSignal.timeout(8000)});
    const data = response.ok ? await response.json() : null;
    statuses[endpoint] = {status:response.status, has_item:Boolean(data?.items?.[0]?.item || data?.items?.[0]?.track)};
  }
  return statuses;
}

export async function updateTopGlobal(env,input) {
  if (input.action === 'probe') return {spotify:await probeSpotifyPlaylist(env)};
  const db = env.MOOVIBE_LIBRARY;
  const lease = crypto.randomUUID();
  const lock = await query(db, `UPDATE top_global_state SET lease=?,lease_until=datetime('now','+10 minutes')
    WHERE id=1 AND (lease_until IS NULL OR lease_until<CURRENT_TIMESTAMP)`,lease).run();
  if (!lock.meta.changes) throw Error('UPDATE_IN_PROGRESS');
  try {
    const state = await query(db,'SELECT * FROM top_global_state WHERE id=1').first();
    const tracks = await activeTracks(db);
    switch (input.action) {
      case 'import':
        await importRanking(env,input,state);
        await retireMissingMovies(db);
        break;
      case 'process':
        if (state.paused) throw Error('PROCESSING_PAUSED');
        await retireMissingMovies(db);
        await processOne(env,state,await activeTracks(db));
        break;
      case 'pause': case 'resume':
        await query(db,'UPDATE top_global_state SET paused=? WHERE id=1',Number(input.action==='pause')).run();
        break;
      case 'duplicates': {
        if (typeof input.allow !== 'boolean') throw Error('INVALID_CONFIGURATION');
        const statements = [query(db,'UPDATE top_global_state SET allow_duplicates=? WHERE id=1',Number(input.allow))];
        const owners = new Set();
        if (!input.allow) for (const row of tracks) {
          if (!row.tmdb_id) continue;
          if (owners.has(row.tmdb_id)) statements.push(clearConflict(db,row.spotify_id));
          owners.add(row.tmdb_id);
        }
        await db.batch(statements);
        break;
      }
      case 'regenerate':
        if (!tracks.some(track=>track.spotify_id===input.spotify_id)) throw Error('UNKNOWN_TRACK');
        await query(db,'UPDATE top_global_tracks SET pending=1 WHERE spotify_id=?',input.spotify_id).run();
        break;
      case 'regenerate_all':
        if (input.confirm !== true) throw Error('CONFIRMATION_REQUIRED');
        await query(db,'UPDATE top_global_tracks SET pending=1 WHERE position IS NOT NULL').run();
        break;
      default: throw Error('UNKNOWN_ACTION');
    }
    await publish(env);
    return topGlobalStatus(env);
  } finally {
    await query(db,'UPDATE top_global_state SET lease=NULL,lease_until=NULL WHERE id=1 AND lease=?',lease).run();
  }
}
