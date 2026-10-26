import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import { capacityConfig, reserveCapacity, recordCapacity, spacing } from '../workers/pipeline/src/groq-capacity';
import { classifyProviderError } from '../workers/pipeline/src/provider-errors';
import { GroqClient, GroqError, groqCooldown } from '../workers/pipeline/src/groq-client';
import { moviePrompt, MOVIE_SYSTEM } from '../workers/pipeline/src/movie-prompt';
import { ENRICHMENT_JSON_SCHEMA } from '../workers/pipeline/src/generation-provider';
let sqlite: Database.Database;
let db: D1Database;
const now = Date.parse('2026-10-21T10:00:00Z');
beforeEach(() => {
  sqlite = new Database(':memory:');
  for(const file of fs.readdirSync('migrations').filter(x=>x.endsWith('.sql')).sort()) sqlite.exec(fs.readFileSync('migrations/'+file,'utf8'));
  db = { batch: async (xs:any[])=>sqlite.transaction(()=>xs.map(x=>x.runSync()))(), prepare(sql: string) {
    let values: any[] = [];
    return { bind(...args: any[]) { values=args; return this; }, runSync() { const r=sqlite.prepare(sql).run(...values); return {meta:{changes:r.changes}}; }, async run() { return this.runSync(); }, async first() { return sqlite.prepare(sql).get(...values); } };
  } } as any;
});
afterEach(() => { sqlite.close(); vi.restoreAllMocks(); });
const row = () => sqlite.prepare('SELECT * FROM groq_capacity ORDER BY day DESC').get() as any;
describe('durable Groq admission', () => {
  it('admits seven of 100 concurrent reservations within 7200 TPM and expires the rolling window', async () => {
    const admitted=await Promise.allSettled(Array.from({length:100},()=>reserveCapacity(db,{},1000,now)));
    expect(admitted.filter(r=>r.status==='fulfilled')).toHaveLength(7);
    expect(row()).toMatchObject({attempts:7,reserved_tokens:7000});
    await expect(reserveCapacity(db,{},1000,now+59999)).rejects.toMatchObject({deferred:true});
    await reserveCapacity(db,{},1000,now+60000);
    expect(row().attempts).toBe(8);
  });
  it('bounds RPM independently of tokens',async()=>{
    const admitted=await Promise.allSettled(Array.from({length:100},()=>reserveCapacity(db,{GROQ_RPM:2,GROQ_SAFETY_MARGIN:0},100,now)));
    expect(admitted.filter(r=>r.status==='fulfilled')).toHaveLength(2);
  });
  it.each([{GROQ_RPD:1}, {GROQ_TPD:1000}])('stops at daily configured budget and resets UTC %j', async config => {
    const env = {...config,GROQ_SAFETY_MARGIN:0};
    await reserveCapacity(db,env,1000,now);
    await expect(reserveCapacity(db,env,1000,now+60000)).rejects.toMatchObject({deferred:true});
    await reserveCapacity(db,env,1000,now+86400000);
    expect(sqlite.prepare('SELECT COUNT(*) n FROM groq_capacity').get()).toEqual({n:2});
  });
  it.each([{GROQ_RPM:0},{GROQ_RPD:0},{GROQ_TPM:900},{GROQ_TPD:900},{GROQ_ITPM:900},{GROQ_OTPM:2000}])('fails closed before first insert %j', async env => {
    await expect(reserveCapacity(db,{...env,GROQ_SAFETY_MARGIN:0},1000,now)).rejects.toMatchObject({deferred:true});
    expect(row()).toBeUndefined();
  });
  it('measures raw/cached tokens and histogram durably; unknown usage retains reservation', async () => {
    const r = await reserveCapacity(db,{},3000,now);
    await recordCapacity(db,r,{usage:{prompt_tokens:500,completion_tokens:200,total_tokens:700,prompt_tokens_details:{cached_tokens:300}}});
    expect(row()).toMatchObject({reserved_tokens:700,measured:1,prompt_tokens:500,completion_tokens:200,total_tokens:700,cached_tokens:300,sum_squares:490000});
    expect(JSON.parse(row().histogram)).toEqual({'1024':1});
    const next=await reserveCapacity(db,{},3000,now+60000);
    await recordCapacity(db,next,{error:'rate_429'});
    expect(row()).toMatchObject({reserved_tokens:3700,measured:1});
    expect(JSON.parse(row().errors)).toEqual({success:1,rate_429:1});
  });
  it('uses lower actual organization ceilings and never raises them with stale responses', async () => {
    const r=await reserveCapacity(db,{},3000,now);
    await recordCapacity(db,r,{headers:{'x-ratelimit-limit-tokens':'2000','x-ratelimit-limit-requests':'1'}});
    const second=await reserveCapacity(db,{},1000,now+60000).catch(()=>null);
    if(second) await recordCapacity(db,second,{headers:{'x-ratelimit-limit-tokens':'8000'}});
    expect(row()).toMatchObject({server_tpm:2000,server_rpd:1});
    await expect(reserveCapacity(db,{},3000,now+60000)).rejects.toMatchObject({deferred:true});
  });
  it('does not forget unmeasured HTTP attempts when introduced mid-day', async () => {
    sqlite.prepare('INSERT INTO system_state(key,value) VALUES(?,?)').run('gen_pilot_count:groq',JSON.stringify({day:'2026-10-21',count:436}));
    await expect(reserveCapacity(db,{},1000,now)).rejects.toMatchObject({deferred:true});
    expect(row()).toBeUndefined();
    await reserveCapacity(db,{},1000,now+86400000);
  });
  it('keeps the minute lease across a UTC daily reset', async () => {
    const midnight=Date.parse('2026-10-22T00:00:00Z');
    await reserveCapacity(db,{},4000,midnight-1000);
    await expect(reserveCapacity(db,{},4000,midnight)).rejects.toMatchObject({deferred:true,retryAfter:59});
    await reserveCapacity(db,{},4000,midnight+60000);
    expect(row().attempts).toBe(1);
  });
  it('reconciles concurrent telemetry exactly once',async()=>{
    const reservation=await reserveCapacity(db,{},3000,now);
    const event={usage:{prompt_tokens:500,completion_tokens:200,total_tokens:700}};
    await Promise.all([recordCapacity(db,reservation,event),recordCapacity(db,reservation,event)]);
    expect(row()).toMatchObject({reserved_tokens:700,total_tokens:700,measured:1});
  });
  it('keeps lower organization ceilings but renews remaining daily requests',async()=>{
    vi.spyOn(Date,'now').mockReturnValue(now);
    const first=await reserveCapacity(db,{},1000,now);
    await recordCapacity(db,first,{headers:{'x-ratelimit-limit-requests':'10','x-ratelimit-remaining-requests':'0','x-ratelimit-reset-requests':'60s','x-ratelimit-limit-tokens':'4000'}});
    await expect(reserveCapacity(db,{},1000,now+60001)).rejects.toMatchObject({deferred:true});
    const results=await Promise.allSettled(Array.from({length:10},()=>reserveCapacity(db,{},1000,now+86400000)));
    expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(3);
    expect(row()).toMatchObject({server_rpd:10,server_tpm:4000,server_daily_ceiling:1000,attempts:3});
  });
  it('sustains seven reservations per minute over ten minutes versus the old one per minute',async()=>{
    let total=0;
    for(let minute=0;minute<10;minute++){
      const results=await Promise.allSettled(Array.from({length:8},()=>reserveCapacity(db,{},1000,now+minute*60000)));
      const accepted=results.filter(r=>r.status==='fulfilled').length;
      expect(accepted).toBe(7);total+=accepted;
    }
    expect(total).toBe(70);expect(row()).toMatchObject({attempts:70,reserved_tokens:70000});
  });
  it('provider mode records concurrent attempts without applying local minute or daily budgets',async()=>{
    const env={GROQ_CAPACITY_MODE:'provider',GROQ_RPM:0,GROQ_TPM:0,GROQ_TPD:0};
    const results=await Promise.allSettled(Array.from({length:100},()=>reserveCapacity(db,env,1000,now)));
    expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(100);
    expect(row()).toMatchObject({attempts:100,reserved_tokens:100000});
  });
  it.each([false,true])('predictive cooldown follows local admission mode %s',async enabled=>{
    const client=new GroqClient('test','model',async()=>new Response(JSON.stringify({choices:[{message:{content:'{}'}}]}),{headers:{'x-ratelimit-remaining-tokens':'100','x-ratelimit-reset-tokens':'2m'}}));
    client.setLocalAdmissionEnabled(enabled);const cooldown=vi.fn(async()=>{});client.setCooldownReporter(cooldown);
    await expect(client.generateJson({system:'test',prompt:'test',schema:{}})).rejects.toThrow();
    expect(cooldown).toHaveBeenCalledTimes(enabled?1:0);
  });
  it('D1 failure denies network admission', async () => {
    await expect(reserveCapacity({prepare(){throw Error('offline');}} as any,{},1000,now)).rejects.toMatchObject({deferred:true,retryAfter:300});
  });
  it('never truncates provider waits and recognizes positive but insufficient remaining tokens', () => {
    expect(groqCooldown(new Headers({'retry-after':'172800'}),429).seconds).toBe(172800);
    expect(classifyProviderError(new GroqError('Groq 429',429,172800,true)).retryAfterSeconds).toBe(172800);
    expect(groqCooldown(new Headers({'x-ratelimit-remaining-tokens':'100','x-ratelimit-reset-tokens':'2m'}),200,'',1000).seconds).toBe(120);
  });
  it('captures usage even when content fails validation, including cached tokens', async () => {
    const events:any[]=[];
    const client=new GroqClient('mock','openai/gpt-oss-120b',async()=>new Response(JSON.stringify({usage:{prompt_tokens:50,completion_tokens:5,total_tokens:55,prompt_tokens_details:{cached_tokens:20}},choices:[{message:{content:'{'}}]})));
    client.setTelemetryReporter(async event=>{events.push(event);});
    await expect(client.generateJson({system:MOVIE_SYSTEM,prompt:'facts',schema:ENRICHMENT_JSON_SCHEMA})).rejects.toThrow('invalid');
    expect(events).toMatchObject([{error:'invalid_json',usage:{total_tokens:55,prompt_tokens_details:{cached_tokens:20}}}]);
  });
});
describe('lossless prompt compaction fixtures', () => {
  it.each([
    ['Cidade de Deus','Crime,Drama','Dois jovens seguem caminhos diferentes em uma comunidade.'],
    ['七人の侍','Action,Drama','村を守るため七人の侍が集まる。'],
    ['Le voyage dans la lune','Fantasy','Des astronomes explorent la lune.'],
    ['Solaris','Science Fiction','A psychologist confronts memories. '.repeat(100)],
    ['Documentary','Documentary',''],
    ['Comedy musical','Comedy,Music','A performer finds love.']
  ])('preserves all facts for %s without changing schema', (title,genres,overview) => {
    const movie={title,genres,overview,keywords:'["memory", "memory", "identity"]',release_year:2000};
    const prompt=moviePrompt(movie);
    expect(prompt).toContain(`Title:${title}`);
    if(overview) expect(prompt).toContain(overview.trim());
    expect(prompt).toContain('Keywords:memory,identity');
    expect(moviePrompt(movie)).toBe(prompt);
    expect(ENRICHMENT_JSON_SCHEMA.required).toHaveLength(16);
    const old=`Title: ${title}\nYear: 2000\nDirector: unknown\nCountries: undefined\nGenres: ${genres}\nKeywords: ${movie.keywords}\nOverview: ${overview}\nTagline: `;
    expect(prompt.length).toBeLessThan(old.length);
  });
});
