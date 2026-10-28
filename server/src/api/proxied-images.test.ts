import type { Enclosure } from '@newses/shared';
import { describe, expect, it } from 'vitest';
import type { ImageProxy } from '../core/feeds/images.ts';
import type { PrefsService } from '../core/prefs.ts';
import { proxiedImages } from './proxied-images.ts';

const images = {
  rewrite: (html: string) => html.replaceAll('https://', '/proxy/'),
  path: (url: string) => `/proxy/${url}`,
} as unknown as ImageProxy;
const prefs = (proxyImages: boolean) =>
  ({ get: () => Promise.resolve({ proxyImages }) }) as unknown as PrefsService;
const enclosure = (url: string, mimeType: string | null): Enclosure => ({
  url,
  mimeType,
  length: null,
  width: null,
  height: null,
  durationSeconds: null,
});
const entry = {
  content: '<img src="https://a.example/1.png">',
  enclosures: [
    enclosure('https://a.example/photo.jpg', 'image/jpeg'),
    enclosure('https://a.example/show.mp3', 'audio/mpeg'),
  ],
};

describe('proxiedImages', () => {
  it('gives image enclosures their proxy path for users who proxy images', async () => {
    const [proxied] = await proxiedImages(prefs(true), images)(1, [entry]);
    expect(proxied?.content).toBe('<img src="/proxy/a.example/1.png">');
    expect(proxied?.enclosures).toEqual([
      { ...entry.enclosures[0], proxy: '/proxy/https://a.example/photo.jpg' },
      entry.enclosures[1],
    ]);
  });

  it('proxies enclosures of entries without content', async () => {
    const [proxied] = await proxiedImages(prefs(true), images)(1, [
      { enclosures: entry.enclosures },
    ]);
    expect(proxied?.enclosures[0]?.proxy).toBe('/proxy/https://a.example/photo.jpg');
  });

  it('leaves entries as they are for other users', async () => {
    expect(await proxiedImages(prefs(false), images)(1, [entry])).toEqual([entry]);
  });
});
