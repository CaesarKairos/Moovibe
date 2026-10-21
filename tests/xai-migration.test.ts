import { describe, expect, it, vi } from 'vitest';
import { classifyProviderError } from '../workers/pipeline/src/provider-errors';
import { circuitState, closeCircuit, openCircuit, validateEnrichment, ENRICHMENT_JSON_SCHEMA } from '../workers/pipeline/src/generation-provider';
import { createMovieGenerationProvider, isMovieGenerationEnabled, DEFAULT_GROQ_MODEL } from '../workers/pipeline/src/generation-factory';
import { XaiClient } from '../workers/pipeline/src/xai-client';

const good = { moods: ['tense'], themes: ['revenge'], atmosphere: ['dark'], pace: 'slow', visual_style: ['noir'], emotional_valence: 0.2, energy: 0.7, intimacy: 0.3, surrealism: 0.1, darkness: 0.9, humor: 0.05, romanticism: 0.1, narrative_density: 0.6, melancholy_level: 0.5, tension_level: 0.9, confidence: 0.85 };
const memDb = () => {
  const store = new Map<string, string>();
  return { prepare: (sql: string) => ({ bind: (...a: any[]) => ({ first: async () => (sql.includes('SELECT') ? (store.has(a[0]) ? { value: store.get(a[0]) } : null) : null), run: async () => { if (sql.startsWith('INSERT')) store.set(a[0], a[1]); if (sql.startsWith('DELETE')) store.delete(a[0]); return { meta: {} }; } }) }) } as any;
};
const xaiOk = (data: any = good, usage: any = { prompt_tokens: 1200, completion_tokens: 300 }) =>
  new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(data) } }], usage }), { status: 200 });

describe('xai migration', () => {
  it.each([
    ['invalid HTTP JSON', () => new Response('{'), 'INVALID_GENERATION_OUTPUT'],
    ['invalid message JSON', () => new Response(JSON.stringify({ choices: [{ message: { content: '{' } }] })), 'INVALID_GENERATION_OUTPUT'],
    ['missing choices', () => new Response('{}'), 'INVALID_GENERATION_OUTPUT'],
    ['non-string content', () => new Response(JSON.stringify({ choices: [{ message: { content: {} } }] })), 'INVALID_GENERATION_OUTPUT'],
    ['empty content', () => new Response(JSON.stringify({ choices: [{ message: { content: ' ' } }] })), 'INVALID_GENERATION_OUTPUT'],
    ['invalid dimensions', () => xaiOk({ ...good, energy: 4 }), 'INVALID_GENERATION_OUTPUT'],
    ['truncated completion', () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(good) }, finish_reason: 'length' }] })), 'INVALID_GENERATION_OUTPUT'],
    ['body read error', () => ({ ok: true, json: async () => { throw new TypeError('stream interrupted'); } }) as unknown as Response, 'PROVIDER_UNAVAILABLE'],
    ['body timeout', () => ({ ok: true, json: async () => { throw new DOMException('aborted', 'TimeoutError'); } }) as unknown as Response, 'PROVIDER_UNAVAILABLE'],
    ['fetch timeout', () => { throw new DOMException('aborted', 'AbortError'); }, 'PROVIDER_UNAVAILABLE'],
    ['unreadable HTTP 401', () => ({ ok: false, status: 401, headers: new Headers(), text: async () => { throw new Error('read failed'); } }) as unknown as Response, 'INVALID_CREDENTIAL'],
  ] as const)('%s records exactly one failed admitted attempt and classifies it', async (_name, response, code) => {
    const fetcher = vi.fn(async () => response());
    const budget = vi.fn(async () => true);
    const report = vi.fn(async (_outcome: 'success' | 'failed') => {});
    const client = new XaiClient('k', 'grok-4.3', fetcher, budget, report);
    const error = await client.generateJson({ system: 's', prompt: 'p', schema: ENRICHMENT_JSON_SCHEMA }).catch((e) => e);
    expect(classifyProviderError(error).code).toBe(code);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(budget).toHaveBeenCalledTimes(1);
    expect(report.mock.calls).toEqual([['failed']]);
  });
  it.each(['grok-4.3', 'grok-4.3-latest', 'grok-4-3', 'other-model'])('explicit reasoning effort and unchanged structured output: %s', async (model) => {
    const fetcher = vi.fn(async () => xaiOk());
    const report = vi.fn(async (_outcome: 'success' | 'failed') => {});
    const result = await new XaiClient('k', model, fetcher, null, report).generateJson({ system: 's', prompt: 'p', schema: ENRICHMENT_JSON_SCHEMA });
    const body = JSON.parse((fetcher.mock.calls as any)[0][1].body);
    expect(body.reasoning_effort).toBe(model === 'other-model' ? undefined : 'none');
    expect(body.response_format.json_schema).toEqual({ name: 'movie_enrichment', strict: true, schema: ENRICHMENT_JSON_SCHEMA });
    expect(result.data).toEqual(good);
    expect(report.mock.calls).toEqual([['success']]);
  });
  it('retry reports failure then success, denied retry has no outcome', async () => {
    for (const allowed of [1, 2]) {
      let admissions = 0;
      const fetcher = vi.fn(async () => fetcher.mock.calls.length === 1 ? new Response('busy', { status: 500 }) : xaiOk());
      const report = vi.fn(async (_outcome: 'success' | 'failed') => {});
      const client = new XaiClient('k', 'grok-4.3', fetcher, async () => ++admissions <= allowed, report);
      await client.generateJson({ system: 's', prompt: 'p', schema: {} }).catch((e) => expect(e.deferred).toBe(true));
      expect(fetcher).toHaveBeenCalledTimes(allowed);
      expect(report.mock.calls).toEqual(allowed === 1 ? [['failed']] : [['failed'], ['success']]);
    }
  });
  it('usa Groq GPT OSS 120B (modelo atual) e modo seguro desliga geracao por default', () => {
    expect(DEFAULT_GROQ_MODEL).toBe('openai/gpt-oss-120b');
    expect(isMovieGenerationEnabled({} as any)).toBe(false);
    expect(isMovieGenerationEnabled({ MOVIE_GENERATION_ENABLED: 'true' } as any)).toBe(true);
  });
  it('schema Grok alinha pace enum + arrays + dims com o validador', () => {
    expect((ENRICHMENT_JSON_SCHEMA.properties as any).pace.enum).toEqual(['very_slow', 'slow', 'medium', 'fast', 'very_fast']);
    expect(validateEnrichment(good).ok).toBe(true);
  });
  it('xAI gera JSON valido via structured outputs', async () => {
    const c = new XaiClient('k', 'grok-4-3', (async () => xaiOk()) as any);
    const r = await c.generateJson({ system: 's', prompt: 'p', schema: { type: 'object' } });
    expect(r.provider).toBe('xai');
    expect(validateEnrichment(r.data).ok).toBe(true);
    expect(r.usage?.inputTokens).toBe(1200);
  });
  it('schema incompativel e detectado e dimensoes ficam em 0..1', () => {
    expect(validateEnrichment({ ...good, darkness: 2 }).ok).toBe(false);
    expect(validateEnrichment({ ...good, moods: [] }).ok).toBe(false);
    expect(validateEnrichment({ ...good, pace: 'warp' }).ok).toBe(false);
    expect(validateEnrichment({ ...good, energy: 'alta' }).ok).toBe(false);
  });
  it('factory usa Groq sem rollback automatico', () => {
    expect(createMovieGenerationProvider({ XAI_API_KEY: 'k', MOVIE_GENERATION_MODEL: 'm' }).name).toBe('groq');
    expect(() => createMovieGenerationProvider({ MOVIE_GENERATION_PROVIDER: 'gemini', XAI_API_KEY: 'k' })).toThrow('INVALID_REQUEST');
    expect(() => createMovieGenerationProvider({} as any)).toThrow('XAI_API_KEY');
  });
  it('429 abre cooldown, 401 nao repete, credito insuficiente e terminal', () => {
    expect(classifyProviderError(new Error('xAI 429 rate limit')).code).toBe('RATE_LIMITED');
    expect(classifyProviderError(new Error('Gemini 429 quota exceeded resource_exhausted')).code).toBe('QUOTA_EXHAUSTED');
    const cred = classifyProviderError(new Error('xAI 401 incorrect api key'));
    expect(cred.code).toBe('INVALID_CREDENTIAL');
    expect(cred.retryable).toBe(false);
    expect(classifyProviderError(new Error('payment required: insufficient credits')).code).toBe('INSUFFICIENT_CREDITS');
    expect(classifyProviderError(new Error('too many subrequests')).code).toBe('WORKER_SUBREQUEST_LIMIT');
  });
  it('D1 indisponivel fecha o circuito (fail-closed), nao libera chamadas', async () => {
    const badDb = { prepare: () => { throw new Error('D1 down'); } } as any;
    const s = await circuitState(badDb, 'generation-xai');
    expect(s.open).toBe(true);
    expect(s.unknown).toBe(true);
  });
  it('circuit breaker abre e fecha com persistencia minima', async () => {
    const db = memDb();
    await openCircuit(db, 'generation-xai', 600, '429');
    expect((await circuitState(db, 'generation-xai')).open).toBe(true);
    await closeCircuit(db, 'generation-xai');
    expect((await circuitState(db, 'generation-xai')).open).toBe(false);
  });
  it('xAI 429 tenta uma vez e propaga status para cooldown', async () => {
    let n = 0;
    const f = (async () => { n++; return n === 1 ? new Response('busy', { status: 429 }) : xaiOk(); }) as any;
    const c = new XaiClient('k', 'm', f);
    await c.generateJson({ system: 's', prompt: 'p', schema: {} });
    expect(n).toBe(2);
    const f2 = (async () => new Response('denied', { status: 401 })) as any;
    await expect(new XaiClient('k', 'm', f2).generateJson({ system: 's', prompt: 'p', schema: {} })).rejects.toMatchObject({ status: 401 });
  });
  it('gate por tentativa nega o retry interno sem rede quando o orcamento esgota', async () => {
    let n = 0;
    const f = (async () => { n++; return new Response('busy', { status: 429 }); }) as any;
    const c = new XaiClient('k', 'm', f);
    let budget = 1;
    c.setAttemptBudget(async () => (budget-- > 0));
    await expect(c.generateJson({ system: 's', prompt: 'p', schema: {} })).rejects.toMatchObject({ deferred: true, status: 429 });
    expect(n).toBe(1); // retry interno negado ANTES do HTTP: 1 chamada real, nao 2
  });
  it('limite 25: 100 jobs concorrentes com 429/500/timeout enviam no maximo 25 HTTP', async () => {
    const Database = (await import('better-sqlite3')).default;
    const fs = (await import('node:fs')).default;
    const tdb = new Database(':memory:');
    for (const f of fs.readdirSync('migrations').filter((x) => x.endsWith('.sql')).sort()) tdb.exec(fs.readFileSync(`migrations/${f}`, 'utf8'));
    const stmt = (sql: string) => ({ bind: (...a: any[]) => ({ run: async () => ({ meta: { changes: tdb.prepare(sql).run(...a).changes } }) }) });
    const idx = (await import('../workers/pipeline/src/index.js')) as any;
    const limit = 25;
    let http = 0;
    const outcomes: string[] = [];
    const behaviors = ['gone-429', 'gone-500', 'timeout', 'ok'];
    const stub = (async () => {
      http++;
      const b = behaviors[(http - 1) % behaviors.length];
      if (b === 'gone-429') return new Response('busy', { status: 429 });
      if (b === 'gone-500') return new Response('boom', { status: 500 });
      if (b === 'timeout') throw new Error('fetch failed: timeout');
      return xaiOk();
    }) as any;
    const runOne = async () => {
      const mod = await import('../workers/pipeline/src/xai-client.js');
      const c = new mod.XaiClient('k', 'grok-4-3', stub);
      c.setAttemptBudget(() => idx.__testPilotConsume({ prepare: stmt } as any, limit));
      c.setAttemptReporter(async (outcome) => { outcomes.push(outcome); });
      try { await c.generateJson({ system: 's', prompt: 'p', schema: { type: 'object' } }); return 'ok'; }
      catch (e: any) { return e?.deferred === true ? 'deferred' : 'failed'; }
    };
    const results = await Promise.all(Array.from({ length: 100 }, runOne));
    // Teto absoluto de HTTP reais no dia: 25 tentativas (inclui retries).
    expect(http).toBe(25);
    expect(outcomes).toHaveLength(http);
    const ok = results.filter((r) => r === 'ok').length;
    const deferred = results.filter((r) => r === 'deferred').length;
    expect(ok + deferred + results.filter((r) => r === 'failed').length).toBe(100);
    expect(deferred).toBeGreaterThan(0);
    // Metrica do dia: attempts == HTTP reais.
    const row = tdb.prepare(`SELECT value FROM system_state WHERE key='gen_pilot_count:groq'`).get() as any;
    expect(JSON.parse(row.value).attempts).toBe(http);
  });
});
