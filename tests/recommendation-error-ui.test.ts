import { describe, expect, it } from 'vitest';
import { ERROR_COPY, LANGUAGES } from '../js/i18n/locales.js';
import { describeError, fetchRecommendation } from '../js/recommendation-error.js';

describe('recommendation error presentation', () => {
    it('translates all diagnostic fields in every supported language', () => {
        expect(Object.keys(ERROR_COPY).sort()).toEqual(Object.keys(LANGUAGES).sort());
        for (const copy of Object.values(ERROR_COPY)) {
            expect(Object.keys(copy)).toEqual(Object.keys(ERROR_COPY.en));
            expect(Object.values(copy).every(Boolean)).toBe(true);
        }
    });

    it('explains free API limits on recommendation and AI failures', () => {
        expect(ERROR_COPY['pt-BR'].unknown).toContain('O Moovibe usa apenas APIs gratuitas');
        expect(ERROR_COPY['pt-BR'].ai).toContain('Gemini e Groq');
        expect(describeError({code:'TEXT_GENERATION_UNAVAILABLE'})).toMatchObject({
            title:'quotaTitle', description:'ai',
        });
        for (const copy of Object.values(ERROR_COPY)) {
            expect(copy.unknown).toContain('Gemini');
            expect(copy.ai).toContain('Groq');
        }
    });

    it('uses UTC quota reset and preserves only safe metadata', () => {
        expect(describeError({ code: 'D1_QUOTA_EXCEEDED', status: 503, requestId: 'abc-123',
            stage: 'catalog_read', provider: 'd1', message: 'private text' }, new Date('2026-11-25T23:30:00Z')))
            .toEqual({ code:'D1_QUOTA_EXCEEDED', status:503, requestId:'abc-123', stage:'catalog_read', provider:'d1',
                time:'2026-11-25T23:30:00.000Z', retryAt:Date.parse('2026-11-26T00:00:00Z'),
                title:'quotaTitle', description:'quota', retryable:null });
        expect(describeError({status:503}).title).toBe('unknownTitle');
    });

    it('separates timeout, connection failure and malformed responses', async () => {
        await expect(fetchRecommendation({}, async () => { throw new DOMException('', 'TimeoutError'); }))
            .rejects.toMatchObject({code:'TIMEOUT'});
        await expect(fetchRecommendation({}, async () => { throw new TypeError(); }))
            .rejects.toMatchObject({code:'NETWORK_ERROR'});
        await expect(fetchRecommendation({}, async () => new Response('<html>', {status:502})))
            .rejects.toMatchObject({code:'INVALID_RESPONSE', status:502});
    });
});
