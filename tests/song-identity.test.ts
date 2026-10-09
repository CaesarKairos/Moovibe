import {beforeEach,describe,expect,it,vi} from 'vitest';
import {getSpotifyTrack,parseSpotifyTrackInput,resetSpotifyTokenForTests,resolveSpotifyTrackUrl,searchSpotifyTracks} from '../functions/_lib/spotify.js';
import {resolveCanonicalSong,selectGeniusHit,selectLyricsMatch} from '../functions/_lib/song-identity.js';
import {recommendationCacheKey,RECOMMENDER_VERSION} from '../functions/_lib/recommender.js';
import {onRequestGet as musicSearch} from '../functions/music-search.js';

const id='4uLU6hMCjMI75M1A2tKUQC';
const id2='0VjIjW4GlUZAMYd2vXMi3b';
const spotify={id,name:'Everybody Wants to Love You',artists:[{name:'Japanese Breakfast'}],album:{name:'Psychopomp'},duration_ms:203123,external_urls:{spotify:'https://open.spotify.com/track/'+id},external_ids:{isrc:'USSC11501980'}};
const env={SPOTIFY_CLIENT_ID:'client',SPOTIFY_CLIENT_SECRET:'secret'};
beforeEach(()=>{resetSpotifyTokenForTests();vi.restoreAllMocks()});
function spotifyFetch(){
  return vi.fn()
    .mockResolvedValueOnce(new Response(JSON.stringify({access_token:'token',expires_in:3600}),{status:200}))
    .mockResolvedValueOnce(new Response(JSON.stringify(spotify),{status:200}));
}

describe('Spotify input safety',()=>{
 it('marks exact Spotify URLs and URIs explicitly for frontend auto-confirmation',async()=>{for(const query of ['https://open.spotify.com/track/'+id,'https://open.spotify.com/intl-pt/track/'+id,'spotify:track:'+id]){vi.stubGlobal('fetch',spotifyFetch());const response=await musicSearch({request:new Request('https://site/music-search?q='+encodeURIComponent(query)),env} as any);const data:any=await response.json();expect(data.mode).toBe('exact');expect(data.items).toHaveLength(1);expect(data.items[0].provider_id).toBe(id);resetSpotifyTokenForTests();}});
 it('parses direct, localized and URI track ids while ignoring query strings',()=>{for(const value of ['https://open.spotify.com/track/'+id,'https://open.spotify.com/intl-pt/track/'+id,'https://open.spotify.com/intl-br/track/'+id+'?si=abc','https://open.spotify.com/intl-en/track/'+id+'?utm_source=x','spotify:track:'+id])expect(parseSpotifyTrackInput(value)).toMatchObject({kind:'track',id})});
 it('rejects localized non-track resources and external URLs',()=>{for(const type of ['artist','album','playlist'])expect(parseSpotifyTrackInput(`https://open.spotify.com/intl-pt/${type}/${id}`)?.kind).toBe('not_track');for(const value of ['https://open.spotify.com/episode/'+id,'https://evil.example/track/'+id,'file:///track/'+id,'http://localhost/track/'+id,'http://127.0.0.1/track/'+id])expect(parseSpotifyTrackInput(value)?.kind).toMatch(/not_track|invalid_url/)});
 it('resolves an exact URL through the track endpoint',async()=>{vi.stubGlobal('fetch',spotifyFetch());expect((await resolveSpotifyTrackUrl(env,'https://open.spotify.com/track/'+id))?.provider_id).toBe(id)});
 it('resolves spotify.link when its redirect is a localized track URL',async()=>{vi.stubGlobal('fetch',vi.fn().mockResolvedValueOnce(new Response(null,{status:302,headers:{location:'https://open.spotify.com/intl-pt/track/'+id+'?si=abc'}})).mockResolvedValueOnce(new Response(JSON.stringify({access_token:'token',expires_in:3600}))).mockResolvedValueOnce(new Response(JSON.stringify(spotify))));expect((await resolveSpotifyTrackUrl(env,'https://spotify.link/example'))?.provider_id).toBe(id)});
 it('maps search results without joining the artist into the title',async()=>{vi.stubGlobal('fetch',vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({access_token:'token',expires_in:3600}))).mockResolvedValueOnce(new Response(JSON.stringify({tracks:{items:[spotify]}}))));const [track]=await searchSpotifyTracks(env,'Everybody Wants to Love You Japanese Breakfast');expect(track).toMatchObject({title:'Everybody Wants to Love You',artist:'Japanese Breakfast',album:'Psychopomp'})});
});

describe('canonical identity and lyrics',()=>{
 it('rebuilds browser metadata from provider id',async()=>{vi.stubGlobal('fetch',spotifyFetch());const result=await resolveCanonicalSong(env,{provider:'spotify',provider_id:id,title:'tampered',artist:'wrong'},'req');expect(result.track).toMatchObject({title:'Everybody Wants to Love You',artist:'Japanese Breakfast',identity_confirmed:true})});
 it('never advances ambiguous free text as title with an empty artist',async()=>{vi.stubGlobal('fetch',vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({access_token:'token',expires_in:3600}))).mockResolvedValueOnce(new Response(JSON.stringify({tracks:{items:[spotify]}}))));const result=await resolveCanonicalSong(env,{title:'Everybody Wants to Love You Japanese Breakfast',artist:''},'req');expect(result.track).toBeUndefined();expect(result.unresolved?.candidates[0]).toMatchObject({title:'Everybody Wants to Love You',artist:'Japanese Breakfast'})});
 it('resolves one to three tracks and permits mixed providers',async()=>{const second={...spotify,id:id2,name:'Second Song'};vi.stubGlobal('fetch',vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({access_token:'token',expires_in:3600}))).mockResolvedValueOnce(new Response(JSON.stringify(spotify))).mockResolvedValueOnce(new Response(JSON.stringify({id:42,trackName:'LR Song',artistName:'LR Artist',albumName:'LR Album',duration:180}))).mockResolvedValueOnce(new Response(JSON.stringify(second))));const inputs=[{provider:'spotify',provider_id:id},{provider:'lrclib',provider_id:'42'},{provider:'spotify',provider_id:id2}];const tracks=[];for(const input of inputs)tracks.push((await resolveCanonicalSong(env,input,'req')).track);expect(tracks).toHaveLength(3);expect(tracks.map(x=>x?.provider)).toEqual(['spotify','lrclib','spotify'])});
 it('falls back to LRCLIB when Spotify credentials are unavailable',async()=>{vi.stubGlobal('fetch',vi.fn().mockResolvedValueOnce(new Response(JSON.stringify([{id:42,trackName:'Fallback Song',artistName:'Fallback Artist'}]))));const result=await resolveCanonicalSong({}, {title:'Fallback Song',artist:''},'req');expect(result.unresolved?.candidates[0]).toMatchObject({provider:'lrclib',provider_id:'42'})});
 it('selects the second, correct LRCLIB result with lyrics',()=>{const result=selectLyricsMatch({title:'Everybody Wants to Love You',artist:'Japanese Breakfast'},[{id:1,trackName:'Everybody Wants to Love Everybody',artistName:'Outro Artista',plainLyrics:'wrong'},{id:2,trackName:'Everybody Wants to Love You',artistName:'Japanese Breakfast',plainLyrics:'right'}]);expect(result?.provider_id).toBe('2');expect(result?.plainLyrics).toBe('right')});
 it('selects a matching Genius hit rather than hits[0]',()=>{const result=selectGeniusHit({title:'Everybody Wants to Love You',artist:'Japanese Breakfast'},[{result:{id:1,title:'Wrong',primary_artist:{name:'Other'}}},{result:{id:2,title:'Everybody Wants to Love You',primary_artist:{name:'Japanese Breakfast'}}}]);expect(result?.id).toBe(2)});
 it('preserves The One regression',()=>expect(selectLyricsMatch({title:'The One',artist:'Limp Bizkit'},[{id:1,trackName:'Break Stuff',artistName:'Limp Bizkit',plainLyrics:'wrong'}])).toBeNull());
 it('versions recommendation keys around identity providers',()=>{expect(RECOMMENDER_VERSION).toBe('catalog-v4-song-identity');expect(recommendationCacheKey([{provider:'spotify',provider_id:id,title:'x',artist:'y'}])).not.toBe(recommendationCacheKey([{provider:'lrclib',provider_id:id,title:'x',artist:'y'}]))});
});

describe('public boundary',()=>{
 it('does not expose Spotify credentials in browser files',async()=>{const fs=await import('node:fs/promises');const sources=await Promise.all(['index.html','js/script.js','js/i18n/locales.js','css/style.css'].map(file=>fs.readFile(file,'utf8')));expect(sources.join('\n')).not.toMatch(/SPOTIFY_CLIENT_(?:ID|SECRET)/)});
});
