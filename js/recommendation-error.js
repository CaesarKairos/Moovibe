const messages = {
    D1_QUOTA_EXCEEDED: ['quotaTitle', 'quota'],
    GEMINI_UNAVAILABLE: ['quotaTitle', 'ai'],
    EMBEDDING_FAILED: ['analysisTitle', 'analysis'],
    VECTOR_QUERY_FAILED: ['queryTitle', 'query'],
    CATALOG_TOO_SMALL: ['catalogTitle', 'catalog'],
    D1_SCHEMA_MISMATCH: ['internalTitle', 'database'],
    D1_READ_FAILED: ['internalTitle', 'database'],
    NETWORK_ERROR: ['networkTitle', 'network'],
    TIMEOUT: ['timeoutTitle', 'timeout'],
    INVALID_RESPONSE: ['invalidTitle', 'invalid'],
    FRONTEND_ERROR: ['internalTitle', 'frontend'],
    SHARED_RESULT_ERROR: ['unknownTitle', 'shared'],
};

// Only bounded identifiers cross into the UI and clipboard.
const identifier = value => typeof value === 'string' && /^[a-z0-9_.:-]{1,100}$/i.test(value) ? value : null;
export function describeError(error, now = new Date()) {
    const code = identifier(error?.code) || (error?.name === 'TimeoutError' ? 'TIMEOUT' : null);
    const [title, description] = Object.hasOwn(messages, code) ? messages[code] : ['unknownTitle', 'unknown'];
    const retryAt = code === 'D1_QUOTA_EXCEEDED'
        ? Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1) : null;
    return {
        code, title, description, retryAt, time: now.toISOString(),
        status: Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599 ? error.status : null,
        stage: identifier(error?.stage),
        provider: identifier(error?.provider),
        requestId: identifier(error?.requestId),
        retryable: typeof error?.retryable === 'boolean' ? error.retryable : null,
    };
}

export async function fetchRecommendation(body, fetcher = fetch) {
    let response;
    try {
        response = await fetcher('/recommend', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(120_000),
        });
    } catch (error) {
        throw { code: error?.name === 'TimeoutError' ? 'TIMEOUT' : 'NETWORK_ERROR' };
    }
    let data;
    try {
        data = await response.json();
    } catch (error) {
        throw { code: error?.name === 'TimeoutError' ? 'TIMEOUT' : 'INVALID_RESPONSE', status: response.status };
    }
    const metadata = {
        code: data?.error?.code, status: response.status, stage: data?.error?.stage,
        provider: data?.error?.provider, requestId: data?.request_id, retryable: data?.error?.retryable,
    };
    return { response, data, metadata };
}
