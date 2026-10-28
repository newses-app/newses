import { describe, expect, it } from 'vitest';
import { withLazyImages } from './article-html.ts';

describe('withLazyImages', () => {
  it('loads and decodes every image lazily, stored copies included', () => {
    const html = withLazyImages(
      '<p><img src="https://img.example/a.png" alt="a"></p><picture><img src="blob:b"></picture>',
    );
    const images = new DOMParser().parseFromString(html, 'text/html').querySelectorAll('img');
    expect(images).toHaveLength(2);
    for (const img of images) {
      expect(img.getAttribute('loading')).toBe('lazy');
      expect(img.getAttribute('decoding')).toBe('async');
    }
    expect(images[0]?.getAttribute('alt')).toBe('a');
    expect(images[1]?.getAttribute('src')).toBe('blob:b');
  });

  it('leaves HTML without images untouched', () => {
    const html = '<p>Text &amp; <a href="https://example.com">link</a></p>';
    expect(withLazyImages(html)).toBe(html);
  });
});
