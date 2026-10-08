import {describe,expect,it} from 'vitest';
import {classifyRecommendationError} from '../functions/recommend.js';

describe('recommendation failure diagnostics',()=>{
  it('classifies missing migration columns as a schema mismatch',()=>expect(classifyRecommendationError(new Error('D1_ERROR: no such column: m.genres_json'))).toMatchObject({code:'D1_SCHEMA_MISMATCH',stage:'catalog_read'}));
  it('distinguishes D1 quota failures from ordinary reads',()=>{expect(classifyRecommendationError(new Error('D1_ERROR: rows read quota exceeded')).code).toBe('D1_QUOTA_EXCEEDED');expect(classifyRecommendationError(new Error('D1 database unavailable')).code).toBe('D1_READ_FAILED');});
});
