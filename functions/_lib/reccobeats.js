import { scoreTrackMatch, selectBestTrack } from './music-match.js';

export const RECCOBEATS_BASE_URL='https://api.reccobeats.com/v1';
export const AUDIO_FEATURE_KEYS=Object.freeze(['danceability','energy','valence','tempo','acousticness','instrumentalness','speechiness','liveness','loudness']);
export const POSITIVE_TTL=7*24*60*60;
export const NEGATIVE_TTL=12*60*60;
const UNIT_INTERVAL=new Set(['danceability','energy','valence','acousticness','instrumentalness','speechiness','liveness']);

export class ReccoBeatsError extends Error {
  constructor(code,message=code,{status=null,retryAfter=null}={}){super(message);this.name='ReccoBeatsError';this.code=code;this.status=status;this.retryAfter=retryAfter;}
}

const finiteOrNull=value=>value===null||value===undefined?null:(Number.isFinite(Number(value))?Number(value):null);
export function normalizeAudioFeatures(raw={}) {
  const features={};
  for(const key of AUDIO_FEATURE_KEYS){
    const value=finiteOrNull(raw[key]);
    if(value===null){features[key]=null;continue;}
    if(UNIT_INTERVAL.has(key)&&(value<0||value>1))throw new ReccoBeatsError('INVALID_AUDIO_FEATURES',`${key} is outside 0..1`);
    if(key==='tempo'&&(value<=0||value>400))throw new ReccoBeatsError('INVALID_AUDIO_FEATURES','tempo is outside the supported BPM range');
    if(key==='loudness'&&(value>10||value< -100))throw new ReccoBeatsError('INVALID_AUDIO_FEATURES','loudness is outside the supported dB range');
    features[key]=value;
  }
  return features;
}

const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const parseRetryAfter=response=>{
  const raw=response.headers?.get?.('Retry-After'); if(!raw)return 1;
  const seconds=Number(raw); if(Number.isFinite(seconds))return Math.max(0,Math.min(seconds,10));
  const date=Date.parse(raw); return Number.isFinite(date)?Math.max(0,Math.min((date-Date.now())/1000,10)):1;
};
async function requestJson(url,{fetchImpl=fetch,timeoutMs=5000,retries=1}={}) {
  for(let attempt=0;;attempt++){
    const controller=new AbortController(); const timer=setTimeout(()=>controller.abort(),timeoutMs);
    try{
      const response=await fetchImpl(url,{headers:{Accept:'application/json','User-Agent':'Moovibe/1.0'},signal:controller.signal});
      if(response.ok){let data;try{data=await response.json();}catch{throw new ReccoBeatsError('INVALID_RESPONSE');}if(!data||typeof data!=='object')throw new ReccoBeatsError('INVALID_RESPONSE');return data;}
      if(response.status===404)throw new ReccoBeatsError('NOT_FOUND','Track not found',{status:404});
      if(response.status===429){const retryAfter=parseRetryAfter(response);if(attempt<retries){await sleep(retryAfter*1000);continue;}throw new ReccoBeatsError('RATE_LIMITED','ReccoBeats rate limited',{status:429,retryAfter});}
      if(response.status>=500&&attempt<retries)continue;
      throw new ReccoBeatsError(response.status>=500?'PROVIDER_UNAVAILABLE':'BAD_RESPONSE',`ReccoBeats HTTP ${response.status}`,{status:response.status});
    }catch(error){
      if(error instanceof ReccoBeatsError)throw error;
      if(error?.name==='AbortError')throw new ReccoBeatsError('TIMEOUT');
      if(attempt<retries)continue;
      throw new ReccoBeatsError('PROVIDER_UNAVAILABLE');
    }finally{clearTimeout(timer);}
  }
}

const mapTrack=item=>({
  id:String(item?.id||''), title:String(item?.trackTitle||item?.title||''),
  artist:String(item?.artists?.[0]?.name||item?.artist||''),
  artists:Array.isArray(item?.artists)?item.artists.map(a=>String(a?.name||'')).filter(Boolean):[],
  album:String(item?.albumTitle||item?.album?.name||''), duration:item?.durationMs==null?null:Number(item.durationMs)/1000,
  isrc:item?.isrc||null, spotify_id:String(item?.href||'').match(/open\.spotify\.com\/track\/([A-Za-z0-9]+)/)?.[1]||null
});

export async function resolveReccoTrack(track,options={}) {
  let items=[];
  if(track?.provider==='spotify'&&track.provider_id){
    const data=await requestJson(`${RECCOBEATS_BASE_URL}/track?ids=${encodeURIComponent(track.provider_id)}`,options);
    items=(Array.isArray(data?.content)?data.content:[]).map(mapTrack);
    const exact=items.find(item=>item.spotify_id===track.provider_id);
    if(exact&&scoreTrackMatch(track,exact)>=.82)return exact;
  }
  if(!items.length&&track?.isrc){
    const data=await requestJson(`${RECCOBEATS_BASE_URL}/track?isrcs=${encodeURIComponent(track.isrc)}`,options);
    items=(Array.isArray(data?.content)?data.content:[]).map(mapTrack);
  }
  const matched=selectBestTrack(track,items,.86);
  if(!matched)throw new ReccoBeatsError('NOT_FOUND','No confidently matching ReccoBeats track',{status:404});
  return matched;
}

export async function getReccoAudioFeatures(reccoTrackId,options={}) {
  const data=await requestJson(`${RECCOBEATS_BASE_URL}/track/${encodeURIComponent(reccoTrackId)}/audio-features`,options);
  if(String(data?.id||'')!==String(reccoTrackId))throw new ReccoBeatsError('IDENTITY_MISMATCH');
  return normalizeAudioFeatures(data);
}

export const audioFeatureCacheKey=track=>track?.provider==='spotify'&&track.provider_id
  ?`reccobeats:features:v1:spotify:${track.provider_id}`
  :track?.lrclib_id?`reccobeats:features:v1:lrclib:${track.lrclib_id}`:null;

export async function getCachedAudioFeatures(kv,track,options={}) {
  const key=audioFeatureCacheKey(track),log=options.log||(()=>{});
  if(key&&kv)try{const cached=await kv.get(key,'json');if(cached){log('audio_features_cache_hit',{status:cached.status||'found',cache_hit:true});return cached;}}catch{}
  log('audio_features_lookup',{status:'started',cache_hit:false});
  try{
    const resolved=await resolveReccoTrack(track,options);
    const features=await getReccoAudioFeatures(resolved.id,options);
    const value={status:'found',source:'reccobeats',source_track_id:resolved.id,matched_provider:track.provider,matched_provider_id:track.provider_id||track.lrclib_id,features,fetched_at:new Date().toISOString()};
    if(key&&kv)try{await kv.put(key,JSON.stringify(value),{expirationTtl:POSITIVE_TTL});}catch{}
    log('audio_features_found',{status:'found',cache_hit:false,source_track_id:resolved.id}); return value;
  }catch(error){
    if(error?.code==='NOT_FOUND'){
      const value={status:'not_found',source:'reccobeats',features:null,fetched_at:new Date().toISOString()};
      if(key&&kv)try{await kv.put(key,JSON.stringify(value),{expirationTtl:NEGATIVE_TTL});}catch{}
      log('audio_features_not_found',{status:'not_found',cache_hit:false});return value;
    }
    log(error?.code==='RATE_LIMITED'?'audio_features_rate_limited':'audio_features_not_found',{status:'unavailable',error_code:error?.code||'UNKNOWN',cache_hit:false});
    return {status:'unavailable',source:'reccobeats',features:null,error_code:error?.code||'PROVIDER_UNAVAILABLE',fetched_at:new Date().toISOString()};
  }
}

export function hasSufficientAudioFeatures(value) {
  const f=value?.features||value; return ['energy','valence','tempo','danceability','acousticness','instrumentalness'].filter(k=>Number.isFinite(f?.[k])).length>=4;
}
