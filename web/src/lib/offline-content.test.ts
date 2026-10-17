import { describe, expect, it } from 'vitest';
import { originalImageUrl, proxiedHtml, withStoredImages } from './offline-content.ts';

const b64 = (url: string) => Buffer.from(url).toString('base64url');

describe('originalImageUrl', () => {
  it('decodes proxied paths, relative or absolute, and leaves other URLs', () => {
    const url = 'https://img.example/ünï.png?x=1';
    expect(originalImageUrl(`/api/v1/images/sig/${b64(url)}`)).toBe(url);
    expect(originalImageUrl(`https://reader.example/api/v1/images/sig/${b64(url)}`)).toBe(url);
    expect(originalImageUrl('https://img.example/a.png')).toBe('https://img.example/a.png');
  });
});

describe('withStoredImages', () => {
  const stored = new Map([
    ['https://img.example/a.png', 'blob:a'],
    ['https://img.example/poster.jpg', 'blob:p'],
  ]);

  it('points stored images at their blobs and drops their alternatives', () => {
    const html =
      '<picture><source srcset="https://img.example/a.webp"><img src="https://img.example/a.png" srcset="https://img.example/a2.png 2x" sizes="50vw"></picture>' +
      '<img src="https://img.example/other.png"><video poster="https://img.example/poster.jpg"></video>';
    const out = withStoredImages(html, stored);
    expect(out).toContain('<img src="blob:a">');
    expect(out).not.toContain('a.webp');
    expect(out).toContain('src="https://img.example/other.png"');
    expect(out).toContain('poster="blob:p"');
  });

  it('matches proxied sources by the image behind them', () => {
    const html = `<img src="/api/v1/images/sig/${b64('https://img.example/a.png')}">`;
    expect(withStoredImages(html, stored)).toBe('<img src="blob:a">');
  });

  it('leaves HTML without stored images untouched', () => {
    expect(withStoredImages('<p>x</p>', new Map())).toBe('<p>x</p>');
    expect(withStoredImages('<img src="https://n.example/x.png">', stored)).toBe(
      '<img src="https://n.example/x.png">',
    );
  });
});

describe('proxiedHtml', () => {
  it('serves images at their proxy paths and drops the ones without', () => {
    const proxies = new Map([['https://img.example/a.png', '/api/v1/images/s/a']]);
    const out = proxiedHtml(
      '<img src="https://img.example/a.png" srcset="https://img.example/a2.png 2x"><img src="https://track.example/b.png"><picture><source srcset="https://x/y.webp"></picture>',
      proxies,
    );
    expect(out).toBe('<img src="/api/v1/images/s/a"><img><picture></picture>');
  });
});
