const TOKEN_URL='https://accounts.spotify.com/api/token',API_URL='https://api.spotify.com/v1',TRACK_ID=/^[A-Za-z0-9]{22}$/;
let cachedAccessToken='',expiresAt=0;
export function parseSpotifyTrackInput(value){
  const raw=String(value||'').trim(),uri=raw.match(/^spotify:([^:]+):([^:]+)$/i);
  if(uri)return uri[1].toLowerCase()==='track'&&TRACK_ID.test(uri[2])?{kind:'track',id:uri[2]}:{kind:'not_track'};
  let url;try{url=new URL(raw)}catch{return null}
  const host=url.hostname.toLowerCase();
  if(url.protocol!=='https:'||!['open.spotify.com','spotify.link'].includes(host))return {kind:'invalid_url'};
  if(host==='spotify.link')return {kind:'short_url',url:url.href};
  const parts=url.pathname.split('/').filter(Boolean);
  const direct=parts.length===2&&parts[0]==='track';
  const localized=parts.length===3&&/^intl-[a-z]+(?:-[a-z]+)*$/i.test(parts[0])&&parts[1]==='track';
  const id=direct?parts[1]:localized?parts[2]:'';
  return (direct||localized)&&TRACK_ID.test(id)?{kind:'track',id}:{kind:'not_track'};
}
export function mapSpotifyTrack(track){return {provider:'spotify',provider_id:String(track?.id||''),title:String(track?.name||''),artist:String(track?.artists?.[0]?.name||''),artists:(track?.artists||[]).map(x=>String(x.name||'')).filter(Boolean),album:String(track?.album?.name||''),duration:Number(track?.duration_ms||0)/1000,external_url:String(track?.external_urls?.spotify||''),isrc:track?.external_ids?.isrc||null,lrclib_id:null};}
export async function getSpotifyAccessToken(env,force=false){if(!env?.SPOTIFY_CLIENT_ID||!env?.SPOTIFY_CLIENT_SECRET)throw Error('SPOTIFY_UNAVAILABLE');if(!force&&cachedAccessToken&&Date.now()<expiresAt-60000)return cachedAccessToken;const response=await fetch(TOKEN_URL,{method:'POST',headers:{authorization:`Basic ${btoa(`${env.SPOTIFY_CLIENT_ID}:${env.SPOTIFY_CLIENT_SECRET}`)}`,'content-type':'application/x-www-form-urlencoded'},body:'grant_type=client_credentials'});if(!response.ok)throw Error('SPOTIFY_AUTH_FAILED');const data=await response.json();cachedAccessToken=String(data.access_token||'');expiresAt=Date.now()+Number(data.expires_in||3600)*1000;if(!cachedAccessToken)throw Error('SPOTIFY_AUTH_FAILED');return cachedAccessToken;}
async function spotifyFetch(env,path,retry=true){const token=await getSpotifyAccessToken(env),response=await fetch(API_URL+path,{headers:{authorization:`Bearer ${token}`}});if(response.status===401&&retry){cachedAccessToken='';expiresAt=0;await getSpotifyAccessToken(env,true);return spotifyFetch(env,path,false)}if(response.status===429){const retryAfter=Math.min(5,Math.max(1,Number(response.headers.get('retry-after'))||1));if(retry){await new Promise(resolve=>setTimeout(resolve,retryAfter*1000));return spotifyFetch(env,path,false)}const error=Error('SPOTIFY_RATE_LIMITED');error.retryAfter=retryAfter;throw error}if(!response.ok)throw Error(response.status===404?'SPOTIFY_TRACK_NOT_FOUND':'SPOTIFY_UNAVAILABLE');return response.json();}
export async function searchSpotifyTracks(env,query,limit=8){const data=await spotifyFetch(env,`/search?type=track&limit=${Math.min(8,Math.max(1,limit))}&q=${encodeURIComponent(String(query||'').slice(0,200))}`);return (data?.tracks?.items||[]).map(mapSpotifyTrack).filter(x=>x.provider_id&&x.title&&x.artist);}
export async function getSpotifyTrack(env,id){if(!TRACK_ID.test(String(id||'')))throw Error('NOT_A_TRACK');return mapSpotifyTrack(await spotifyFetch(env,`/tracks/${encodeURIComponent(id)}`));}
export async function resolveSpotifyTrackUrl(env,value){let parsed=parseSpotifyTrackInput(value);if(!parsed)return null;if(['invalid_url','not_track'].includes(parsed.kind))throw Error('NOT_A_TRACK');if(parsed.kind==='short_url'){const response=await fetch(parsed.url,{redirect:'manual'}),location=response.headers.get('location');if(!location)throw Error('NOT_A_TRACK');parsed=parseSpotifyTrackInput(new URL(location,parsed.url).href);if(!parsed||parsed.kind!=='track')throw Error('NOT_A_TRACK')}return getSpotifyTrack(env,parsed.id);}
export function resetSpotifyTokenForTests(){cachedAccessToken='';expiresAt=0;}
