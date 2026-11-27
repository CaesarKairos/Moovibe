import { GeminiClient } from './gemini.js';
import { writeAudit } from './audit.js';
import { GroqClient } from '../../workers/pipeline/src/groq-client.ts';
import { reserveCapacity, recordCapacity } from '../../workers/pipeline/src/groq-capacity.ts';
import { classifyProviderError } from '../../workers/pipeline/src/provider-errors.ts';
import { circuitState, openCircuit, closeCircuit } from '../../workers/pipeline/src/generation-provider.ts';

const GEMINI_MODELS = ['gemini-2.5-flash-lite', 'gemini-2.5-flash'];
const GROQ_CIRCUIT = 'generation-groq';
const GEMINI_CIRCUIT = 'generation-gemini';

export class RecommendationGenerationError extends Error {
  constructor(stage, failures, attempts) {
    super('No text-generation provider completed stage ' + stage);
    this.name = 'RecommendationGenerationError';
    this.stage = stage;
    this.failures = failures;
    this.attempts = attempts;
    this.provider = failures.at(-1)?.provider || 'generation';
    this.code = failures.at(-1)?.code || 'PROVIDER_UNAVAILABLE';
    this.status = failures.at(-1)?.status || null;
    this.retryAfter = failures.at(-1)?.retryAfter || 0;
  }
}

const validationError = result => result?.ok === false ? new Error(`INVALID_GENERATION_OUTPUT ${result.error || 'schema validation failed'}`) : null;
const cleanFailure = (provider, error, attemptedModels = []) => {
  const classified = classifyProviderError(error);
  return {
    provider,
    model: error?.model || null,
    code: classified.code,
    status: classified.httpStatus,
    retryAfter: classified.retryAfterSeconds,
    attemptedModels: error?.attemptedModels || attemptedModels,
    message: String(error?.message || error).slice(0, 500)
  };
};

/**
 * @param {any} env
 * @param {{requestId?: string, maxAttempts?: number}} options
 */
export function createRecommendationGenerator(env, { requestId, maxAttempts = 12 } = {}) {
  const limit = Math.max(1, Math.min(12, Number(maxAttempts) || 12));
  const gemini = env.GEMINI_API_KEY
    ? new GeminiClient(env.GEMINI_API_KEY, null, { maxAttempts: 1, maxModels: 2, models: GEMINI_MODELS })
    : null;
  let totalAttempts = 0;

  const logAttempt = fields => console.log(JSON.stringify({
    event: 'text_generation_attempt',
    request_id: requestId,
    at: new Date().toISOString(),
    ...fields
  }));

  async function generateJson({ stage, system, prompt, schema, temperature = 0.2, validate, maxCompletionTokens = 1024 }) {
    const failures = [];
    for (const provider of ['gemini', 'groq']) {
      if (totalAttempts >= limit) break;
      const circuitKey = provider === 'gemini' ? GEMINI_CIRCUIT : GROQ_CIRCUIT;
      const circuit = await circuitState(env.MOOVIBE_LIBRARY, circuitKey);
      if (circuit.open) {
        const failure = { provider, model: null, code: 'PROVIDER_UNAVAILABLE', status: null, retryAfter: 0, attemptedModels: [], message: 'provider circuit open' };
        failures.push(failure);
        logAttempt({ stage, ...failure, circuit_open: true, attempts_used: totalAttempts });
        continue;
      }

      let model = null;
      let reservation = null;
      let attemptsCounted = false;
      const started = Date.now();
      try {
        let result;
        if (provider === 'gemini') {
          if (!gemini) throw Object.assign(new Error('GEMINI_API_KEY is not configured'), { provider: 'gemini' });
          gemini.maxModels = Math.min(2, limit - totalAttempts);
          result = await gemini.generateJson({ system, prompt, schema, temperature });
          model = result.model;
          totalAttempts += result.attemptedModels?.length || 1;
          attemptsCounted = true;
        } else {
          const apiKey = env.XAI_API_KEY || env.GROQ_API_KEY;
          const groqModel = env.RECOMMENDATION_GROQ_MODEL || env.MOVIE_GENERATION_MODEL || 'openai/gpt-oss-120b';
          model = groqModel;
          if (!apiKey && env.PIPELINE_WORKER_URL && env.PIPELINE_ADMIN_TOKEN) {
            const response = await fetch(new URL('/internal/recommendation-generation', env.PIPELINE_WORKER_URL), {
              method: 'POST',
              headers: {
                authorization: `Bearer ${env.PIPELINE_ADMIN_TOKEN}`,
                'content-type': 'application/json'
              },
              body: JSON.stringify({ stage, system, prompt, schema, temperature, maxCompletionTokens }),
              signal: AbortSignal.timeout(60_000)
            });
            const payload = await response.json().catch(() => ({}));
            if (!response.ok) {
              const error = new Error(payload.error || `Groq relay HTTP ${response.status}`);
              error.provider = 'groq';
              error.status = payload.status || response.status;
              error.retryAfter = payload.retryAfter || Number(response.headers.get('retry-after')) || 0;
              error.model = payload.model || model;
              error.deferred = Boolean(payload.deferred);
              throw error;
            }
            result = payload;
            totalAttempts++;
            attemptsCounted = true;
          } else {
          const client = new GroqClient(apiKey || '', groqModel, null, maxCompletionTokens, {
            maxAttempts: 1,
            schemaName: `recommendation_${String(stage).replace(/[^a-z0-9_]/gi, '_')}`.slice(0, 64),
            validate: data => validate(data),
            estimateTokens: (bytes, outputTokens) => Math.ceil(bytes * 0.5) + outputTokens + 512
          });
          client.setAttemptBudget(async tokens => {
            const current = await circuitState(env.MOOVIBE_LIBRARY, GROQ_CIRCUIT);
            if (current.open) {
              const error = new Error('Groq generation circuit is open');
              error.provider = 'groq'; error.deferred = true;
              throw error;
            }
            reservation = await reserveCapacity(env.MOOVIBE_LIBRARY, env, tokens, Date.now(), 'interactive');
            return true;
          });
          client.setTelemetryReporter(async event => {
            if (reservation) await recordCapacity(env.MOOVIBE_LIBRARY, reservation, event);
          });
          result = await client.generateJson({ system, prompt, schema, temperature });
          totalAttempts++;
          attemptsCounted = true;
          }
        }

        const invalid = validationError(validate(result.data));
        if (invalid) {
          invalid.provider = provider;
          invalid.model = model;
          throw invalid;
        }
        await closeCircuit(env.MOOVIBE_LIBRARY, circuitKey);
        const metadata = { stage, provider, model, attempts_used: totalAttempts, duration_ms: Date.now() - started, success: true };
        logAttempt(metadata);
        await writeAudit(env, { request_id: requestId, stage, provider, model, attempts: totalAttempts, duration_ms: Date.now() - started, success: true });
        return { ...result, provider, model, attempts: totalAttempts };
      } catch (error) {
        const used = attemptsCounted ? 0 : (error?.attemptedModels?.length || (provider === 'groq' && !error?.deferred ? 1 : 0));
        totalAttempts = Math.min(limit, totalAttempts + used);
        const failure = cleanFailure(provider, error, error?.attemptedModels || []);
        failure.model = model;
        failures.push(failure);
        logAttempt({ stage, ...failure, attempts_used: totalAttempts, duration_ms: Date.now() - started });
        const code = failure.code;
        if (['QUOTA_EXHAUSTED', 'RATE_LIMITED', 'PROVIDER_UNAVAILABLE', 'TIMEOUT', 'INVALID_CREDENTIAL', 'INSUFFICIENT_CREDITS'].includes(code)) {
          const delay = code === 'INVALID_CREDENTIAL' || code === 'INSUFFICIENT_CREDITS'
            ? 43200
            : Math.max(60, failure.retryAfter || 120);
          await openCircuit(env.MOOVIBE_LIBRARY, circuitKey, delay, `${provider} ${code} ${failure.status || ''}`.trim());
        }
      }
    }
    throw new RecommendationGenerationError(stage, failures, totalAttempts);
  }

  return { generateJson, getAttempts: () => totalAttempts };
}
