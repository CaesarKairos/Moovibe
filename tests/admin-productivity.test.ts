import {beforeEach,describe,expect,it,vi} from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import {cachedProductivity,productivitySql,productivityTimeBounds,queryProductivity,resetProductivityCache} from '../functions/_lib/admin-productivity.js';
import {adminProductivityStyles} from '../functions/_lib/admin-productivity-ui.js';
import {adminControlRoomScript} from '../functions/_lib/admin-control-room.js';

class Statement{values:any[]=[];constructor(private db:Database.Database,private sql:string){}bind(...values:any[]){this.values=values;return this}async first(){return this.db.prepare(this.sql).get(...this.values)}}
const d1=(db:Database.Database)=>({prepare:(sql:string)=>new Statement(db,sql)});
let db:Database.Database;
beforeEach(()=>{resetProductivityCache();db=new Database(':memory:');db.exec('CREATE TABLE movies(created_at TEXT,details_fetched_at TEXT,enriched_at TEXT,embedded_at TEXT)');});

describe('Brasilia productivity windows',()=>{
  it('calculates local midnight as a semi-open UTC boundary',()=>{const b=productivityTimeBounds(new Date('2026-10-11T03:30:00Z'));expect(b.today_start).toBe('2026-10-11 03:00:00');expect(b.now).toBe('2026-10-11 03:30:00');expect(b.time_zone).toBe('America/Sao_Paulo');expect(b.time_zone_label).toContain('UTC−03:00');});
  it('distinguishes yesterday in Brasilia from the same UTC date',()=>{const b=productivityTimeBounds(new Date('2026-10-11T02:59:59Z'));expect(b.today_start).toBe('2026-10-10 03:00:00');});
  it('uses moving 24-hour and seven-day windows',()=>{const b=productivityTimeBounds(new Date('2026-10-11T12:00:00Z'));expect(b.last_24h_start).toBe('2026-10-10 12:00:00');expect(b.last_7d_start).toBe('2026-10-04 12:00:00');expect(b.days).toHaveLength(7);expect(b.days.at(-1)?.end).toBe('2026-10-11 12:00:00');});
  it('handles historical timezone rules without a fixed offset',()=>{const summer=productivityTimeBounds(new Date('2018-12-01T12:00:00Z'));expect(summer.time_zone_label).toContain('UTC−02:00');expect(summer.today_start.endsWith('02:00:00')).toBe(true);});
});

describe('timestamp semantics',()=>{
  it('counts each lifecycle timestamp independently and respects boundaries',async()=>{const insert=db.prepare('INSERT INTO movies VALUES(?,?,?,?)');insert.run('2026-10-11 03:00:00','2026-10-11 04:00:00','2026-10-10 02:00:00',null);insert.run('2026-10-10 02:59:59',null,'2026-10-11 05:00:00','2026-10-11 06:00:00');insert.run('2026-09-01 00:00:00',null,'2026-10-11 07:00:00','2026-10-11 08:00:00');const result=await queryProductivity(d1(db),new Date('2026-10-11T12:00:00Z'));expect(result.windows.today).toEqual({added:1,details:1,enriched:2,embedded:2});expect(result.windows['24h']).toEqual({added:1,details:1,enriched:2,embedded:2});expect(result.chart.at(-1)).toMatchObject({date:'11/10',added:1,enriched:2,embedded:2});});
  it('represents legitimate empty results as zero',async()=>{const result=await queryProductivity(d1(db),new Date('2026-10-11T12:00:00Z'));expect(result.windows.today).toEqual({added:0,details:0,enriched:0,embedded:0});expect(result.chart.every(day=>day.added===0&&day.enriched===0&&day.embedded===0)).toBe(true);});
  it('uses one read-only aggregate query with no timestamp-column functions',()=>{const {sql}=productivitySql(productivityTimeBounds(new Date('2026-10-11T12:00:00Z')));expect(sql.match(/FROM movies/g)).toHaveLength(1);expect(sql).not.toMatch(/INSERT|UPDATE|DELETE|date\s*\(\s*(created_at|details_fetched_at|enriched_at|embedded_at)/i);expect(sql).not.toMatch(/Gemini|TMDb|Vectorize/i);const plan=db.prepare('EXPLAIN QUERY PLAN '+sql).all(...productivitySql(productivityTimeBounds(new Date('2026-10-11T12:00:00Z'))).binds) as any[];expect(plan.some(row=>String(row.detail).includes('SCAN movies'))).toBe(true);});
});

describe('short cache and failure behavior',()=>{
  it('avoids repeating the aggregate inside 90 seconds',async()=>{let calls=0;const source={prepare:(sql:string)=>{calls++;return new Statement(db,sql)}};await cachedProductivity(source,new Date('2026-10-11T12:00:00Z'));const second=await cachedProductivity(source,new Date('2026-10-11T12:01:00Z'));expect(calls).toBe(1);expect(second.cached).toBe(true);});
  it('distinguishes unavailable data from zero and marks stale cache',async()=>{const warn=vi.spyOn(console,'warn').mockImplementation(()=>{}),broken={prepare:()=>{throw Error('D1 unavailable')}};const unavailable=await cachedProductivity(broken,new Date('2026-10-11T12:00:00Z'));expect(unavailable).toMatchObject({available:false,error:'QUERY_FAILED'});resetProductivityCache();await cachedProductivity(d1(db),new Date('2026-10-11T12:00:00Z'));const stale=await cachedProductivity(broken,new Date('2026-10-11T12:02:00Z'));expect(stale).toMatchObject({available:true,cached:true,stale:true});warn.mockRestore();});
});

describe('Control Room presentation',()=>{
  it('provides persistent period controls, three chart series and textual accessibility',()=>{const ui=adminControlRoomScript+adminProductivityStyles;expect(()=>new Function(adminControlRoomScript)).not.toThrow();for(const text of ['HOJE','24 HORAS','7 DIAS','DESCOBERTA','ENRIQUECIMENTO','VETORIZAÇÃO','Dados textuais do gráfico','aria-pressed'])expect(ui).toContain(text);expect(ui).toContain("period:'today'");expect(ui).toContain('viewBox="0 0 690 250"');});
  it('has responsive breakpoints without changing the public frontend',()=>{expect(adminProductivityStyles).toContain('@media(max-width:760px)');expect(adminProductivityStyles).toContain('@media(max-width:390px)');expect(fs.readFileSync('js/script.js','utf8')).not.toContain('productivity-panel');});
  it('preserves the recommendations and music overview sections',()=>{expect(adminControlRoomScript).toContain('RECOMENDAÇÕES');expect(adminControlRoomScript).toContain('INTELIGÊNCIA MUSICAL');});
});
