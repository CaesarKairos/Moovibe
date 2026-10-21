import { GeminiClient } from '../../../functions/_lib/gemini.js';
import type { GenerationProvider, GenerationRequest, GenerationResult } from './generation-provider';
import { XaiClient } from './xai-client';
export class GeminiGenerationProvider implements GenerationProvider {
  readonly name = 'gemini';
  private client: GeminiClient;
  constructor(apiKey: string) { this.client = new GeminiClient(apiKey, null, { maxAttempts: 1 }); }
  async generateJson(input: GenerationRequest): Promise<GenerationResult> {
    const r = await this.client.generateJson(input);
    return { data: r.data, model: r.model, provider: 'gemini' };
  }
}
export type MovieGenEnv = { MOVIE_GENERATION_PROVIDER?: string; MOVIE_GENERATION_MODEL?: string; XAI_API_KEY?: string; GEMINI_API_KEY?: string; MOVIE_GENERATION_ENABLED?: string };
export const DEFAULT_XAI_MODEL = 'grok-4.3';
export function isMovieGenerationEnabled(env: MovieGenEnv): boolean {
  return String((env as any).MOVIE_GENERATION_ENABLED || 'false').toLowerCase() === 'true';
}
export function createMovieGenerationProvider(env: MovieGenEnv): GenerationProvider {
  const which = String(env.MOVIE_GENERATION_PROVIDER || 'xai').toLowerCase();
  if (which === 'gemini') return new GeminiGenerationProvider(env.GEMINI_API_KEY || '');
  return new XaiClient(env.XAI_API_KEY || '', env.MOVIE_GENERATION_MODEL || DEFAULT_XAI_MODEL);
}
