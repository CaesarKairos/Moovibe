import type { GenerationProvider, GenerationRequest, GenerationResult } from './generation-provider';
import { validateEnrichment } from './generation-provider';
const API = 'https://api.x.ai/v1';
export class XaiError extends Error {
  status: number | null; retryAfter: number;
  constructor(message: string, status: number | null = null, retryAfter = 0) {
    super(message); this.name = 'XaiError'; this.status = status; this.retryAfter = retryAfter;
  }
}
const callFetch = (f: any, url: string, init: any) => {
  const impl = f || globalThis.fetch;
  return (impl as Function).call(globalThis, url, init);
};
export class XaiClient implements GenerationProvider {
  readonly name = 'xai';
  constructor(private apiKey: string, private model: string, private fetcher: any = null) {
    if (!apiKey) throw new Error('XAI_API_KEY is required');
    if (!model) throw new Error('MOVIE_GENERATION_MODEL is required');
  }
  async generateJson({ system, prompt, schema, temperature = 0.2 }: GenerationRequest): Promise<GenerationResult> {
    let last: any;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res: Response = await callFetch(this.fetcher, `${API}/chat/completions`, {
          method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.apiKey}` },
          body: JSON.stringify({
            model: this.model,
            messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }],
            temperature,
            response_format: { type: 'json_schema', json_schema: { name: 'movie_enrichment', strict: true, schema } }
          })
        });
        if (!res.ok) {
          const body = (await res.text()).slice(0, 500);
          throw new XaiError(`xAI ${res.status}: ${body}`, res.status, Number(res.headers.get('Retry-After') || 0));
        }
        const data: any = await res.json();
        const text = data?.choices?.[0]?.message?.content || '';
        if (!text.trim()) throw new XaiError(`xAI empty response from ${this.model}`, null, 0);
        const parsed = JSON.parse(text);
        const v = validateEnrichment(parsed);
        if (!v.ok) { const e: any = new XaiError(`xAI invalid output: ${v.error}`, null, 0); e.invalidOutput = true; throw e; }
        return { data: parsed, model: this.model, provider: 'xai', usage: { inputTokens: data?.usage?.prompt_tokens, outputTokens: data?.usage?.completion_tokens } };
      } catch (e: any) {
        last = e;
        if (e instanceof XaiError && [429, 500, 502, 503, 504, 408].includes(e.status as number)) {
          if (attempt === 0) { await new Promise((r) => setTimeout(r, 500)); continue; }
        }
        throw e;
      }
    }
    throw last;
  }
}
