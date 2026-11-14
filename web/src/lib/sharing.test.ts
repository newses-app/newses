import { describe, expect, it } from 'vitest';
import { publishedFeedUrl, shareUrl } from './sharing.ts';

describe('sharing URLs', () => {
  it("are on the server's origin", () => {
    expect(shareUrl('abc')).toBe(`${location.origin}/public/share/abc`);
    expect(publishedFeedUrl('a b/c')).toBe(`${location.origin}/public/feeds/a%20b%2Fc`);
  });
});
