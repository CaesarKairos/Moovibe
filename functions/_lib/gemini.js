const API = 'https://generativelanguage.googleapis.com/v1beta';
const BOOTSTRAP_MODELS = ['gemini-2.5-flash-lite', 'gemini-2.5-flash', 'gemini-2.0-flash-lite'];
const TRANSIENT = new Set([408, 429, 500, 502, 503, 504]);

export class RetryableError extends Error {
  constructor(message, retryAfter = 0) { super(message); this.name = 'RetryableError'; this.retryAfter = retryAfter; }
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const cleanName = name => String(name || '').replace(/^models\//, '');

// Cloudflare Workers throws "Illegal invocation: function called with incorrect
// `this` reference" when the built-in fetch runs with a receiver other than the
// global object. `this.fetcher(...)` would pass the GeminiClient instance as
// `this`, so every request is routed through this helper, which pins the
// receiver to globalThis while still honoring an injected fetcher (tests).
const invokeFetch = (fetcher, url, init) => {
  const impl = fetcher || globalThis.fetch;
  if (typeof impl !== 'function') throw new Error('No fetch implementation available');
  return impl.call(globalThis, url, init);
};

export class GeminiClient {
  constructor(apiKey, fetcher = null, {maxAttempts=3} = {}) {
    if (!apiKey) throw new Error('GEMINI_API_KEY is required');
    if (fetcher != null && typeof fetcher !== 'function') throw new TypeError('fetcher must be a function');
    this.apiKey = apiKey;
    this.fetcher = fetcher;
    this.maxAttempts = Math.max(1, Math.min(3, Number(maxAttempts) || 3));
    this.maxModels = this.maxAttempts === 1 ? 1 : 4;
    this.cachedModels = null;
  }

  async request(path, init = {}, maxAttempts = 3) {
    maxAttempts = Math.min(maxAttempts, this.maxAttempts);
    let last;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        const response = await invokeFetch(this.fetcher, `${API}${path}${path.includes('?') ? '&' : '?'}key=${encodeURIComponent(this.apiKey)}`, init);
        if (response.ok) return response.json();
        const body = (await response.text()).slice(0, 500);
        if (!TRANSIENT.has(response.status)) throw new Error(`Gemini ${response.status}: ${body}`);
        const retryAfter = Number(response.headers.get('Retry-After') || 0);
        last = new RetryableError(`Gemini transient ${response.status}: ${body}`, retryAfter);
        // Queue consumers must yield long server-requested delays back to the Queue;
        // never hold a Worker invocation open for minutes or hours.
        if (retryAfter > 60) throw last;
        if (attempt + 1 < maxAttempts) await sleep((retryAfter ? retryAfter * 1000 : 250 * 2 ** attempt) + Math.random() * 200);
      } catch (error) {
        if (error instanceof RetryableError && error.retryAfter > 60) throw error;
        if (error instanceof Error && error.message.startsWith('Gemini 4') && !error.message.includes('429')) throw error;
        last = error;
        if (attempt + 1 < maxAttempts) await sleep(250 * 2 ** attempt + Math.random() * 200);
      }
    }
    throw new RetryableError(last?.message || 'Gemini temporarily unavailable');
  }

  async listGenerativeModels() {
    if (this.cachedModels) return this.cachedModels;
    const data = await this.request('/models', {}, 2);
    const eligible = (data.models || [])
      .filter(m => (m.supportedGenerationMethods || []).includes('generateContent'))
      .map(m => cleanName(m.name))
      .filter(n => /gemini/i.test(n) && /flash/i.test(n) && !/(preview|tts|live|image|embedding|vision)/i.test(n));
    const rank = name => {
      const i = BOOTSTRAP_MODELS.indexOf(name);
      return i < 0 ? 100 : i;
    };
    this.cachedModels = [...new Set([...eligible.sort((a,b) => rank(a)-rank(b)), ...BOOTSTRAP_MODELS])];
    return this.cachedModels;
  }

  async generateJson({ system, prompt, schema, temperature = 0.2 }) {
    const models = await this.listGenerativeModels().catch(() => BOOTSTRAP_MODELS);
    let last;
    for (const model of models.slice(0, this.maxModels)) {
      try {
        const data = await this.request(`/models/${model}:generateContent`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: system }] },
            contents: [{ role: 'user', parts: [{ text: prompt }] }],
            generationConfig: { temperature, responseMimeType: 'application/json', responseJsonSchema: schema }
          })
        });
        const text = data?.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '';
        if (!text) throw new RetryableError(`Empty response from ${model}`);
        return { data: JSON.parse(text), model };
      } catch (error) {
        last = error;
        if (!(error instanceof RetryableError) && !/404|not found|unsupported/i.test(error.message)) throw error;
      }
    }
    throw last || new RetryableError('No eligible Gemini model succeeded');
  }

  async embed(text, { model = 'gemini-embedding-2', dimensions = 768, taskType = 'RETRIEVAL_DOCUMENT' } = {}) {
    const data = await this.request(`/models/${model}:embedContent`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: `models/${model}`, content: { parts: [{ text }] }, taskType, outputDimensionality: dimensions })
    });
    const values = data?.embedding?.values;
    if (!Array.isArray(values) || values.length !== dimensions) throw new RetryableError(`Invalid ${model} embedding dimensions`);
    return values;
  }
}

