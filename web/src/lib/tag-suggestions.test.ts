import { describe, expect, it } from 'vitest';
import { suggestTags } from './tag-suggestions.ts';

const tags = ['ai', 'climate', 'go', 'golang', 'google', 'lego', 'mango', 'yoga'];

describe('suggestTags', () => {
  it('suggests nothing until something is typed', () => {
    expect(suggestTags(tags, '', [])).toEqual([]);
    expect(suggestTags(tags, '  ', [])).toEqual([]);
    expect(suggestTags(tags, null, [])).toEqual([]);
  });

  it('lists tags starting with the text first, then those containing it', () => {
    expect(suggestTags(tags, 'go', [])).toEqual(['go', 'golang', 'google', 'lego', 'mango']);
    expect(suggestTags(tags, ' GO ', [], 3)).toEqual(['go', 'golang', 'google']);
  });

  it('leaves out the tags already chosen', () => {
    expect(suggestTags(tags, 'go', ['go', 'lego'])).toEqual(['golang', 'google', 'mango']);
  });
});
