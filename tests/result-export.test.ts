import {describe,expect,it} from 'vitest';
import {EXPORT_SIZE,exportFilename,htmlToText,normalizeExportData,truncateText} from '../js/result-export.js';

describe('result export model',()=>{
  it('uses a stable 2x 5:4 export surface',()=>{expect(EXPORT_SIZE).toEqual({logicalWidth:900,logicalHeight:720,scale:2,width:1800,height:1440});expect(EXPORT_SIZE.width/EXPORT_SIZE.height).toBe(1.25);});
  it('normalizes a complete result and limits media text',()=>{const value=normalizeExportData({song:'Song',artist:'Artist',songs:[{title:'Song',artist:'Artist',cover_url:'cover'}],share_slug:'shared',movie:{title:'Film',vibe_title:'Vibe',tags:['one','two'],ai_explanation:'<p>Hello <strong>cinema</strong>.</p><script>alert(1)</script>',poster_url:'poster',stills:['a','b','c'],director:'Director',release_year:2020}});expect(value.songs).toHaveLength(1);expect(value.movie.tags).toEqual(['one','two']);expect(value.movie.explanation).not.toContain('<');expect(value.movie.explanation).toContain('Hello cinema.');expect(value.share_slug).toBe('shared');});
  it('supports old recommendations and missing imagery',()=>{const value=normalizeExportData({song:'Old song',artist:'Old artist',movie:{title:'Old film',cover_url:'legacy-cover'}});expect(value.songs).toEqual([{title:'Old song',artist:'Old artist',cover_url:'legacy-cover'}]);expect(value.movie.poster_url).toBe('');expect(value.movie.stills).toEqual([]);});
  it('keeps multiple songs and does not retain stale input',()=>{const first=normalizeExportData({songs:[{title:'A'},{title:'B'},{title:'C'},{title:'D'}],movie:{title:'One'}});const second=normalizeExportData({song:'Fresh',movie:{title:'Two'}});expect(first.songs.map((song:{title:string})=>song.title)).toEqual(['A','B','C']);expect(second.songs.map((song:{title:string})=>song.title)).toEqual(['Fresh']);});
  it('strips untrusted markup and truncates long copy naturally',()=>{expect(htmlToText('<p>First</p><p>Second &amp; safe</p>')).toContain('First');const text=truncateText('A deliberately long editorial explanation that must fit',25);expect(text.endsWith('…')).toBe(true);expect(text.length).toBeLessThanOrEqual(25);});
  it('creates portable filenames',()=>{expect(exportFilename({song:'Águas / Março?',movie:{title:'Film: One'}})).toBe('moovibe-aguas-marco-film-one.png');});
  it('keeps the visual data required for a direct export',()=>{
    const data=normalizeExportData({song:'Vienna',artist:'Billy Joel',songs:[{title:'Vienna',artist:'Billy Joel',cover_url:'https://i.scdn.co/image/a'}],movie:{title:'Eu Me Lembro',poster_url:'https://image.tmdb.org/t/p/w500/a.jpg',stills:['https://image.tmdb.org/t/p/w780/a.jpg'],ai_explanation:'A real explanation.'}});
    expect(data.movie.poster_url).toContain('image.tmdb.org');
    expect(data.songs[0].cover_url).toContain('i.scdn.co');
    expect(data.movie.explanation).toBe('A real explanation.');
  });
});
