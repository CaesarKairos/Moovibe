import { describe, expect, it } from 'vitest';
import { APPLE_SNAPSHOT, REFRESH_STATUS, normalizeAppleFeed, refreshRanking } from '../functions/_lib/ranking-refresh.js';
import { onRequestGet } from '../functions/api/top-global.js';

const now = new Date('2026-11-26T09:00:00Z');
const feed = {feed:{country:'br',updated:'2026-11-26T07:00:00Z',
    results:Array.from({length:50}, (_,index)=>({id:String(index+1),name:'Track '+index,artistName:'Artist',
        kind:'songs',url:'https://music.apple.com/br/song/track/'+(index+1)}))}};

describe('Apple Music Brazil scheduled ranking',()=>{
    it('keeps provider identities and rejects invalid feeds',()=>{
        const result=normalizeAppleFeed(feed,now);
        expect(result.tracks).toHaveLength(50);
        expect(result.tracks[0]).toMatchObject({position:1,spotify_id:null,track_id:'1',url:'https://music.apple.com/br/song/track/1'});
        expect(()=>normalizeAppleFeed({feed:{...feed.feed,country:'us'}},now)).toThrow('INVALID_APPLE_FEED');
        expect(()=>normalizeAppleFeed({feed:{...feed.feed,results:Array(50).fill(feed.feed.results[0])}},now)).toThrow('INVALID_APPLE_TRACK');
    });

    it('serves a valid snapshot and retains it through upstream failure',async()=>{
        const values=new Map<string,string>();
        const kv={get:async(key:string)=>JSON.parse(values.get(key)||'null'),put:async(key:string,value:string)=>{values.set(key,value);}};
        expect(await refreshRanking(kv,async()=>Response.json(feed),now)).toMatchObject({count:50,error:null});
        const before=values.get(APPLE_SNAPSHOT);
        await refreshRanking(kv,async()=>new Response(null,{status:503}),new Date('2026-11-27T09:00:00Z'));
        expect(values.get(APPLE_SNAPSHOT)).toBe(before);
        expect(await kv.get(REFRESH_STATUS)).toMatchObject({error:'APPLE_HTTP_503',count:50,last_success:now.toISOString()});
        expect((await onRequestGet({env:{MOOVIBE_DB:kv}})).status).toBe(200);
    });
});
