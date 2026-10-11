import {describe,expect,it,vi} from 'vitest';
import {getCachedAudioFeatures,hasSufficientAudioFeatures,normalizeAudioFeatures,ReccoBeatsError,resolveReccoTrack} from '../functions/_lib/reccobeats.js';

const spotify={provider:'spotify',provider_id:'0ug5NqcwcFR2xrfTkc7k8e',title:'Style',artist:'Taylor Swift',album:'1989',duration:231,isrc:'USCJY1431319'};
const trackResponse={content:[{id:'recco-uuid',trackTitle:'Style',artists:[{name:'Taylor Swift'}],durationMs:231000,isrc:'USCJY1431319',href:'https://open.spotify.com/track/0ug5NqcwcFR2xrfTkc7k8e'}]};
const features={id:'recco-uuid',danceability:0,energy:.79,valence:.48,tempo:94.93,acousticness:.002,instrumentalness:null,speechiness:.04,liveness:.11,loudness:-5.59};
const response=(body:any,status=200,headers={})=>({ok:status>=200&&status<300,status,headers:{get:(key:string)=>(headers as any)[key]||null},json:async()=>body});

describe('ReccoBeats catalog audio features',()=>{
  it('resolves a Spotify id to a verified ReccoBeats UUID',async()=>{
    const fetchImpl=vi.fn(async()=>response(trackResponse));
    await expect(resolveReccoTrack(spotify,{fetchImpl})).resolves.toMatchObject({id:'recco-uuid',spotify_id:'0ug5NqcwcFR2xrfTkc7k8e'});
    expect(String((fetchImpl.mock.calls as any)[0][0])).toContain('/track?ids=0ug5NqcwcFR2xrfTkc7k8e');
  });
  it('rejects a different recording instead of accepting the first result',async()=>{
    const wrong={content:[{...trackResponse.content[0],trackTitle:'Styles',artists:[{name:'Harry Styles'}],href:'https://open.spotify.com/track/other'}]};
    await expect(resolveReccoTrack(spotify,{fetchImpl:async()=>response(wrong)})).rejects.toMatchObject({code:'NOT_FOUND'});
  });
  it('preserves valid zero and null values and units',()=>{
    const value:any=normalizeAudioFeatures(features);
    expect(value.danceability).toBe(0);expect(value.instrumentalness).toBeNull();expect(value.tempo).toBe(94.93);expect(value.loudness).toBe(-5.59);
  });
  it('rejects documented normalized metrics outside their range',()=>{
    expect(()=>normalizeAudioFeatures({...features,energy:1.2})).toThrow(ReccoBeatsError);
    expect(()=>normalizeAudioFeatures({...features,tempo:0})).toThrow(ReccoBeatsError);
  });
  it('caches positive results and a cache hit makes no request',async()=>{
    const values=new Map<string,string>();const kv={get:vi.fn(async(key:string)=>values.has(key)?JSON.parse(values.get(key)!):null),put:vi.fn(async(key:string,value:string,_options?:any)=>{values.set(key,value);})};
    const fetchImpl=vi.fn(async(url:string)=>response(url.includes('audio-features')?features:trackResponse));
    const first=await getCachedAudioFeatures(kv,spotify,{fetchImpl});const second=await getCachedAudioFeatures(kv,spotify,{fetchImpl});
    expect(first.status).toBe('found');expect(second.status).toBe('found');expect(fetchImpl).toHaveBeenCalledTimes(2);expect((kv.put.mock.calls as any)[0][2]).toMatchObject({expirationTtl:604800});
  });
  it('negative-caches 404 but never 429 or 500',async()=>{
    for(const status of [404,429,500]){
      const kv={get:vi.fn(async()=>null),put:vi.fn(async()=>{})};
      const result=await getCachedAudioFeatures(kv,spotify,{fetchImpl:async()=>response({},status),retries:0});
      expect(result.status).toBe(status===404?'not_found':'unavailable');expect(kv.put).toHaveBeenCalledTimes(status===404?1:0);
    }
  });
  it('treats KV failures as best-effort and checks evidence density',async()=>{
    const kv={get:async()=>{throw Error('KV down')},put:async()=>{throw Error('KV down')}};
    const result=await getCachedAudioFeatures(kv,spotify,{fetchImpl:async(url:string)=>response(url.includes('audio-features')?features:trackResponse)});
    expect(result.status).toBe('found');expect(hasSufficientAudioFeatures(result)).toBe(true);expect(hasSufficientAudioFeatures({features:{energy:.5}})).toBe(false);
  });
});
