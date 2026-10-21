import { GroqClient } from './groq-client';

export type MovieGenEnv = {
  MOVIE_GENERATION_PROVIDER?: string;
  MOVIE_GENERATION_MODEL?: string;
  MOVIE_GENERATION_ENABLED?: string;
  // Legacy Cloudflare secret name: its value is the GroqCloud credential.
  XAI_API_KEY?: string;
};
export const DEFAULT_GROQ_MODEL = 'openai/gpt-oss-120b';
export const GENERATION_CIRCUIT = 'generation-groq';
export function isMovieGenerationEnabled(env: MovieGenEnv): boolean {
  return String(env.MOVIE_GENERATION_ENABLED || 'false').toLowerCase() === 'true';
}
export function createMovieGenerationProvider(env: MovieGenEnv): GroqClient {
  const which = String(env.MOVIE_GENERATION_PROVIDER || 'groq').toLowerCase();
  if (which !== 'groq') throw new Error(`INVALID_REQUEST unsupported movie generation provider: ${which}; use groq`);
  return new GroqClient(env.XAI_API_KEY || '', env.MOVIE_GENERATION_MODEL || DEFAULT_GROQ_MODEL);
}
