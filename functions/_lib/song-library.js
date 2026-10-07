import { normalizeMusicText } from './music-match.js';

export const SONG_PROFILE_SCHEMA_VERSION='song-v1';
export function isD1WriteQuotaError(error) {
  const message=String(error?.message||error||'').toLowerCase();
  return /d1/.test(message)&&/(quota|limit|too many writes|row writes|exceeded)/.test(message);
}
export function isTransientPersistenceError(error) {
  const message=String(error?.message||error||'').toLowerCase();
  return isD1WriteQuotaError(error)||/(timeout|temporar|unavailable|busy|locked|429|502|503|504)/.test(message);
}
export const MIN_USER_LYRICS=80;
export const MAX_LYRICS=20000;
const encoder=new TextEncoder();
export async function sha256(value) { const bytes=await crypto.subtle.digest('SHA-256',encoder.encode(String(value))); return [...new Uint8Array(bytes)].map(x=>x.toString(16).padStart(2,'0')).join(''); }
export function canonicalSongKey(song) { return song.lrclib_id?`lrclib:${song.lrclib_id}`:`text:${normalizeMusicText(song.title)}|${normalizeMusicText(song.artist)}`; }
export function validateUserLyrics(value) { const lyrics=typeof value==='string'?value.trim():''; if(lyrics.length<MIN_USER_LYRICS||lyrics.length>MAX_LYRICS)throw new Error('INVALID_LYRICS'); return lyrics; }
export async function findSong(db,song) {
  if(!db)return null;
  return db.prepare(`SELECT s.*,l.lyrics,l.source lyrics_source,l.source_reference,l.content_hash FROM songs s LEFT JOIN song_lyrics l ON l.song_id=s.id WHERE s.canonical_key=? OR (? IS NOT NULL AND s.lrclib_id=?) ORDER BY s.lrclib_id IS NOT NULL DESC LIMIT 1`).bind(canonicalSongKey(song),song.lrclib_id||null,song.lrclib_id||null).first();
}
export async function persistLyrics(db,song,lyrics,source,sourceReference=null) {
  if(!db||!lyrics)return null; const clean=String(lyrics).trim().slice(0,MAX_LYRICS); const hash=await sha256(clean); const key=canonicalSongKey(song);
  await db.prepare(`INSERT INTO songs(canonical_key,lrclib_id,title,artist,album,duration) VALUES(?,?,?,?,?,?) ON CONFLICT(canonical_key) DO UPDATE SET lrclib_id=COALESCE(excluded.lrclib_id,songs.lrclib_id),title=excluded.title,artist=excluded.artist,album=COALESCE(excluded.album,songs.album),duration=COALESCE(excluded.duration,songs.duration),updated_at=CURRENT_TIMESTAMP`).bind(key,song.lrclib_id||null,song.title,song.artist||'',song.album||null,song.duration||null).run();
  const row=await findSong(db,song);
  await db.prepare(`INSERT INTO song_lyrics(song_id,lyrics,source,source_reference,content_hash) VALUES(?,?,?,?,?) ON CONFLICT(song_id) DO UPDATE SET lyrics=excluded.lyrics,source=excluded.source,source_reference=excluded.source_reference,content_hash=excluded.content_hash,updated_at=CURRENT_TIMESTAMP WHERE song_lyrics.content_hash<>excluded.content_hash OR song_lyrics.source<>excluded.source`).bind(row.id,clean,source,sourceReference,hash).run();
  return {...row,lyrics:clean,lyrics_source:source,content_hash:hash};
}
export async function persistLyricsBestEffort(db,song,lyrics,source,sourceReference=null,onDegraded=()=>{}) {
  try{return await persistLyrics(db,song,lyrics,source,sourceReference);}catch(error){if(!isTransientPersistenceError(error))throw error;onDegraded(error);return null;}
}
export async function loadProfile(db,songId,{lyricsHash,schemaVersion=SONG_PROFILE_SCHEMA_VERSION,embeddingModel,dimensions}) {
  if(!db||!songId)return null; const row=await db.prepare(`SELECT * FROM song_profiles WHERE song_id=? AND source_lyrics_hash=? AND schema_version=? AND embedding_model=? AND embedding_dimensions=?`).bind(songId,lyricsHash,schemaVersion,embeddingModel,dimensions).first();
  if(!row)return null; try{return {...row,profile:JSON.parse(row.profile_json),embedding:JSON.parse(row.embedding_json)}}catch{return null;}
}
export async function saveProfile(db,songId,{profile,model,lyricsHash,schemaVersion=SONG_PROFILE_SCHEMA_VERSION,embedding,embeddingModel,dimensions}) {
  await db.prepare(`INSERT INTO song_profiles(song_id,profile_json,model,schema_version,source_lyrics_hash,embedding_json,embedding_model,embedding_dimensions) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(song_id) DO UPDATE SET profile_json=excluded.profile_json,model=excluded.model,schema_version=excluded.schema_version,source_lyrics_hash=excluded.source_lyrics_hash,embedding_json=excluded.embedding_json,embedding_model=excluded.embedding_model,embedding_dimensions=excluded.embedding_dimensions,updated_at=CURRENT_TIMESTAMP`).bind(songId,JSON.stringify(profile),model,schemaVersion,lyricsHash,JSON.stringify(embedding),embeddingModel,dimensions).run();
}
