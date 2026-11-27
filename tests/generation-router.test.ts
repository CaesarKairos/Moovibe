import { afterEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import { createRecommendationGenerator } from '../functions/_lib/generation-router.js';
import { handleRecommendationGeneration } from '../workers/pipeline/src/recommendation-generation';

const profile = {
  moods: ['reflective'], themes: ['memory'], atmosphere: ['warm'], pace: 'slow',
  emotional_valence: 0.4, energy: 0.3, intimacy: 0.8, surrealism: 0.2, darkness: 0.4,
  humor: 0.1, romanticism: 0.5, narrative_density: 0.6, melancholy_level: 0.7, tension_level: 0.3
};

class Statement {
  values: unknown[] = [];
  constructor(private db: Database.Database, private sql: string) {}
  bind(...values: unknown[]) { this.values = values; return this; }
  async run() {
    const result = this.db.prepare(this.sql).run(...this.values);
    return { meta: { changes: result.changes } };
  }
  async first<T>() { return this.db.prepare(this.sql).get(...this.values) as T | undefined; }
}

function makeDb() {
  const sqlite = new Database(':memory:');
  for (const file of fs.readdirSync('migrations').filter(name => name.endsWith('.sql')).sort())
    sqlite.exec(fs.readFileSync(`migrations/${file}`, 'utf8'));
  const db = {
    prepare: (sql: string) => new Statement(sqlite, sql),
    batch: async (statements: Statement[]) => Promise.all(statements.map(statement => statement.run()))
  } as unknown as D1Database;
  return { db, sqlite };
}

afterEach(() => vi.restoreAllMocks());

describe('recommendation provider failover', () => {
  it('uses the authenticated pipeline relay when Pages has no Groq secret', async () => {
    const { db, sqlite } = makeDb();
    const requests: string[] = [];
    const workerEnv = {
      ADMIN_TOKEN: 'shared-test-token',
      XAI_API_KEY: 'test-groq-key',
      MOVIE_GENERATION_MODEL: 'openai/gpt-oss-120b',
      MOVIE_GENERATION_ENABLED: 'true',
      GROQ_SAFETY_MARGIN: '0',
      MOOVIBE_LIBRARY: db
    };
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      requests.push(url);
      if (url.includes('generativelanguage.googleapis.com'))
        return new Response('temporarily unavailable', { status: 503 });
      if (url.includes('/internal/recommendation-generation'))
        return handleRecommendationGeneration(new Request(url, init), workerEnv);
      return new Response(JSON.stringify({
        usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 },
        choices: [{ message: { content: JSON.stringify(profile) }, finish_reason: 'stop' }]
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    try {
      const unauthorized = await handleRecommendationGeneration(new Request(
        'https://pipeline.example/internal/recommendation-generation',
        { method: 'POST', body: '{}' }
      ), workerEnv);
      expect(unauthorized.status).toBe(401);

      const generator = createRecommendationGenerator({
        MOOVIBE_LIBRARY: db,
        GEMINI_API_KEY: 'test-gemini-key',
        PIPELINE_WORKER_URL: 'https://pipeline.example',
        PIPELINE_ADMIN_TOKEN: 'shared-test-token'
      } as any, { requestId: 'relay-test-request' });
      const result = await generator.generateJson({
        stage: 'song_profile',
        system: 'Return a profile.',
        prompt: 'A song.',
        schema: { type: 'object', properties: { moods: { type: 'array', items: { type: 'string' } } }, required: ['moods'] },
        validate: (data: any) => data?.moods?.length ? { ok: true } : { ok: false, error: 'missing moods' }
      });

      expect(result).toMatchObject({ provider: 'groq', model: 'openai/gpt-oss-120b', data: profile });
      expect(requests).toContain('https://pipeline.example/internal/recommendation-generation');
      expect(sqlite.prepare('SELECT attempts,total_tokens FROM groq_capacity').get()).toEqual({ attempts: 1, total_tokens: 110 });
    } finally {
      globalThis.fetch = originalFetch;
      sqlite.close();
    }
  });

  it('uses Groq after Gemini model failures and records the selected provider/model', async () => {
    const { db, sqlite } = makeDb();
    const requests: { url: string; body: any }[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      requests.push({ url, body });
      if (url.includes('generativelanguage.googleapis.com'))
        return new Response('temporarily unavailable', { status: 503 });
      return new Response(JSON.stringify({
        usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 },
        choices: [{ message: { content: JSON.stringify(profile) }, finish_reason: 'stop' }]
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    const logs: string[] = [];
    const log = vi.spyOn(console, 'log').mockImplementation(value => { logs.push(String(value)); });
    try {
      const generator = createRecommendationGenerator({
        MOOVIBE_LIBRARY: db, GEMINI_API_KEY: 'test-gemini-key', XAI_API_KEY: 'test-groq-key',
        GROQ_SAFETY_MARGIN: '0'
      } as any, { requestId: 'test-request-id' });
      const result = await generator.generateJson({
        stage: 'song_profile', system: 'Return a profile.', prompt: 'A song.',
        schema: { type: 'object', properties: { moods: { type: 'array', items: { type: 'string' } } }, required: ['moods'] },
        validate: (data: any) => data?.moods?.length ? { ok: true } : { ok: false, error: 'missing moods' }
      });

      expect(result).toMatchObject({ provider: 'groq', model: 'openai/gpt-oss-120b', attempts: 3, data: profile });
      expect(requests.filter(request => request.url.includes('generativelanguage.googleapis.com')).map(request => request.url)).toEqual([
        expect.stringContaining('gemini-2.5-flash-lite'),
        expect.stringContaining('gemini-2.5-flash')
      ]);
      const groqRequest = requests.find(request => request.url.includes('api.groq.com'));
      expect(groqRequest?.body.model).toBe('openai/gpt-oss-120b');
      expect(groqRequest?.body.response_format.json_schema.schema).toMatchObject({
        additionalProperties: false,
        required: ['moods']
      });
      expect(sqlite.prepare("SELECT value FROM system_state WHERE key='circuit:generation-gemini'").get()).toBeTruthy();
      expect(sqlite.prepare('SELECT attempts,total_tokens FROM groq_capacity').get()).toEqual({ attempts: 1, total_tokens: 110 });
      expect(logs.join('\n')).toContain('"request_id":"test-request-id"');
      expect(logs.join('\n')).toContain('"provider":"groq"');
    } finally {
      globalThis.fetch = originalFetch;
      sqlite.close();
    }
  });
});
