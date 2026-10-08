import {describe,expect,it,vi} from 'vitest';
import fs from 'node:fs';
import {detectLanguage,LANGUAGES,normalizeLanguage} from '../functions/_lib/languages.js';
import {LOCALE_KEYS,localeKeysMatch,translations} from '../js/i18n/locales.js';
import {normalizeMusicText,selectBestTrack} from '../functions/_lib/music-match.js';
import {createAdminSession,safeEqual,verifyAdminSession} from '../functions/_lib/admin-auth.js';
import {sanitizeAudit,writeAudit} from '../functions/_lib/audit.js';
import {canonicalSongKey,validateUserLyrics} from '../functions/_lib/song-library.js';
import {overview} from '../functions/admin/[secret]/[[path]].js';
import {adminScript,dashboardMarkup,loginMarkup} from '../functions/_lib/admin-ui.js';

describe('internationalization',()=>{
  it('defines every base key explicitly in all eight locales',()=>{expect(Object.keys(LANGUAGES)).toHaveLength(8);expect(Object.keys(translations).sort()).toEqual(Object.keys(LANGUAGES).sort());expect(localeKeysMatch()).toBe(true);for(const value of Object.values(translations))expect(Object.keys(value).sort()).toEqual([...LOCALE_KEYS].sort());});
  it('fails completeness before any unsupported-language fallback can apply',()=>{const incomplete:any={en:translations.en,es:Object.fromEntries(Object.entries(translations.es).slice(1))};expect(localeKeysMatch(incomplete)).toBe(false);});
  it('detects supported browser languages and falls back to English',()=>{expect(detectLanguage(['pt-PT'])).toBe('pt-BR');expect(detectLanguage(['zh-SG'])).toBe('zh-CN');expect(normalizeLanguage('ko')).toBe('en');});
});
describe('track identity',()=>{
 const wanted={title:'The One',artist:'Limp Bizkit',album:'Chocolate Starfish',duration:345};
 it('never confuses The One with Break Stuff',()=>expect(selectBestTrack(wanted,[{title:'Break Stuff',artist:'Limp Bizkit',album:'Significant Other',duration:166}])).toBeNull());
 it('selects an exact result even when it is not first',()=>expect(selectBestTrack(wanted,[{title:'Break Stuff',artist:'Limp Bizkit'},{title:'The One (Remastered)',artist:'Limp Bizkit',album:'Chocolate Starfish',duration:346}])?.title).toContain('The One'));
 it('normalizes safe version and featuring noise',()=>expect(normalizeMusicText('Café (Official Audio) feat. X')).toBe('cafe'));
});
describe('admin security',()=>{
  it('creates valid, expiring signed sessions and rejects tampering',async()=>{const token=await createAdminSession('long-admin-key',10);expect(await verifyAdminSession('long-admin-key',token)).toBe(true);expect(await verifyAdminSession('other-key',token)).toBe(false);expect(await verifyAdminSession('long-admin-key',await createAdminSession('long-admin-key',-1))).toBe(false);expect(safeEqual('a','b')).toBe(false);});
 it('redacts secret-shaped audit fields and values',()=>{const safe:any=sanitizeAudit({Authorization:'Bearer abcdefghijklmnop',nested:{api_key:'secret'},text:'sk-abcdefghijklmnop'});expect(JSON.stringify(safe)).not.toContain('abcdefghijklmnop');expect(safe.Authorization).toBe('[REDACTED]');});
 it('emits sanitized structured AI traces without storage bindings',async()=>{const lines:string[]=[];const spy=vi.spyOn(console,'log').mockImplementation(value=>lines.push(String(value)));await writeAudit({}, {stage:'song_profile',Authorization:'Bearer abcdefghijklmnop',success:true});spy.mockRestore();const trace=JSON.parse(lines[0]);expect(trace).toMatchObject({service:'moovibe',event:'ai_trace',stage:'song_profile',success:true,Authorization:'[REDACTED]'});expect(lines[0]).not.toContain('abcdefghijklmnop');});
 it('requires no R2 binding in either deployment',()=>{const config=fs.readFileSync('wrangler.toml','utf8')+fs.readFileSync('workers/pipeline/wrangler.jsonc','utf8');expect(config).not.toMatch(/AI_AUDIT_LOGS|r2_buckets|moovibe-ai-audit/i);});
 it('keeps the secret path out of embedded public UI and preserves all controls',()=>{const ui=dashboardMarkup()+loginMarkup()+adminScript;expect(ui).not.toContain('ADMIN_PATH_SECRET');for(const tab of ['overview','catalog','pipeline','recommendations','songs','traces','traffic','system'])expect(ui).toContain(`data-tab="${tab}"`);for(const behavior of ['logout','toolbar','filter','prev','next','drawer','setInterval'])expect(ui).toContain(behavior);});
 it('normalizes empty aggregate metrics to zero in SQL and output',async()=>{const rows=[{total:0,complete:0,enriched:0,embedded:0,added_today:0,added_7d:0},{queued:0,running:0,done:0,errors:0,errors_24h:0,retries:0},{recommendations:0,last_24h:0,successes:0,cache_hits:0},{songs:0,with_lyrics:0,with_profiles:0,with_embeddings:0}];let index=0;const sql:string[]=[];const db={prepare:(query:string)=>{sql.push(query);return {first:async()=>rows[index++]}}};const result=await overview(db as any);expect(Object.values(result)).not.toContain(null);expect(result).toMatchObject({recommendations:0,last_24h:0,successes:0,cache_hits:0,songs:0,with_lyrics:0,with_profiles:0,with_embeddings:0});expect(sql.join(' ')).toContain('COALESCE');});
});
describe('song persistence invariants',()=>{
 it('prefers provider ids and only permits explicitly confirmed text identity',()=>{expect(canonicalSongKey({title:'x',artist:'y',provider:'spotify',provider_id:'abc'})).toBe('spotify:abc');expect(canonicalSongKey({title:'x',artist:'y',lrclib_id:'42'})).toBe('lrclib:42');expect(canonicalSongKey({title:' The One ',artist:'LIMP BIZKIT',identity_confirmed:true})).toBe(canonicalSongKey({title:'the one',artist:'limp bizkit',identity_confirmed:true}));expect(()=>canonicalSongKey({title:'ambiguous',artist:''})).toThrow('SONG_IDENTITY_REQUIRED');});
 it('enforces safe user lyric lengths',()=>{expect(()=>validateUserLyrics('short')).toThrow();expect(validateUserLyrics('a'.repeat(100))).toHaveLength(100);expect(()=>validateUserLyrics('a'.repeat(20001))).toThrow();});
});
