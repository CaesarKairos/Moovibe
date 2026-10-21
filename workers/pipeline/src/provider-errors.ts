export type ProviderErrorCode =
  | 'RATE_LIMITED' | 'QUOTA_EXHAUSTED' | 'INVALID_CREDENTIAL'
  | 'INSUFFICIENT_CREDITS' | 'PROVIDER_UNAVAILABLE' | 'TIMEOUT'
  | 'INVALID_GENERATION_OUTPUT' | 'INVALID_REQUEST' | 'D1_READ_LIMIT' | 'D1_WRITE_LIMIT'
  | 'QUEUE_LIMIT' | 'VECTORIZE_ERROR' | 'WORKER_SUBREQUEST_LIMIT' | 'UNKNOWN';
export interface ClassifiedError {
  code: ProviderErrorCode; httpStatus: number | null;
  retryable: boolean; retryAfterSeconds: number; message: string;
}
const safe = (v: unknown) => String((v as any)?.message ?? v ?? '').slice(0, 500);
export function classifyProviderError(error: unknown): ClassifiedError {
  const message = safe(error);
  const lower = message.toLowerCase();
  const http = Number(lower.match(/(?:http|transient|gemini|xai|groq|tmdb)\s+(400|401|402|403|404|408|409|422|429|500|502|503|504)/)?.[1]
    || (error as any)?.status || (error as any)?.httpStatus || null);
  const retryAfter = Number((error as any)?.retryAfter || 0) || 0;
  if (/row.*read limit|d1_read/i.test(message))
    return { code: 'D1_READ_LIMIT', httpStatus: http, retryable: true, retryAfterSeconds: 3600, message };
  if (/row.*write limit|d1_write/i.test(message))
    return { code: 'D1_WRITE_LIMIT', httpStatus: http, retryable: true, retryAfterSeconds: 3600, message };
  if (/too many subrequests/i.test(message))
    return { code: 'WORKER_SUBREQUEST_LIMIT', httpStatus: http, retryable: true, retryAfterSeconds: 300, message };
  if (http === 401 || http === 403 || /api key not valid|invalid_api_key|invalid[_ ]credential|incorrect api key/i.test(message))
    return { code: 'INVALID_CREDENTIAL', httpStatus: http, retryable: false, retryAfterSeconds: 0, message };
  if (/insufficient.*credit|out of credit|payment required/i.test(message) || http === 402)
    return { code: 'INSUFFICIENT_CREDITS', httpStatus: http, retryable: false, retryAfterSeconds: 0, message };
  if (http === 429) {
    if ((error as any)?.provider === 'groq')
      return { code: (error as any).quotaExhausted ? 'QUOTA_EXHAUSTED' : 'RATE_LIMITED', httpStatus: http, retryable: true, retryAfterSeconds: Math.max(60, retryAfter), message };
    if (/quota|resource_exhausted|insufficient_quota/i.test(message))
      return { code: 'QUOTA_EXHAUSTED', httpStatus: 429, retryable: true, retryAfterSeconds: Math.min(43200, Math.max(300, retryAfter)), message };
    return { code: 'RATE_LIMITED', httpStatus: 429, retryable: true, retryAfterSeconds: Math.min(3600, Math.max(5, retryAfter)), message };
  }
  if (/invalid.*(json|schema|output)|empty response|validation failed/i.test(message))
    return { code: 'INVALID_GENERATION_OUTPUT', httpStatus: http, retryable: false, retryAfterSeconds: 0, message };
  if (((error as any)?.provider === 'groq' && [400, 404, 422].includes(http)) || /INVALID_REQUEST/.test(message))
    return { code: 'INVALID_REQUEST', httpStatus: http, retryable: false, retryAfterSeconds: 0, message };
  if ([408, 500, 502, 503, 504].includes(http as number) || /timeout|fetch failed|temporar|overloaded/i.test(message))
    return { code: 'PROVIDER_UNAVAILABLE', httpStatus: http, retryable: true, retryAfterSeconds: (error as any)?.provider === 'groq' ? Math.max(120, retryAfter) : 120, message };
  if (/vectorize/i.test(message))
    return { code: 'VECTORIZE_ERROR', httpStatus: http, retryable: true, retryAfterSeconds: 120, message };
  return { code: 'UNKNOWN', httpStatus: http, retryable: false, retryAfterSeconds: 0, message };
}
