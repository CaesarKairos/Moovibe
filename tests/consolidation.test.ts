import {describe,expect,it} from 'vitest';
import {detectLanguage,LANGUAGES,normalizeLanguage} from '../functions/_lib/languages.js';
import {localeKeysMatch,translations} from '../js/i18n/locales.js';
import {normalizeMusicText,selectBestTrack} from '../functions/_lib/music-match.js';
import {createAdminSession,safeEqual,verifyAdminSession} from '../functions/_lib/admin-auth.js';
import {sanitizeAudit} from '../functions/_lib/audit.js';
import {canonicalSongKey,validateUserLyrics} from '../functions/_lib/song-library.js';

describe('internationalization',()=>{
  it('defines eight complete locales',()=>{expect(Object.keys(LANGUAGES)).toHaveLength(8);expect(Object.keys(translations).sort()).toEqual(Object.keys(LANGUAGES).sort());expect(localeKeysMatch()).toBe(true);});
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
});
describe('song persistence invariants',()=>{
 it('uses LRCLIB identity first and canonicalizes text fallback',()=>{expect(canonicalSongKey({title:'x',artist:'y',lrclib_id:'42'})).toBe('lrclib:42');expect(canonicalSongKey({title:' The One ',artist:'LIMP BIZKIT'})).toBe(canonicalSongKey({title:'the one',artist:'limp bizkit'}));});
 it('enforces safe user lyric lengths',()=>{expect(()=>validateUserLyrics('short')).toThrow();expect(validateUserLyrics('a'.repeat(100))).toHaveLength(100);expect(()=>validateUserLyrics('a'.repeat(20001))).toThrow();});
});
