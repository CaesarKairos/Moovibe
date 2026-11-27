import { GroqClient } from './groq-client';
import { reserveCapacity, recordCapacity } from './groq-capacity';
import { circuitState, openCircuit, closeCircuit } from './generation-provider';
import { classifyProviderError } from './provider-errors';

interface Env {
  ADMIN_TOKEN?: string;
  XAI_API_KEY?: string;
  GROQ_API_KEY?: string;
  MOVIE_GENERATION_MODEL?: string;
  MOVIE_GENERATION_ENABLED?: string;
  RECOMMENDATION_GROQ_MODEL?: string;
  MOVIE_GENERATION_PILOT_LIMIT?: string;
  MOOVIBE_LIBRARY: D1Database;
  [key: string]: unknown;
}

const CIRCUIT = 'generation-groq';
const STAGES = new Set(['song_profile', 'final_curation']);
const json = (data: unknown, status = 200, retryAfter?: number) =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      ...(retryAfter ? { 'retry-after': String(retryAfter) } : {})
    }
  });

export async function handleRecommendationGeneration(request: Request, env: Env): Promise<Response> {
  if (!env.ADMIN_TOKEN || request.headers.get('authorization') !== `Bearer ${env.ADMIN_TOKEN}`)
    return json({ error: 'unauthorized' }, 401);
  if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
  if (String(env.MOVIE_GENERATION_ENABLED || 'false').toLowerCase() !== 'true')
    return json({ error: 'Groq recommendation generation is disabled', code: 'PROVIDER_UNAVAILABLE' }, 503);

  const raw = await request.text();
  if (new TextEncoder().encode(raw).length > 32_768) return json({ error: 'payload_too_large' }, 413);
  let body: any;
  try { body = JSON.parse(raw); }
  catch { return json({ error: 'invalid_json' }, 400); }
  if (
    !body || !STAGES.has(body.stage) ||
    typeof body.system !== 'string' || body.system.length > 5000 ||
    typeof body.prompt !== 'string' || body.prompt.length > 20_000 ||
    !body.schema || typeof body.schema !== 'object' || Array.isArray(body.schema) ||
    typeof body.temperature !== 'number' || body.temperature < 0 || body.temperature > 1 ||
    ![512, 1024, 1536, 2048].includes(body.maxCompletionTokens)
  ) return json({ error: 'invalid_request', code: 'INVALID_REQUEST' }, 422);

  const model = env.RECOMMENDATION_GROQ_MODEL || env.MOVIE_GENERATION_MODEL || 'openai/gpt-oss-120b';
  const apiKey = env.XAI_API_KEY || env.GROQ_API_KEY || '';
  if (!apiKey) return json({ error: 'Groq credential is not configured', code: 'INVALID_CREDENTIAL', model }, 503);

  const circuit = await circuitState(env.MOOVIBE_LIBRARY, CIRCUIT);
  if (circuit.open) return json({ error: 'Groq generation circuit is open', code: 'PROVIDER_UNAVAILABLE', model }, 503);

  let reservation: { id?: string; day: string; tokens: number } | null = null;
  const client = new GroqClient(apiKey, model, null, body.maxCompletionTokens, {
    maxAttempts: 1,
    schemaName: `recommendation_${body.stage}`,
    validate: () => ({ ok: true }),
    estimateTokens: (bytes, outputTokens) => Math.ceil(bytes * 0.5) + outputTokens + 512
  });
  client.setAttemptBudget(async tokens => {
    const current = await circuitState(env.MOOVIBE_LIBRARY, CIRCUIT);
    if (current.open) {
      const error: any = new Error('Groq generation circuit is open');
      error.provider = 'groq';
      error.deferred = true;
      throw error;
    }
    reservation = await reserveCapacity(env.MOOVIBE_LIBRARY, env, tokens, Date.now(), 'interactive');
    return true;
  });
  client.setTelemetryReporter(async event => {
    if (reservation) await recordCapacity(env.MOOVIBE_LIBRARY, reservation, event);
  });
  client.setCooldownReporter(async (seconds, reason) => {
    await openCircuit(env.MOOVIBE_LIBRARY, CIRCUIT, seconds, reason);
  });

  try {
    const result = await client.generateJson({
      system: body.system,
      prompt: body.prompt,
      schema: body.schema,
      temperature: body.temperature
    });
    await closeCircuit(env.MOOVIBE_LIBRARY, CIRCUIT);
    return json({ ...result, stage: body.stage });
  } catch (error: any) {
    const classified = classifyProviderError(error);
    const retryAfter = error?.retryAfter || classified.retryAfterSeconds || 0;
    if (!error?.deferred && ['QUOTA_EXHAUSTED', 'RATE_LIMITED', 'PROVIDER_UNAVAILABLE', 'TIMEOUT', 'INVALID_CREDENTIAL', 'INSUFFICIENT_CREDITS'].includes(classified.code)) {
      await openCircuit(env.MOOVIBE_LIBRARY, CIRCUIT, Math.max(60, retryAfter || 120), `groq ${classified.code} ${classified.httpStatus || ''}`.trim());
    }
    const status = classified.httpStatus || (classified.code === 'INVALID_GENERATION_OUTPUT' ? 502 : 503);
    return json({
      error: String(error?.message || error).slice(0, 500),
      code: classified.code,
      status,
      retryAfter,
      model,
      deferred: Boolean(error?.deferred)
    }, status, retryAfter || undefined);
  }
}
