import { describe, expect, it } from 'vitest';
import type { Db } from '../../db/client.ts';
import { FakeFetcher } from '../../test/fake-fetcher.ts';
import { MemoryBlobStore, silentLogger } from '../../test/fakes.ts';
import { deriveKey, verify } from '../crypto.ts';
import { HostLimiter } from './host-limiter.ts';
import { ImageProxy } from './images.ts';

const key = deriveKey('a test secret that is at least thirty-two characters', 'image-url');
// Paths and rewriting never touch the database.
const proxy = new ImageProxy({
  db: {} as Db,
  fetcher: new FakeFetcher(),
  blobs: new MemoryBlobStore(),
  hosts: new HostLimiter(2),
  key,
  logger: silentLogger,
});

function decode(path: string): string {
  const [signature = '', encoded = ''] = path.replace('/api/v1/images/', '').split('/');
  const url = Buffer.from(encoded, 'base64url').toString();
  expect(verify(key, url, signature)).toBe(true);
  return url;
}

describe('ImageProxy', () => {
  it('signs proxy paths for http(s) URLs only', () => {
    expect(decode(proxy.path('https://img.example/a.png?x=1'))).toBe(
      'https://img.example/a.png?x=1',
    );
    expect(proxy.path('data:image/gif;base64,R0lGOD')).toBe('data:image/gif;base64,R0lGOD');
    expect(proxy.path('/relative.png')).toBe('/relative.png');
  });

  it('rewrites image sources and leaves everything else alone', () => {
    const html = [
      '<p>Hi <a href="https://site.example/" target="_blank" rel="noopener noreferrer nofollow">there</a> &amp; more</p>',
      '<img src="https://img.example/a.png" srcset="https://img.example/a.png 1x, https://img.example/a2.png 2x" alt="A">',
      '<picture><source srcset="https://img.example/b.webp" type="image/webp"><img src="https://img.example/b.png"></picture>',
      '<video poster="https://img.example/poster.jpg" controls><source src="https://media.example/v.mp4"></video>',
      '<img src="data:image/gif;base64,R0lGOD">',
    ].join('');
    const out = proxy.rewrite(html);
    expect(out).toContain('<a href="https://site.example/"');
    expect(out).toContain('&amp; more');
    expect(out).toContain('alt="A"');
    expect(out).toContain('src="https://media.example/v.mp4"');
    expect(out).toContain('src="data:image/gif;base64,R0lGOD"');
    expect(out).not.toMatch(/(src|srcset|poster)="https:\/\/img\.example/);
    const paths = [...out.matchAll(/\/api\/v1\/images\/[^\s"]+/g)].map((m) => decode(m[0]));
    expect(paths).toEqual([
      'https://img.example/a.png',
      'https://img.example/a.png',
      'https://img.example/a2.png',
      'https://img.example/b.webp',
      'https://img.example/b.png',
      'https://img.example/poster.jpg',
    ]);
    expect(out).toContain(' 2x');
  });
});
