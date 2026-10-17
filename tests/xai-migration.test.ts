import { describe, expect, it, vi } from 'vitest';
import { classifyProviderError } from '../workers/pipeline/src/provider-errors';
import { circuitState, closeCircuit, openCircuit, validateEnrichment } from '../workers/pipeline/src/generation-provider';
import { createMovieGenerationProvider } from '../workers/pipeline/src/generation-factory';
import { XaiClient } from '../workers/pipeline/src/xai-client';

const good = { moods: ['tense'], themes: ['revenge'], atmosphere: ['dark'], pace: 'slow', visual_style: ['noir'], emotional_valence: 0.2, energy: 0.7, intimacy: 0.3, surrealism: 0.1, darkness: 0.9, humor: 0.05, romanticism: 0.1, narrative_density: 0.6, melancholy_level: 0.5, tension_level: 0.9, confidence: 0.85 };
const memDb = () => {
  const store = new Map<string, string>();
  return { prepare: (sql: string) => ({ bind: (...a: any[]) => ({ first: async () => (sql.includes('SELECT') ? (store.has(a[0]) ? { value: store.get(a[0]) } : null) : null), run: async () => { if (sql.startsWith('INSERT')) store.set(a[0], a[1]); if (sql.startsWith('DELETE')) store.delete(a[0]); return { meta: {} }; } }) }) } as any;
};
const xaiOk = (data: any = good, usage: any = { prompt_tokens: 1200, completion_tokens: 300 }) =>
  new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(data) } }], usage }), { status: 200 });

describe('xai migration', () => {
  it('xAI gera JSON valido via structured outputs', async () => {
    const c = new XaiClient('k', 'grok-4-1-fast-non-reasoning', (async () => xaiOk()) as any);
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
  it('factory usa xai por padrao e gemini como rollback', () => {
    expect(createMovieGenerationProvider({ XAI_API_KEY: 'k', MOVIE_GENERATION_MODEL: 'm' }).name).toBe('xai');
    expect(createMovieGenerationProvider({ MOVIE_GENERATION_PROVIDER: 'gemini', GEMINI_API_KEY: 'k' }).name).toBe('gemini');
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
});
