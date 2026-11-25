import { describe, expect, it } from 'vitest';
import { HOW_COPY } from '../js/i18n/how-it-works.js';
import { HOW_WEIGHTS } from '../js/how-it-works.js';
import { LANGUAGES, PRESENTATION_COPY, TOP_GLOBAL_COPY, ERROR_COPY, EXPORT_COPY } from '../js/i18n/locales.js';
import { SCORE_WEIGHTS } from '../functions/_lib/recommender.js';
import { rankingMovement } from '../js/top-global.js';

describe('public architecture and presentation copy', () => {
    it('matches the ranking weights in the backend', () => {
        expect(HOW_WEIGHTS).toEqual(Object.values(SCORE_WEIGHTS).map(weight => weight * 100));
    });

    it('includes complete copy for each supported language', () => {
        for (const map of [HOW_COPY, PRESENTATION_COPY, TOP_GLOBAL_COPY, ERROR_COPY, EXPORT_COPY]) {
            expect(Object.keys(map).sort()).toEqual(Object.keys(LANGUAGES).sort());
        }
        for (const language of Object.keys(HOW_COPY) as (keyof typeof HOW_COPY)[]) {
            const copy = HOW_COPY[language];
            expect(copy).toHaveLength(7);
            expect(copy[2]).toHaveLength(5);
            expect((copy[2] as string[][]).every(step => step.length === 4 && step.every(Boolean))).toBe(true);
            expect(PRESENTATION_COPY[language]).toHaveLength(9);
            expect(rankingMovement({movement:'NEW'},language)[0]).toBe(PRESENTATION_COPY[language][0]);
            expect(rankingMovement({movement:'RE'},language)[0]).toBe(PRESENTATION_COPY[language][1]);
        }
    });
});
