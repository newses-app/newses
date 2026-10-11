import { describe, expect, it } from 'vitest';
import { mapSrcset } from './srcset.ts';

const upper = (url: string) => url.toUpperCase();

describe('mapSrcset', () => {
  it('maps each candidate URL and keeps its descriptors', () => {
    expect(mapSrcset('a.png 1x, b.png 2x', upper)).toBe('A.PNG 1x, B.PNG 2x');
  });

  it('keeps commas inside URLs', () => {
    expect(mapSrcset('https://cdn.example/w_1,c_2/a.png 100w, b.png 200w', upper)).toBe(
      'HTTPS://CDN.EXAMPLE/W_1,C_2/A.PNG 100w, B.PNG 200w',
    );
  });

  it('ends a candidate at a trailing comma or a comma after descriptors', () => {
    expect(mapSrcset('a.png, b.png 2x,c.png 3x', upper)).toBe('A.PNG, B.PNG 2x, C.PNG 3x');
  });

  it('ignores empty candidates and surrounding whitespace', () => {
    expect(mapSrcset('  a.png 1x ,, , ', upper)).toBe('A.PNG 1x');
    expect(mapSrcset('', upper)).toBe('');
  });

  it('rejoins unencoded spaces in URLs as %20', () => {
    expect(mapSrcset('https://x.example/el-ni%C3%B1o alters life/a.jpg?w=300 300w', upper)).toBe(
      'HTTPS://X.EXAMPLE/EL-NI%C3%B1O%20ALTERS%20LIFE/A.JPG?W=300 300w',
    );
    expect(mapSrcset('a b.png', upper)).toBe('A%20B.PNG');
    expect(mapSrcset('a b.png 1x, c.png 2x', upper)).toBe('A%20B.PNG 1x, C.PNG 2x');
    expect(mapSrcset('a.png 100w 1.5x', upper)).toBe('A.PNG 100w 1.5x');
  });
});
