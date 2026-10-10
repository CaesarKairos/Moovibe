import {describe,expect,it} from 'vitest';
import {formatLyricsPreview} from '../functions/_lib/lyrics-preview.js';

describe('lyrics preview formatting',()=>{
  it('preserves lines and stanza breaks',()=>expect(formatLyricsPreview('linha 1\nlinha 2\n\nlinha 3')).toBe('linha 1\nlinha 2\n\nlinha 3'));
  it('normalizes CRLF, trims line endings and collapses excessive blank lines',()=>expect(formatLyricsPreview('linha 1  \r\nlinha 2\r\n\r\n\r\n\r\nlinha 3\t')).toBe('linha 1\nlinha 2\n\nlinha 3'));
  it('truncates near a line boundary without flattening the preview',()=>{const value=formatLyricsPreview('primeira linha inteira\nsegunda linha inteira\nterceira linha muito extensa para caber',48);expect(value.length).toBeLessThanOrEqual(48);expect(value).toContain('\n');expect(value.endsWith('…')).toBe(true);});
});
