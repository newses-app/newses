import { describe, expect, it } from 'vitest';
import { MAX_TAG_LENGTH, MAX_TAGS_PER_ENTRY, normaliseTag, normaliseTags } from './limits.ts';

describe('tags', () => {
  it('normalises case, whitespace, commas, and control characters', () => {
    expect(normaliseTag('  Open   Source\n')).toBe('open source');
    expect(normaliseTag('a,b')).toBe('a b');
    expect(normaliseTag('x\u0000y')).toBe('x y');
    expect(normaliseTag(' , ')).toBeNull();
    expect(normaliseTag('x'.repeat(100))).toHaveLength(MAX_TAG_LENGTH);
  });

  it('dedupes in order and caps the count', () => {
    expect(normaliseTags(['Go', 'go', ' ', 'Rust'])).toEqual(['go', 'rust']);
    expect(normaliseTags(Array.from({ length: 80 }, (_, i) => `t${String(i)}`))).toHaveLength(
      MAX_TAGS_PER_ENTRY,
    );
  });
});
