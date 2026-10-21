import type { GenerationProvider, GenerationRequest, GenerationResult } from './generation-provider';
import { validateEnrichment } from './generation-provider';

const API = 'https://api.groq.com/openai/v1/chat/completions';
type Outcome = 'success' | 'failed';
export class GroqError extends Error {
  readonly provider = 'groq';
  deferred = false;
  constructor(message: string, public status: number | null = null, public retryAfter = 0, public quotaExhausted = false) {
    super(message); this.name = 'GroqError';
    this.deferred = status === 429;
  }
}

// Portable strict subset documented by Groq. Bounds are enforced by the
// unchanged application validator, preserving every cinematic field.
export function groqStructuredSchema(schema: any): any {
  if (Array.isArray(schema)) return schema.map(groqStructuredSchema);
  if (!schema || typeof schema !== 'object') return schema;
  return Object.fromEntries(Object.entries(schema)
    .filter(([key]) => !['minLength', 'maxLength', 'minItems', 'maxItems', 'minimum', 'maximum'].includes(key))
    .map(([key, value]) => [key, groqStructuredSchema(value)]));
}

// Groq reset headers use Go-style durations (e.g. 2m59.56s, 24h0m0s).
export function groqDuration(value: string | null): number {
  if (!value) return 0;
  if (/^\d+(?:\.\d+)?$/.test(value)) return Math.ceil(Number(value));
  const units: Record<string, number> = { d: 86400, h: 3600, m: 60, s: 1, ms: .001 };
  const matches = [...value.matchAll(/(\d+(?:\.\d+)?)(ms|d|h|m|s)/g)];
  if (matches.map((m) => m[0]).join('') !== value) return 0;
  return Math.ceil(matches.reduce((seconds, m) => seconds + Number(m[1]) * units[m[2]], 0));
}

export function groqCooldown(headers: Headers, status: number, message = ''): { seconds: number; daily: boolean } {
  const retry = headers.get('retry-after');
  const retrySeconds = retry && !/^\d+(?:\.\d+)?$/.test(retry)
    ? Math.max(0, Math.ceil((Date.parse(retry) - Date.now()) / 1000)) || 0 : groqDuration(retry);
  const empty = (name: string) => headers.has(name) && Number(headers.get(name)) <= 0;
  // Requests headers ALWAYS describe RPD; tokens headers describe TPM.
  const daily = empty('x-ratelimit-remaining-requests') || /\b(rpd|tpd)\b|per day|daily/i.test(message);
  const requestReset = groqDuration(headers.get('x-ratelimit-reset-requests'));
  const tokenReset = groqDuration(headers.get('x-ratelimit-reset-tokens'));
  const bodyReset = groqDuration(message.match(/try again in\s+((?:\d+(?:\.\d+)?(?:ms|d|h|m|s))+)/i)?.[1] || null);
  const seconds = Math.max(retrySeconds, bodyReset,
    empty('x-ratelimit-remaining-requests') ? requestReset || 86400 : 0,
    empty('x-ratelimit-remaining-tokens') ? tokenReset || 60 : 0,
    daily && !retrySeconds && !bodyReset && !empty('x-ratelimit-remaining-requests') ? 86400 : 0,
    status === 429 ? 60 : 0);
  return { seconds: Math.min(86400, seconds), daily };
}

export class GroqClient implements GenerationProvider {
  readonly name = 'groq';
  private budget: (() => Promise<boolean>) | null = null;
  private reporter: ((outcome: Outcome) => Promise<void>) | null = null;
  private cooldownReporter: ((seconds: number, reason: string) => Promise<void>) | null = null;
  constructor(private apiKey: string, private model: string, private fetcher: typeof fetch | null = null) {
    if (!apiKey) throw new Error('INVALID_CREDENTIAL Groq requires XAI_API_KEY (legacy secret name for GroqCloud)');
    if (!model) throw new Error('INVALID_REQUEST MOVIE_GENERATION_MODEL is required');
  }
  setAttemptBudget(fn: () => Promise<boolean>): void { this.budget = fn; }
  setAttemptReporter(fn: (outcome: Outcome) => Promise<void>): void { this.reporter = fn; }
  setCooldownReporter(fn: (seconds: number, reason: string) => Promise<void>): void { this.cooldownReporter = fn; }
  private redact(value: unknown): string { return String(value).split(this.apiKey).join('[REDACTED]').slice(0, 500); }
  async generateJson({ system, prompt, schema, temperature = .2 }: GenerationRequest): Promise<GenerationResult> {
    // Prepare locally before admitting an HTTP attempt.
    const body = JSON.stringify({ model: this.model,
      messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }],
      temperature, max_completion_tokens: 2048, reasoning_effort: 'low', include_reasoning: false,
      response_format: { type: 'json_schema', json_schema: { name: 'movie_enrichment', strict: true, schema: groqStructuredSchema(schema) } }
    });
    for (let attempt = 0; attempt < 2; attempt++) {
      if (this.budget && !(await this.budget())) {
        const denied = new GroqError('Groq pilot limit reached; attempt denied before network');
        denied.deferred = true;
        denied.retryAfter = Math.max(60, Math.ceil((86400000 - Date.now() % 86400000) / 1000));
        throw denied;
      }
      let outcome: Outcome = 'failed';
      let retry = false;
      try {
        let response: Response;
        try {
          response = await (this.fetcher || globalThis.fetch).call(globalThis, API, {
            method: 'POST', signal: AbortSignal.timeout(60_000),
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.apiKey}` }, body
          });
        } catch (e: any) { throw new GroqError(`Groq fetch failed: ${this.redact(e?.message || e)}`); }
        if (!response.ok) {
          const text = await response.text().catch(() => 'unreadable response body');
          const cooldown = groqCooldown(response.headers, response.status, text);
          // A 429 always yields to the durable queue/circuit, never a short retry.
          throw new GroqError(`Groq ${response.status}: ${this.redact(text)}`, response.status, cooldown.seconds, cooldown.daily);
        }
        const cooldown = groqCooldown(response.headers, response.status);
        if (cooldown.seconds && this.cooldownReporter) await this.cooldownReporter(cooldown.seconds, cooldown.daily ? 'Groq daily request limit' : 'Groq token limit');
        let data: any;
        try { data = await response.json(); }
        catch (e) {
          if (e instanceof SyntaxError) throw new GroqError('Groq invalid output: invalid or truncated response JSON');
          throw new GroqError(`Groq fetch failed while reading response: ${this.redact((e as any)?.message || e)}`);
        }
        const choice = data?.choices?.[0];
        if (typeof choice?.message?.content !== 'string' || !choice.message.content.trim() || choice.finish_reason === 'length') {
          throw new GroqError('Groq invalid output: missing string content or truncated completion');
        }
        let parsed: any;
        try { parsed = JSON.parse(choice.message.content); }
        catch { throw new GroqError('Groq invalid output: invalid message JSON'); }
        const validation = validateEnrichment(parsed);
        if (!validation.ok) throw new GroqError(`Groq invalid output: ${validation.error}`);
        outcome = 'success';
        return { data: parsed, model: this.model, provider: this.name,
          usage: { inputTokens: data?.usage?.prompt_tokens, outputTokens: data?.usage?.completion_tokens } };
      } catch (e) {
        // Every retry rechecks the circuit and consumes its own pilot slot.
        retry = attempt === 0 && e instanceof GroqError && [408, 500, 502, 503, 504].includes(e.status || 0) && !e.retryAfter;
        if (!retry) throw e;
      } finally {
        try { if (this.reporter) await this.reporter(outcome); } catch { /* existing best-effort metrics contract */ }
      }
      if (retry) await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new GroqError('Groq provider unavailable', 503);
  }
}
