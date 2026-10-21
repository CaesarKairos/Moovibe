import type { GenerationProvider, GenerationRequest, GenerationResult } from './generation-provider';
import { validateEnrichment } from './generation-provider';
const API = 'https://api.x.ai/v1';
export class XaiError extends Error {
  status: number | null; retryAfter: number;
  constructor(message: string, status: number | null = null, retryAfter = 0) {
    super(message); this.name = 'XaiError'; this.status = status; this.retryAfter = retryAfter;
  }
}
const invalidOutput = (detail: string) => new XaiError(`xAI invalid output: ${detail}`);
const callFetch = (f: any, url: string, init: any) => {
  const impl = f || globalThis.fetch;
  return (impl as Function).call(globalThis, url, init);
};
export class XaiClient implements GenerationProvider {
  readonly name = 'xai';
  // tryConsumeAttempt: chamado ANTES de cada HTTP real (incluindo o retry
  // interno). Deve ser atomico e diario: true = tentativa admitida (contou no
  // orcamento), false = negar sem chamar a rede. Opcional para nao quebrar
  // chamadores fora do pipeline (testes, gemini-health).
  // reportAttemptOutcome: chamado UMA vez por tentativa ADMITIDA (HTTP real
  // enviado), com seu desfecho — nunca para tentativas negadas pre-rede.
  constructor(private apiKey: string, private model: string, private fetcher: any = null, private tryConsumeAttempt: (() => Promise<boolean>) | null = null, private reportAttemptOutcome: ((outcome: 'success' | 'failed') => Promise<void>) | null = null) {
    if (!apiKey) throw new Error('XAI_API_KEY is required');
    if (!model) throw new Error('MOVIE_GENERATION_MODEL is required');
  }
  // Orçamento por tentativa (chamado pelo pipeline antes de cada HTTP real,
  // incluindo o retry interno). Sem ele, cada instancia admite no maximo o
  // proprio retry isolado.
  setAttemptBudget(fn: () => Promise<boolean>): void { this.tryConsumeAttempt = fn; }
  // Desfecho por tentativa admitida (para metricas fieis: success+failed ==
  // attempts). Best-effort: nunca falha a operacao.
  setAttemptReporter(fn: (outcome: 'success' | 'failed') => Promise<void>): void { this.reportAttemptOutcome = fn; }
  async generateJson({ system, prompt, schema, temperature = 0.2 }: GenerationRequest): Promise<GenerationResult> {
    let last: any;
    for (let attempt = 0; attempt < 2; attempt++) {
      // Gate por tentativa: o retry interno tambem consome vaga do teto.
      // Nega sem rede; o adiamento conserva attempts do job (retomavel).
      if (this.tryConsumeAttempt && !(await this.tryConsumeAttempt())) {
        const denied: any = new XaiError(`pilot limit reached; xAI attempt ${attempt + 1} denied before network`, 429, 43200);
        (denied as any).deferred = true;
        throw denied;
      }
      let outcome: 'success' | 'failed' = 'failed';
      try {
        let res: Response;
        try {
          res = await callFetch(this.fetcher, `${API}/chat/completions`, {
            signal: AbortSignal.timeout(60_000),
            method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.apiKey}` },
            body: JSON.stringify({
              model: this.model,
              messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }],
              temperature,
              ...(/^grok-4[.-]3(?:-latest)?$/.test(this.model) ? { reasoning_effort: 'none' } : {}),
              response_format: { type: 'json_schema', json_schema: { name: 'movie_enrichment', strict: true, schema } }
            })
          });
        } catch (net: any) {
          throw new XaiError(`xAI fetch failed: ${net?.message || net}`);
        }
        if (!res.ok) {
          // Preserve HTTP classification even if the error body cannot be read.
          const body = await res.text().then((s) => s.slice(0, 500)).catch(() => 'unreadable response body');
          throw new XaiError(`xAI ${res.status}: ${body}`, res.status, Number(res.headers.get('Retry-After') || 0));
        }
        let data: any;
        try { data = await res.json(); }
        catch (e) {
          if (e instanceof SyntaxError) throw invalidOutput('invalid or truncated response JSON');
          throw new XaiError(`xAI fetch failed while reading response: ${(e as any)?.message || e}`);
        }
        const text = data?.choices?.[0]?.message?.content;
        if (typeof text !== 'string' || !text.trim()) throw invalidOutput('missing string message content');
        if (data?.choices?.[0]?.finish_reason === 'length') throw invalidOutput('truncated completion');
        let parsed: any;
        try { parsed = JSON.parse(text); }
        catch { throw invalidOutput('invalid message JSON'); }
        const v = validateEnrichment(parsed);
        if (!v.ok) throw invalidOutput(v.error || 'schema validation failed');
        outcome = 'success';
        return { data: parsed, model: this.model, provider: 'xai', usage: { inputTokens: data?.usage?.prompt_tokens, outputTokens: data?.usage?.completion_tokens } };
      } catch (e: any) {
        last = e;
        if (e instanceof XaiError && [429, 500, 502, 503, 504, 408].includes(e.status as number)) {
          if (attempt === 0) { continue; }
        }
        throw e;
      } finally {
        // Exactly one outcome per admitted attempt, including all read/parse failures.
        try { if (this.reportAttemptOutcome) await this.reportAttemptOutcome(outcome); } catch { /* best-effort */ }
        if (attempt === 0 && last instanceof XaiError && [429, 500, 502, 503, 504, 408].includes(last.status as number)) {
          await new Promise((r) => setTimeout(r, 500));
        }
      }
    }
    throw last;
  }
}
