import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMovieGenerationProvider, DEFAULT_GROQ_MODEL } from '../workers/pipeline/src/generation-factory';
import { GroqClient, groqCooldown, groqDuration, groqStructuredSchema } from '../workers/pipeline/src/groq-client';
import { ENRICHMENT_JSON_SCHEMA, validateEnrichment, VIBE_DIMS } from '../workers/pipeline/src/generation-provider';
import { classifyProviderError } from '../workers/pipeline/src/provider-errors';

const good = { moods: ['tense'], themes: ['revenge'], atmosphere: ['dark'], pace: 'slow', visual_style: ['noir'], emotional_valence: .2, energy: .7, intimacy: .3, surrealism: .1, darkness: .9, humor: .05, romanticism: .1, narrative_density: .6, melancholy_level: .5, tension_level: .9, confidence: .85 };
const request = { system: 'Analyze cinematic aesthetics; numeric dimensions 0..1.', prompt: 'Verified film facts', schema: ENRICHMENT_JSON_SCHEMA };
const ok = (data: unknown = good, headers: Record<string, string> = {}) => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(data) }, finish_reason: 'stop' }], usage: { prompt_tokens: 200, completion_tokens: 400 } }), { headers });
afterEach(() => { vi.unstubAllGlobals(); });

describe('GroqCloud generation', () => {
  it('factory reads legacy XAI_API_KEY and sends only to Groq with strict schema and low reasoning', async () => {
    const fetcher = vi.fn(async () => ok());
    vi.stubGlobal('fetch', fetcher);
    const client = createMovieGenerationProvider({ XAI_API_KEY: 'test-groq-secret' });
    expect(client.name).toBe('groq');
    const result = await client.generateJson(request);
    const [url, init] = (fetcher.mock.calls as any)[0];
    expect(url).toBe('https://api.groq.com/openai/v1/chat/completions');
    expect(init.headers.Authorization).toBe('Bearer test-groq-secret');
    const body = JSON.parse(init.body);
    expect(body).toMatchObject({ model: 'openai/gpt-oss-120b', reasoning_effort: 'low', include_reasoning: false, temperature: .2, max_completion_tokens: 2048 });
    expect(body.response_format).toEqual({ type: 'json_schema', json_schema: { name: 'movie_enrichment', strict: true, schema: groqStructuredSchema(ENRICHMENT_JSON_SCHEMA) } });
    expect(result).toMatchObject({ provider: 'groq', model: DEFAULT_GROQ_MODEL, data: good, usage: { inputTokens: 200, outputTokens: 400 } });
    expect(fetcher).toHaveBeenCalledTimes(1);
    for (const which of ['xai', 'gemini', 'unknown']) expect(() => createMovieGenerationProvider({ MOVIE_GENERATION_PROVIDER: which, XAI_API_KEY: 'test' })).toThrow('INVALID_REQUEST');
    expect(classifyProviderError((() => { try { createMovieGenerationProvider({}); } catch (e) { return e; } })()).code).toBe('INVALID_CREDENTIAL');
  });
  it('portable strict schema preserves every field, required array, pace enum and business validation', () => {
    const schema = groqStructuredSchema(ENRICHMENT_JSON_SCHEMA);
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toEqual(Object.keys(schema.properties));
    expect(schema.required).toEqual(ENRICHMENT_JSON_SCHEMA.required);
    expect(schema.properties.pace).toEqual(ENRICHMENT_JSON_SCHEMA.properties.pace);
    expect(VIBE_DIMS).toHaveLength(10);
    expect(Object.keys(schema.properties)).toHaveLength(16);
    expect(validateEnrichment(good).ok).toBe(true);
    for (const field of VIBE_DIMS) expect(validateEnrichment({ ...good, [field]: 1.01 }).ok).toBe(false);
    for (const field of schema.required) { const missing: any = { ...good }; delete missing[field]; expect(validateEnrichment(missing).ok).toBe(false); }
    expect(validateEnrichment({ ...good, moods: [] }).ok).toBe(false);
    expect(validateEnrichment({ ...good, moods: ['x'.repeat(81)] }).ok).toBe(false);
    expect(ENRICHMENT_JSON_SCHEMA.properties.energy.maximum).toBe(1);
  });
  it.each([
    [400, 'Incorrect API key provided', 'INVALID_CREDENTIAL', 1],
    [401, 'Unauthorized', 'INVALID_CREDENTIAL', 1],
    [403, 'Forbidden', 'INVALID_CREDENTIAL', 1],
    [400, 'unsupported parameter', 'INVALID_REQUEST', 1],
    [422, 'unprocessable request', 'INVALID_REQUEST', 1],
    [429, 'Rate limit reached on requests per minute', 'RATE_LIMITED', 1],
    [429, 'Rate limit reached on tokens per day (TPD)', 'QUOTA_EXHAUSTED', 1],
    [500, 'server failure', 'PROVIDER_UNAVAILABLE', 2],
    [503, 'overloaded', 'PROVIDER_UNAVAILABLE', 2],
  ] as const)('HTTP %s %s is classified and each real HTTP is counted', async (status, text, code, attempts) => {
    const fetcher = vi.fn(async () => new Response(text, { status }));
    const report = vi.fn(async (_outcome: string) => {});
    const budget = vi.fn(async () => true);
    const client = new GroqClient('test-secret', DEFAULT_GROQ_MODEL, fetcher);
    client.setAttemptBudget(budget); client.setAttemptReporter(report);
    const error = await client.generateJson(request).catch((e) => e);
    expect(classifyProviderError(error).code).toBe(code);
    expect(fetcher).toHaveBeenCalledTimes(attempts);
    expect(report.mock.calls).toEqual(Array.from({ length: attempts }, () => ['failed']));
    expect(budget).toHaveBeenCalledTimes(attempts);
    if (status === 429) expect(error.deferred).toBe(true);
    if (code === 'QUOTA_EXHAUSTED') expect(error.retryAfter).toBe(86400);
  });
  it.each([
    ['HTTP JSON', () => new Response('{'), 'INVALID_GENERATION_OUTPUT'],
    ['content JSON', () => new Response(JSON.stringify({ choices: [{ message: { content: '{' } }] })), 'INVALID_GENERATION_OUTPUT'],
    ['structure', () => new Response('{}'), 'INVALID_GENERATION_OUTPUT'],
    ['content type', () => new Response(JSON.stringify({ choices: [{ message: { content: [] } }] })), 'INVALID_GENERATION_OUTPUT'],
    ['business bounds', () => ok({ ...good, energy: -1 }), 'INVALID_GENERATION_OUTPUT'],
    ['read', () => ({ ok: true, headers: new Headers(), json: async () => { throw new TypeError('stream interrupted'); } }) as unknown as Response, 'PROVIDER_UNAVAILABLE'],
    ['timeout', () => { throw new DOMException('aborted', 'AbortError'); }, 'PROVIDER_UNAVAILABLE'],
    ['unreadable 401', () => ({ ok: false, status: 401, headers: new Headers(), text: async () => { throw new Error('read failed'); } }) as unknown as Response, 'INVALID_CREDENTIAL'],
  ] as const)('%s failure is counted once and never UNKNOWN', async (_name, response, code) => {
    const fetcher = vi.fn(async () => response());
    const report = vi.fn(async (_outcome: string) => {});
    const client = new GroqClient('test-secret', DEFAULT_GROQ_MODEL, fetcher);
    client.setAttemptReporter(report);
    const error = await client.generateJson(request).catch((e) => e);
    expect(classifyProviderError(error).code).toBe(code);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(report.mock.calls).toEqual([['failed']]);
  });
  it('retry consumes a new slot; denied retry has no HTTP or outcome', async () => {
    let remaining = 1;
    const fetcher = vi.fn(async () => new Response('busy', { status: 500 }));
    const report = vi.fn(async (_outcome: string) => {});
    const client = new GroqClient('test-secret', DEFAULT_GROQ_MODEL, fetcher);
    client.setAttemptBudget(async () => remaining-- > 0); client.setAttemptReporter(report);
    await expect(client.generateJson(request)).rejects.toMatchObject({ deferred: true });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(report.mock.calls).toEqual([['failed']]);
  });
  it('never exposes a credential echoed by the server', async () => {
    const client = new GroqClient('secret-to-hide', DEFAULT_GROQ_MODEL, async () => new Response('Incorrect API key: secret-to-hide', { status: 400 }));
    const error = await client.generateJson(request).catch((e) => e);
    expect(error.message).not.toContain('secret-to-hide');
    expect(classifyProviderError(error).code).toBe('INVALID_CREDENTIAL');
  });
  it('503 Retry-After suppresses internal retries and is preserved for the durable job', async () => {
    const fetcher = vi.fn(async () => new Response('unavailable', { status: 503, headers: { 'Retry-After': '900' } }));
    const error = await new GroqClient('test-secret', DEFAULT_GROQ_MODEL, fetcher).generateJson(request).catch((e) => e);
    expect(classifyProviderError(error)).toMatchObject({ code: 'PROVIDER_UNAVAILABLE', retryAfterSeconds: 900 });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

describe('Groq rate limit headers', () => {
  it.each([['2m59.56s', 180], ['24h0m0s', 86400], ['7.66s', 8], ['1d2h', 93600], ['10ms', 1], ['bad', 0]] as const)('parses %s', (text, expected) => expect(groqDuration(text)).toBe(expected));
  it.each([
    [{ 'retry-after': '120' }, 'RPM', 120, false],
    [{ 'x-ratelimit-remaining-requests': '0', 'x-ratelimit-reset-requests': '23h2m' }, '', 82920, true],
    [{ 'x-ratelimit-remaining-tokens': '0', 'x-ratelimit-reset-tokens': '2m10s' }, '', 130, false],
    [{ 'retry-after': '7200', 'x-ratelimit-remaining-tokens': '0', 'x-ratelimit-reset-tokens': '1s' }, 'TPD', 7200, true],
    [{}, 'daily tokens exhausted', 86400, true],
    [{}, 'Requests per minute. Please try again in 2m30s. Visit the console.', 150, false],
  ] as const)('honors cooldown %j', (headers, message, seconds, daily) => expect(groqCooldown(new Headers(headers as Record<string, string>), 429, message)).toEqual({ seconds, daily }));
  it('supports Retry-After as an HTTP date', () => {
    const result = groqCooldown(new Headers({ 'Retry-After': new Date(Date.now() + 600000).toUTCString() }), 429);
    expect(result.seconds).toBeGreaterThanOrEqual(599);
    expect(result.seconds).toBeLessThanOrEqual(600);
  });
});
