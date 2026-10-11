import { canonicalSongKey,sha256 } from './song-library.js';

export const SPECIFIC_HISTORY_LIMIT=10;
export const GLOBAL_HISTORY_LIMIT=20;
export const GLOBAL_REPEAT_PENALTY=.025;

export async function musicHistoryKey(songs) {
  const identities=songs.map(song=>song.song_id?`song:${song.song_id}`:canonicalSongKey({...song,identity_confirmed:true})).sort();
  return `music:${await sha256(identities.join('|'))}`;
}

const ids=rows=>(rows||[]).map(row=>Number(row.primary_tmdb_id)).filter(Boolean);

export async function readRecommendationHistory(db,musicKey) {
  if(!db)return {specific:[],global:[],available:false,error_code:'D1_HISTORY_UNAVAILABLE'};
  try{
    const [specific,global]=await Promise.all([
      db.prepare(`SELECT primary_tmdb_id,MAX(created_at) last_seen FROM recommendation_events WHERE music_key=? AND success=1 AND primary_tmdb_id IS NOT NULL GROUP BY primary_tmdb_id ORDER BY last_seen DESC LIMIT ?`).bind(musicKey,SPECIFIC_HISTORY_LIMIT).all(),
      db.prepare(`SELECT primary_tmdb_id,MAX(created_at) last_seen FROM recommendation_events WHERE success=1 AND primary_tmdb_id IS NOT NULL GROUP BY primary_tmdb_id ORDER BY last_seen DESC LIMIT ?`).bind(GLOBAL_HISTORY_LIMIT).all()
    ]);
    return {specific:ids(specific.results),global:ids(global.results),available:true,error_code:null};
  }catch(error){
    console.warn(JSON.stringify({event:'recommendation_history_degraded',stage:'history_read',error_code:'D1_HISTORY_READ_FAILED',error_class:error?.constructor?.name||'Error'}));
    return {specific:[],global:[],available:false,error_code:'D1_HISTORY_READ_FAILED'};
  }
}

export function applyRecommendationHistory(ranked,{specific=[],global=[]}={}) {
  const forbidden=new Set(specific.map(Number)),globalRank=new Map(global.map((id,index)=>[Number(id),index]));
  const eligible=ranked.filter(movie=>!forbidden.has(Number(movie.tmdb_id)));
  let pool=eligible,relaxed=false;
  if(pool.length<3){
    relaxed=true;
    const mostRecent=Number(specific[0]);
    const older=[...ranked].filter(movie=>forbidden.has(Number(movie.tmdb_id))&&Number(movie.tmdb_id)!==mostRecent).sort((a,b)=>specific.indexOf(Number(b.tmdb_id))-specific.indexOf(Number(a.tmdb_id)));
    pool=[...eligible,...older.slice(0,Math.max(0,3-eligible.length))];
    if(pool.length<3)pool.push(...ranked.filter(movie=>Number(movie.tmdb_id)===mostRecent));
  }
  const adjusted=pool.map(movie=>{
    const position=globalRank.get(Number(movie.tmdb_id));
    const penalty=position==null?0:GLOBAL_REPEAT_PENALTY*(1-position/GLOBAL_HISTORY_LIMIT);
    return {...movie,history_penalty:penalty,history_adjusted_score:movie.deterministic_score-penalty};
  }).sort((a,b)=>(b.history_adjusted_score-a.history_adjusted_score)||(b.deterministic_score-a.deterministic_score)||(Number(a.tmdb_id)-Number(b.tmdb_id)));
  if(relaxed&&specific.length){const mostRecent=Number(specific[0]),index=adjusted.findIndex(movie=>Number(movie.tmdb_id)===mostRecent);if(index>=0)adjusted.push(...adjusted.splice(index,1));}
  return {ranked:adjusted,excluded_count:ranked.length-pool.length,globally_penalized:adjusted.filter(x=>x.history_penalty>0).length,relaxed,forbidden_primary_ids:relaxed?new Set(specific.slice(0,1).map(Number)):forbidden};
}
